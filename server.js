const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const JWT_SECRET = process.env.JWT_SECRET || 'gridlock_secret_key_change_this';
const MONGO_URI = process.env.MONGO_URI || '';

let db = null;

async function connectDB() {
  if (!MONGO_URI) { console.log('No MONGO_URI set - accounts disabled, using memory mode'); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('gridlock');
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    console.log('MongoDB connected');
  } catch (e) {
    console.error('MongoDB connection failed:', e.message);
  }
}

// In-memory fallback if no DB
const memUsers = {};
const memScores = [];

// ---- AUTH ROUTES ----
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  if (username.length < 2 || username.length > 16) return res.json({ ok: false, error: 'Username must be 2-16 characters' });
  if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters' });
  const hashed = await bcrypt.hash(password, 10);
  try {
    if (db) {
      const existing = await db.collection('users').findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } });
      if (existing) return res.json({ ok: false, error: 'Username already taken' });
      await db.collection('users').insertOne({ username, password: hashed, createdAt: new Date(), stats: { kills: 0, deaths: 0, wins: 0, matches: 0 } });
    } else {
      if (memUsers[username.toLowerCase()]) return res.json({ ok: false, error: 'Username already taken' });
      memUsers[username.toLowerCase()] = { username, password: hashed, stats: { kills: 0, deaths: 0, wins: 0, matches: 0 } };
    }
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username });
  } catch (e) {
    res.json({ ok: false, error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  try {
    let user;
    if (db) {
      user = await db.collection('users').findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } });
    } else {
      user = memUsers[username.toLowerCase()];
    }
    if (!user) return res.json({ ok: false, error: 'User not found' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ ok: false, error: 'Wrong password' });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, username: user.username, stats: user.stats });
  } catch (e) {
    res.json({ ok: false, error: 'Login failed' });
  }
});

app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false });
  try {
    const data = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, username: data.username });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.post('/api/save-score', async (req, res) => {
  const { token, kills, deaths, accuracy, won } = req.body;
  if (!token) return res.json({ ok: false });
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const username = data.username;
    const scoreEntry = { username, kills, deaths, accuracy, won, date: new Date(), kd: deaths > 0 ? (kills / deaths) : kills };
    if (db) {
      await db.collection('scores').insertOne(scoreEntry);
      await db.collection('users').updateOne(
        { username },
        { $inc: { 'stats.kills': kills, 'stats.deaths': deaths, 'stats.matches': 1, 'stats.wins': won ? 1 : 0 } }
      );
    } else {
      memScores.push(scoreEntry);
      if (memUsers[username.toLowerCase()]) {
        const s = memUsers[username.toLowerCase()].stats;
        s.kills += kills; s.deaths += deaths; s.matches += 1; if (won) s.wins += 1;
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    let scores;
    if (db) {
      scores = await db.collection('scores').find({}).sort({ kills: -1 }).limit(50).toArray();
    } else {
      scores = [...memScores].sort((a, b) => b.kills - a.kills).slice(0, 50);
    }
    res.json({ ok: true, scores });
  } catch (e) {
    res.json({ ok: false, scores: [] });
  }
});

app.get('/api/stats/:username', async (req, res) => {
  try {
    let user;
    if (db) {
      user = await db.collection('users').findOne({ username: req.params.username });
    } else {
      user = memUsers[req.params.username.toLowerCase()];
    }
    if (!user) return res.json({ ok: false, error: 'User not found' });
    res.json({ ok: true, stats: user.stats, username: user.username });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ---- ROOM STATE ----
const rooms = {};
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function makeRoom(code) {
  rooms[code] = { code, players: {}, mode: 'ffa', votes: { tdm: 0, ffa: 0 }, started: false, killLimit: 20, host: null };
  return rooms[code];
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data) => {
    const code = genCode();
    const room = makeRoom(code);
    room.host = socket.id;
    room.killLimit = data.killLimit || 20;
    const player = { id: socket.id, name: data.name || 'Player', x: 0, y: 0, z: 0, yaw: 0, hp: 100, kills: 0, deaths: 0, ready: true, host: true, av: 0, skinIdx: 0, outfitIdx: 0, helmetIdx: 0, colIdx: 0 };
    room.players[socket.id] = player;
    socket.join(code); socket.roomCode = code;
    socket.emit('roomCreated', { code, player, room: sanitizeRoom(room) });
  });

  socket.on('joinRoom', (data) => {
    const code = data.code;
    const room = rooms[code];
    if (!room) { socket.emit('joinError', 'Room not found.'); return; }
    if (room.started) { socket.emit('joinError', 'Match already started.'); return; }
    const playerCount = Object.keys(room.players).length;
    const player = { id: socket.id, name: data.name || 'Player', x: 0, y: 0, z: 0, yaw: 0, hp: 100, kills: 0, deaths: 0, ready: true, host: false, av: playerCount % 4, skinIdx: playerCount % 6, outfitIdx: playerCount % 6, helmetIdx: playerCount % 6, colIdx: playerCount % 8 };
    room.players[socket.id] = player;
    socket.join(code); socket.roomCode = code;
    socket.emit('roomJoined', { player, room: sanitizeRoom(room) });
    socket.to(code).emit('playerJoined', { player });
  });

  socket.on('chatMsg', (msg) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const player = room.players[socket.id];
    io.to(code).emit('chatMsg', { from: player ? player.name : 'Unknown', msg });
  });

  socket.on('vote', (mode) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const player = room.players[socket.id]; if (!player) return;
    if (player.vote) room.votes[player.vote] = Math.max(0, room.votes[player.vote] - 1);
    player.vote = mode; room.votes[mode] = (room.votes[mode] || 0) + 1;
    io.to(code).emit('votesUpdated', room.votes);
  });

  socket.on('startMatch', () => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    if (socket.id !== room.host) return;
    room.started = true;
    room.mode = room.votes.ffa >= room.votes.tdm ? 'ffa' : 'tdm';
    const plist = Object.values(room.players);
    plist.forEach((p, i) => { const ang = (i / plist.length) * Math.PI * 2; p.x = Math.cos(ang) * 10; p.z = Math.sin(ang) * 10; p.y = 0; });
    io.to(code).emit('matchStarted', { mode: room.mode, killLimit: room.killLimit, players: room.players });
  });

  socket.on('move', (data) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room || !room.started) return;
    const player = room.players[socket.id]; if (!player) return;
    player.x = data.x; player.y = data.y; player.z = data.z; player.yaw = data.yaw; player.anim = data.anim;
    socket.to(code).emit('playerMoved', { id: socket.id, x: data.x, y: data.y, z: data.z, yaw: data.yaw, anim: data.anim });
  });

  socket.on('shoot', (data) => {
    const code = socket.roomCode; if (!code) return;
    socket.to(code).emit('playerShot', { id: socket.id, ...data });
  });

  socket.on('hitPlayer', (data) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const victim = room.players[data.victimId]; if (!victim) return;
    const shooter = room.players[socket.id]; if (!shooter) return;
    victim.hp -= data.damage;
    if (victim.hp <= 0) {
      victim.hp = 100; victim.deaths++; shooter.kills++;
      const ang = Math.random() * Math.PI * 2;
      victim.x = Math.cos(ang) * 8; victim.z = Math.sin(ang) * 8; victim.y = 0;
      io.to(code).emit('playerKilled', { killerId: socket.id, killerName: shooter.name, victimId: data.victimId, victimName: victim.name, scores: getScores(room), respawn: { x: victim.x, y: victim.y, z: victim.z } });
      if (shooter.kills >= room.killLimit) {
        io.to(code).emit('matchOver', { winnerId: socket.id, winnerName: shooter.name, scores: getScores(room) });
      }
    } else {
      io.to(code).emit('playerHurt', { victimId: data.victimId, hp: victim.hp });
    }
  });

  socket.on('barrelExploded', (data) => { const code = socket.roomCode; if (!code) return; socket.to(code).emit('barrelExploded', data); });
  socket.on('crateTaken', (data) => { const code = socket.roomCode; if (!code) return; socket.to(code).emit('crateTaken', data); });

  socket.on('disconnect', () => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    delete room.players[socket.id];
    io.to(code).emit('playerLeft', { id: socket.id });
    if (Object.keys(room.players).length === 0) { delete rooms[code]; }
    else if (room.host === socket.id) {
      room.host = Object.keys(room.players)[0];
      room.players[room.host].host = true;
      io.to(code).emit('newHost', { id: room.host });
    }
  });
});

function sanitizeRoom(room) { return { code: room.code, players: room.players, votes: room.votes, started: room.started, killLimit: room.killLimit }; }
function getScores(room) { const s = {}; Object.values(room.players).forEach(p => { s[p.id] = { name: p.name, kills: p.kills, deaths: p.deaths }; }); return s; }

const PORT = process.env.PORT || 3000;
connectDB().then(() => server.listen(PORT, () => console.log('GRIDLOCK server running on port', PORT)));
