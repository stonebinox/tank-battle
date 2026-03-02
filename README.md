# Tank Battle

A real-time multiplayer tank battle game with power-ups, obstacles, and intense combat action.

## Game Overview

Battle against up to 5 other players in a tactical arena with obstacles and power-ups. Each player has 3 lives and respawns twice before being eliminated. Last tank standing wins!

## How to Play

### Controls
- **WASD** or **Arrow Keys**: Move your tank
- **Mouse**: Aim
- **Left Click** or **Space**: Shoot
- **Power-ups**: Automatically activated on pickup

### Power-Ups
- **Shield**: Blocks incoming attacks
- **Machine Gun**: Rapid-fire mode
- **Phase**: Pass through walls and arena boundaries
- **Freeze**: Freeze enemies in place
- **Land Mine**: Place explosive traps
- **Heat Seeker**: Fire homing missiles

### Game Rules
- 3 lives per player (2 respawns)
- 3-second respawn timer after death
- Eliminated after using all lives
- Obstacles provide tactical cover
- Power-ups spawn randomly throughout the match

## Running Locally

```bash
# Install dependencies
npm install

# Start the server
npm start

# Open browser to http://localhost:3000
```

## Deployment

This game is configured for deployment on Render using the included `render.yaml` file.

To deploy:
1. Connect your repository to Render
2. Render will automatically detect the `render.yaml` configuration
3. The app will be built and deployed automatically

The server is configured to use `process.env.PORT` for Render compatibility.
