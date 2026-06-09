const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Room state
const rooms = {};

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

function makeRoom(code) {
  rooms[code] = {
    code,
    players: {},
    mode: 'ffa',
    votes: { tdm: 0, ffa: 0 },
    started: false,
    killLimit: 20,
    host: null
  };
  return rooms[code];
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Create room
  socket.on('createRoom', (data) => {
    const code = genCode();
    const room = makeRoom(code);
    room.host = socket.id;
    room.killLimit = data.killLimit || 20;

    const player = {
      id: socket.id,
      name: data.name || 'Player',
      x: 0, y: 0, z: 0,
      yaw: 0,
      hp: 100,
      kills: 0,
      deaths: 0,
      ready: true,
      host: true,
      av: 0,
      skinIdx: 0,
      outfitIdx: 0,
      helmetIdx: 0,
      colIdx: 0
    };
    room.players[socket.id] = player;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code, player, room: sanitizeRoom(room) });
    console.log('room created:', code);
  });

  // Join room
  socket.on('joinRoom', (data) => {
    const code = data.code;
    const room = rooms[code];
    if (!room) { socket.emit('joinError', 'Room not found.'); return; }
    if (room.started) { socket.emit('joinError', 'Match already started.'); return; }

    const playerCount = Object.keys(room.players).length;
    const player = {
      id: socket.id,
      name: data.name || 'Player',
      x: 0, y: 0, z: 0,
      yaw: 0,
      hp: 100,
      kills: 0,
      deaths: 0,
      ready: true,
      host: false,
      av: playerCount % 4,
      skinIdx: playerCount % 6,
      outfitIdx: playerCount % 6,
      helmetIdx: playerCount % 6,
      colIdx: playerCount % 8
    };
    room.players[socket.id] = player;
    socket.join(code);
    socket.roomCode = code;

    socket.emit('roomJoined', { player, room: sanitizeRoom(room) });
    socket.to(code).emit('playerJoined', { player });
    console.log(data.name, 'joined room:', code);
  });

  // Chat
  socket.on('chatMsg', (msg) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const player = room.players[socket.id];
    io.to(code).emit('chatMsg', { from: player ? player.name : 'Unknown', msg });
  });

  // Vote
  socket.on('vote', (mode) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const player = room.players[socket.id]; if (!player) return;
    if (player.vote) room.votes[player.vote] = Math.max(0, room.votes[player.vote] - 1);
    player.vote = mode;
    room.votes[mode] = (room.votes[mode] || 0) + 1;
    io.to(code).emit('votesUpdated', room.votes);
  });

  // Start match
  socket.on('startMatch', () => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    if (socket.id !== room.host) return;
    room.started = true;
    room.mode = room.votes.ffa >= room.votes.tdm ? 'ffa' : 'tdm';
    // Spread players out
    const plist = Object.values(room.players);
    plist.forEach((p, i) => {
      const ang = (i / plist.length) * Math.PI * 2;
      p.x = Math.cos(ang) * 10;
      p.z = Math.sin(ang) * 10;
      p.y = 0;
    });
    io.to(code).emit('matchStarted', { mode: room.mode, killLimit: room.killLimit, players: room.players });
    console.log('match started in room:', code, 'mode:', room.mode);
  });

  // Player position update
  socket.on('move', (data) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room || !room.started) return;
    const player = room.players[socket.id]; if (!player) return;
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.yaw = data.yaw;
    player.anim = data.anim;
    socket.to(code).emit('playerMoved', { id: socket.id, x: data.x, y: data.y, z: data.z, yaw: data.yaw, anim: data.anim });
  });

  // Shot fired
  socket.on('shoot', (data) => {
    const code = socket.roomCode; if (!code) return;
    socket.to(code).emit('playerShot', { id: socket.id, ...data });
  });

  // Hit registered
  socket.on('hitPlayer', (data) => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    const victim = room.players[data.victimId]; if (!victim) return;
    const shooter = room.players[socket.id]; if (!shooter) return;

    victim.hp -= data.damage;
    if (victim.hp <= 0) {
      victim.hp = 100;
      victim.deaths++;
      shooter.kills++;
      // Respawn position
      const ang = Math.random() * Math.PI * 2;
      victim.x = Math.cos(ang) * 8;
      victim.z = Math.sin(ang) * 8;
      victim.y = 0;
      io.to(code).emit('playerKilled', {
        killerId: socket.id, killerName: shooter.name,
        victimId: data.victimId, victimName: victim.name,
        scores: getScores(room),
        respawn: { x: victim.x, y: victim.y, z: victim.z }
      });
      // Check win
      if (shooter.kills >= room.killLimit) {
        io.to(code).emit('matchOver', { winnerId: socket.id, winnerName: shooter.name, scores: getScores(room) });
      }
    } else {
      io.to(code).emit('playerHurt', { victimId: data.victimId, hp: victim.hp });
    }
  });

  // Barrel exploded
  socket.on('barrelExploded', (data) => {
    const code = socket.roomCode; if (!code) return;
    socket.to(code).emit('barrelExploded', data);
  });

  // Crate looted
  socket.on('crateTaken', (data) => {
    const code = socket.roomCode; if (!code) return;
    socket.to(code).emit('crateTaken', data);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode; if (!code) return;
    const room = rooms[code]; if (!room) return;
    delete room.players[socket.id];
    io.to(code).emit('playerLeft', { id: socket.id });
    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
      console.log('room', code, 'deleted (empty)');
    } else if (room.host === socket.id) {
      // Pass host to next player
      room.host = Object.keys(room.players)[0];
      room.players[room.host].host = true;
      io.to(code).emit('newHost', { id: room.host });
    }
    console.log('disconnected:', socket.id);
  });
});

function sanitizeRoom(room) {
  return { code: room.code, players: room.players, votes: room.votes, started: room.started, killLimit: room.killLimit };
}
function getScores(room) {
  const scores = {};
  Object.values(room.players).forEach(p => { scores[p.id] = { name: p.name, kills: p.kills, deaths: p.deaths }; });
  return scores;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('GRIDLOCK server running on port', PORT));
