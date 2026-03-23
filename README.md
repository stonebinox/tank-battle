# Tank Battle - Desert Arena

A real-time multiplayer tank battle game set in a desert-themed arena with destructible obstacles, power-ups, and a roaming Monster Tank boss.

## Game Overview

Battle against other players in a tactical desert arena filled with sandstone walls, destructible cacti, and randomly spawning power-ups. Each player gets 5 lives per round, and rounds last up to 5 minutes. A Monster Tank boss roams the arena, hunting the nearest player. Last tank standing wins!

## How to Play

### Controls
- **WASD** or **Arrow Keys**: Move your tank
- **Mouse**: Aim your turret
- **Left Click** or **Space**: Shoot
- **Power-ups**: Automatically activated on pickup

### Power-Ups
- **Shield** (Blue): Blocks incoming attacks for a limited time
- **Machine Gun** (Orange): Rapid-fire mode with increased fire rate
- **Speed** (Yellow): 50% movement speed boost
- **Phase** (Purple): **Pass through walls** for 10s (and wraps around arena edges)
- **Freeze** (Cyan): Fire freeze bullets that immobilize enemies
- **Land Mine** (Red): Place invisible explosive traps on the ground
- **Heat Seeker** (Pink): Fire homing missiles that track the nearest enemy

### Game Rules
- **5 lives** per player per round
- **5-minute** rounds (300 seconds)
- 3-second respawn timer after each death
- Spawn immunity shield protects newly respawned players
- Eliminated players cannot rejoin with the same name until the next round
- Round ends immediately when all players are eliminated or the timer expires
- Damage is health-based (100 HP): Player bullets **20%**, Monster bullets **25%**, Heatseeker missiles **50%**
- **Shield blocks all damage**

### Desert Arena
- **Sandstone Walls**: Indestructible cover blocks spread throughout the map
- **Border Walls**: Solid arena edges that cannot be passed through
- **Cacti**: Destructible obstacles that take 2 hits to destroy
- **Interior Walls**: A small set of fixed cover walls plus 1–2 random walls each round (kept lighter to avoid clutter)

### Monster Tank
- A large AI-controlled boss tank that spawns during the match
- Targets and chases the **nearest living player**
- Fires bullets at players and deals heavy damage
- Can be destroyed by players for bonus points and power-up drops
- Spawns **~30 seconds** after the first server start, then respawns every **2 minutes** if destroyed

### Visual Effects
- Particle bursts on bullet impacts with walls and tanks
- White hit-flash when tanks take damage
- Glowing shield bubble animation during spawn immunity
- Pulsing glow effects on power-up pickups

## Running Locally

```bash
# Install dependencies
npm install

# Start the development server (with auto-restart)
npm run dev

# Note: dev mode uses nodemon (auto-restarts on changes)

# Or start the production server
npm start

# Open browser to http://localhost:3000
```

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: HTML5 Canvas, vanilla JavaScript
- **Real-time**: WebSocket-based game state sync

## Deployment

This game is configured for deployment on Render using the included `render.yaml` file.

To deploy:
1. Connect your repository to Render
2. Render will automatically detect the `render.yaml` configuration
3. The app will be built and deployed automatically

The server is configured to use `process.env.PORT` for Render compatibility.
