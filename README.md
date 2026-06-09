# GRIDLOCK - Multiplayer Shooter Server

## How to run locally (test on your own PC)

1. Make sure you have Node.js installed (https://nodejs.org)
2. Open a terminal in this folder
3. Run:
   npm install
   npm start
4. Open http://localhost:3000 in your browser
5. Friends on the SAME WiFi can join at http://YOUR_LOCAL_IP:3000
   (find your IP with `ipconfig` on Windows or `ifconfig` on Mac/Linux)

---

## How to host online so ANYONE can join (free - Railway.app)

1. Create a free account at https://railway.app
2. Install the Railway CLI:
   npm install -g @railway/cli
3. In this folder, run:
   railway login
   railway init
   railway up
4. Railway will give you a public URL like:
   https://gridlock-production.up.railway.app
5. Share that URL with friends - they open it in their browser and join!

---

## How to host on Render.com (also free)

1. Push this folder to a GitHub repo
2. Go to https://render.com and create a new "Web Service"
3. Connect your GitHub repo
4. Set:
   - Build command: npm install
   - Start command: node server.js
5. Deploy - Render gives you a public URL to share

---

## How multiplayer works

1. You open the URL and enter your name
2. Click CREATE ROOM - you get a 6-letter code (e.g. "XK4RNB")
3. Click the code to copy it, send it to friends
4. Friends open the same URL, click JOIN ROOM, type the code
5. Once everyone is in the lobby, the host clicks START MATCH
6. You can add bots to fill empty slots before starting

---

## Controls

- WASD - Move
- Mouse - Aim (click game to lock cursor)
- Click - Shoot
- E - Loot nearby crate
- R - Reload
- 1-5 - Switch weapon slot
- V - Toggle first/third person
- ESC - Pause
