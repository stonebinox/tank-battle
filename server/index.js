const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Game configuration
const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const MAX_PLAYERS = 6;
const TANK_SIZE = 40;

// Power-up configuration
const POWERUP_TYPES = ['shield', 'machinegun', 'phase', 'freeze', 'landmine', 'heatseeker', 'speed'];
const MAX_POWERUPS = 3;
const POWERUP_SPAWN_MIN = 10000; // 10 seconds
const POWERUP_SPAWN_MAX = 15000; // 15 seconds
const POWERUP_LIFETIME = 30000; // 30 seconds
const POWERUP_PICKUP_DISTANCE = 25;

// Desert map generation
// Tile types: 'sandstone' (indestructible wall), 'border' (arena edge wall),
//             'cactus' (2-hit destructible)
let mapTiles = [];
let nextTileId = 0;
const BORDER_THICKNESS = 12;

function generateDesertMap() {
  const tiles = [];
  nextTileId = 0;

  function overlaps(x, y, w, h, margin = 10) {
    for (const t of tiles) {
      if (x - margin < t.x + t.width &&
          x + w + margin > t.x &&
          y - margin < t.y + t.height &&
          y + h + margin > t.y) {
        return true;
      }
    }
    return false;
  }

  // Border walls (arena edges — impassable)
  tiles.push({ id: nextTileId++, type: 'border', x: 0, y: 0, width: ARENA_WIDTH, height: BORDER_THICKNESS });
  tiles.push({ id: nextTileId++, type: 'border', x: 0, y: ARENA_HEIGHT - BORDER_THICKNESS, width: ARENA_WIDTH, height: BORDER_THICKNESS });
  tiles.push({ id: nextTileId++, type: 'border', x: 0, y: 0, width: BORDER_THICKNESS, height: ARENA_HEIGHT });
  tiles.push({ id: nextTileId++, type: 'border', x: ARENA_WIDTH - BORDER_THICKNESS, y: 0, width: BORDER_THICKNESS, height: ARENA_HEIGHT });

  // Interior walls — a few solid cover blocks (clear of center spawn area)
  const interiorWalls = [
    // Upper-center horizontal barrier
    { x: 340, y: 190, width: 110, height: 16 },
    // Lower-center horizontal barrier
    { x: 340, y: 400, width: 110, height: 16 },
    // Left-side cover
    { x: 150, y: 200, width: 60, height: 16 },
    // Right-side cover
    { x: 590, y: 380, width: 60, height: 16 },
    // Left corridor
    { x: 230, y: 340, width: 16, height: 70 },
    // Right corridor
    { x: 550, y: 190, width: 16, height: 70 },
  ];
  for (const w of interiorWalls) {
    tiles.push({ id: nextTileId++, type: 'sandstone', ...w });
  }

  // 1-2 random extra walls for variety
  const extraWallCount = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < extraWallCount; i++) {
    const isHorizontal = Math.random() > 0.5;
    const w = isHorizontal ? (40 + Math.floor(Math.random() * 50)) : 16;
    const h = isHorizontal ? 16 : (40 + Math.floor(Math.random() * 50));
    let attempts = 0;
    while (attempts < 30) {
      const x = 80 + Math.floor(Math.random() * (ARENA_WIDTH - 160 - w));
      const y = 80 + Math.floor(Math.random() * (ARENA_HEIGHT - 160 - h));
      if (!overlaps(x, y, w, h, 50)) {
        tiles.push({ id: nextTileId++, type: 'sandstone', x, y, width: w, height: h });
        break;
      }
      attempts++;
    }
  }

  // Random cacti (3-5)
  const cactusCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < cactusCount; i++) {
    const size = 20 + Math.floor(Math.random() * 10);
    let attempts = 0;
    while (attempts < 30) {
      const x = 60 + Math.floor(Math.random() * (ARENA_WIDTH - 120));
      const y = 60 + Math.floor(Math.random() * (ARENA_HEIGHT - 120));
      if (!overlaps(x - size / 2, y - size / 2, size, size, 30)) {
        tiles.push({
          id: nextTileId++, type: 'cactus',
          x: x - size / 2, y: y - size / 2,
          width: size, height: size,
          cx: x, cy: y, radius: size / 2,
          health: 2, maxHealth: 2
        });
        break;
      }
      attempts++;
    }
  }

  return tiles;
}

// Generate initial map
mapTiles = generateDesertMap();

// Get only the solid (blocking) tiles for collision checks
function getSolidTiles() {
  return mapTiles.filter(t =>
    t.type === 'sandstone' || t.type === 'border' || (t.type === 'cactus' && t.health > 0)
  );
}

// Available colors for players
const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F'];

// Game state
const players = new Map();
const respawnTimers = new Map();
const powerups = new Map();
let nextPowerupId = 0;
let powerupSpawnTimer = null;
let gameStartTime = null;
const GAME_DURATION = 300 * 1000; // 300 seconds (5 minutes)
let gameEnded = false;
const eliminatedNames = new Set(); // names banned until next round
let roundResetting = false; // blocks `join` while server resets between rounds

// Power-up specific state
const mines = new Map();
let nextMineId = 0;
const heatseekers = new Map();
let nextHeatseekerId = 0;

// Basic anti-cheat: validate client-reported cactus hits using the last fired shot direction.
// (Client still reports the exact hit point, but we only accept hits close to the latest shot path.)
const lastShotByPlayer = new Map(); // socket.id -> {x, y, dirX, dirY, time}
const lastCactusHitByPlayer = new Map(); // socket.id -> timestamp
const CACTUS_HIT_COOLDOWN_MS = 200;

function validateCactusHit(playerId, x, y) {
  const shot = lastShotByPlayer.get(playerId);
  if (!shot) return false;

  const now = Date.now();
  if (now - shot.time > 1000) return false; // hit must be close to last shot time

  // Vector from shot origin to reported hit
  const px = x - shot.x;
  const py = y - shot.y;
  const dot = px * shot.dirX + py * shot.dirY; // in front of the bullet?
  if (dot < -5) return false;

  // Perpendicular distance from bullet ray to point
  const perp = Math.abs(px * shot.dirY - py * shot.dirX);
  if (perp > 12) return false;

  // Rough distance cap (avoid totally random far hits)
  const dist = Math.hypot(px, py);
  if (dist > 650) return false;

  // Rate limit accepted cactus hits
  const lastHitAt = lastCactusHitByPlayer.get(playerId) || 0;
  if (now - lastHitAt < CACTUS_HIT_COOLDOWN_MS) return false;

  return true;
}

// Monster Tank state
let monsterTank = null; // {x, y, angle, health, maxHealth, lastShot}
const MONSTER_SPAWN_INTERVAL = 120000; // 2 minutes
const MONSTER_MAX_HEALTH = 20;
const MONSTER_SIZE = 60; // 2x normal
const MONSTER_SPEED = 2.5; // faster than before
const MONSTER_SHOOT_INTERVAL = 1500; // shoots every 1.5s
let monsterBullets = [];
let nextMonsterBulletId = 0;

// Damage model (percent of 100 HP)
const PLAYER_MAX_HEALTH = 100;
const DAMAGE_PLAYER_BULLET = 20;   // 20%
const DAMAGE_MONSTER_BULLET = 25;  // 25%
const DAMAGE_HEATSEEKER = 50;      // 50%
const DAMAGE_MINE = 50;            // 50% (not specified; kept strong)

// Helper function to check spawn immunity
function hasSpawnImmunity(player) {
  return player.spawnTime && (Date.now() - player.spawnTime < 3000);
}

function getLivesRemaining(player) {
  return Math.max(0, (player.maxLives || 0) - (player.respawnsUsed || 0));
}

function applyDamageToPlayer(playerId, player, amount, killerId, killerKills = 0) {
  // Check spawn immunity
  if (hasSpawnImmunity(player)) return { applied: false, killed: false };

  // Shield blocks ALL damage
  const hasShield =
    player.activePowerups &&
    player.activePowerups.shield &&
    Date.now() < player.activePowerups.shield;
  if (hasShield) {
    io.emit('shieldBlocked', { playerId, shooterId: killerId });
    return { applied: false, killed: false };
  }

  player.health = Math.max(0, (player.health ?? PLAYER_MAX_HEALTH) - amount);

  // Keep player.lives as "lives remaining" for HUD compatibility
  player.lives = getLivesRemaining(player);

  io.emit('playerHit', {
    playerId,
    health: player.health,
    maxHealth: player.maxHealth || PLAYER_MAX_HEALTH,
    lives: player.lives,
    killerId,
    kills: killerKills
  });

  if (player.health > 0) return { applied: true, killed: false };

  // Death (consume one life)
  player.isDead = true;
  player.respawnsUsed = (player.respawnsUsed || 0) + 1;
  player.lives = getLivesRemaining(player);

  io.emit('playerDied', {
    playerId,
    killerId,
    kills: killerKills
  });

  if (player.respawnsUsed < player.maxLives) {
    const timerId = setTimeout(() => {
      const p = players.get(playerId);
      if (p && p.isDead) {
        const spawnPos = getRandomSpawnPosition();
        p.x = spawnPos.x;
        p.y = spawnPos.y;
        p.angle = 0;
        p.health = PLAYER_MAX_HEALTH;
        p.maxHealth = PLAYER_MAX_HEALTH;
        p.isDead = false;
        p.spawnTime = Date.now();
        p.lives = getLivesRemaining(p);

        io.emit('playerRespawned', {
          playerId: p.id,
          x: p.x,
          y: p.y,
          angle: p.angle,
          health: p.health,
          maxHealth: p.maxHealth,
          lives: p.lives,
          respawnsUsed: p.respawnsUsed,
          spawnTime: p.spawnTime
        });
      }
      respawnTimers.delete(playerId);
    }, 3000);

    respawnTimers.set(playerId, timerId);
  } else {
    player.isEliminated = true;
    eliminatedNames.add(player.name.toLowerCase());
    io.emit('playerEliminated', {
      playerId,
      killerId
    });
    checkAllEliminated();
  }

  return { applied: true, killed: true };
}

// Helper functions — collision only against solid tiles (sandstone + alive cacti)
function isPositionInsideObstacle(x, y, radius = TANK_SIZE / 2) {
  for (const tile of getSolidTiles()) {
    if (x + radius > tile.x &&
        x - radius < tile.x + tile.width &&
        y + radius > tile.y &&
        y - radius < tile.y + tile.height) {
      return true;
    }
  }
  return false;
}


// Damage a cactus tile at position; returns the hit tile or null
function damageCactusAt(x, y) {
  for (const tile of mapTiles) {
    if (tile.type !== 'cactus' || tile.health <= 0) continue;
    if (x >= tile.x && x <= tile.x + tile.width &&
        y >= tile.y && y <= tile.y + tile.height) {
      tile.health -= 1;
      io.emit('tileUpdated', { id: tile.id, health: tile.health });
      if (tile.health <= 0) {
        io.emit('tileDestroyed', tile.id);
      }
      return tile;
    }
  }
  return null;
}

function getRandomSpawnPosition() {
  const margin = TANK_SIZE;
  let attempts = 0;
  let x, y;

  // Try to find a valid spawn position that doesn't overlap obstacles
  do {
    x = margin + Math.random() * (ARENA_WIDTH - 2 * margin);
    y = margin + Math.random() * (ARENA_HEIGHT - 2 * margin);
    attempts++;
  } while (isPositionInsideObstacle(x, y) && attempts < 50);

  return { x, y };
}

function getAvailableColor() {
  const usedColors = Array.from(players.values()).map(p => p.color);
  const availableColors = COLORS.filter(c => !usedColors.includes(c));
  return availableColors.length > 0 ? availableColors[0] : COLORS[0];
}

// Power-up functions
function spawnPowerup() {
  // Don't spawn if we've reached max power-ups
  if (powerups.size >= MAX_POWERUPS) {
    schedulePowerupSpawn();
    return;
  }

  // Get random position that doesn't overlap obstacles
  const margin = 30;
  let attempts = 0;
  let x, y;

  do {
    x = margin + Math.random() * (ARENA_WIDTH - 2 * margin);
    y = margin + Math.random() * (ARENA_HEIGHT - 2 * margin);
    attempts++;
  } while (isPositionInsideObstacle(x, y, 15) && attempts < 50);

  // Get random power-up type
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];

  const powerup = {
    id: nextPowerupId++,
    type: type,
    x: x,
    y: y,
    spawnTime: Date.now()
  };

  powerups.set(powerup.id, powerup);

  // Broadcast to all clients
  io.emit('powerupSpawned', powerup);

  console.log(`Power-up spawned: ${type} at (${Math.floor(x)}, ${Math.floor(y)})`);

  // Schedule expiration
  setTimeout(() => {
    if (powerups.has(powerup.id)) {
      powerups.delete(powerup.id);
      io.emit('powerupExpired', powerup.id);
      console.log(`Power-up expired: ${type}`);
    }
  }, POWERUP_LIFETIME);

  // Schedule next spawn
  schedulePowerupSpawn();
}

function schedulePowerupSpawn() {
  if (powerupSpawnTimer) {
    clearTimeout(powerupSpawnTimer);
  }
  const delay = POWERUP_SPAWN_MIN + Math.random() * (POWERUP_SPAWN_MAX - POWERUP_SPAWN_MIN);
  powerupSpawnTimer = setTimeout(spawnPowerup, delay);
}

// Monster Tank functions
function findClearPosition() {
  const candidates = [
    { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 },
    { x: 150, y: 300 },
    { x: 650, y: 300 },
    { x: 400, y: 100 },
    { x: 400, y: 500 },
  ];
  for (const pos of candidates) {
    if (!isPositionInsideObstacle(pos.x, pos.y, MONSTER_SIZE / 2)) return pos;
  }
  return candidates[0];
}

function spawnMonster() {
  if (monsterTank !== null) return;

  const pos = findClearPosition();
  monsterTank = {
    x: pos.x,
    y: pos.y,
    angle: 0,
    health: MONSTER_MAX_HEALTH,
    maxHealth: MONSTER_MAX_HEALTH,
    lastShot: Date.now(),
    stuckCount: 0
  };

  // Broadcast to all clients
  io.emit('monsterSpawned', {
    x: monsterTank.x,
    y: monsterTank.y,
    health: monsterTank.health,
    maxHealth: monsterTank.maxHealth
  });

  console.log('Monster Tank spawned at center!');
}

function updateMonsterTankAI() {
  if (!monsterTank) return;

  // Target the nearest living player
  let nearestPlayer = null;
  let bestDistance = Infinity;
  let nearestPlayerId = null;

  for (const [playerId, player] of players.entries()) {
    if (player.isDead || player.isEliminated) continue;

    const dx = player.x - monsterTank.x;
    const dy = player.y - monsterTank.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < bestDistance) {
      bestDistance = distance;
      nearestPlayer = player;
      nearestPlayerId = playerId;
    }
  }

  if (nearestPlayer) {
    const targetAngle = Math.atan2(nearestPlayer.y - monsterTank.y, nearestPlayer.x - monsterTank.x);
    let angleDiff = targetAngle - monsterTank.angle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    const turnRate = 0.05;
    if (Math.abs(angleDiff) > turnRate) {
      monsterTank.angle += Math.sign(angleDiff) * turnRate;
    } else {
      monsterTank.angle = targetAngle;
    }

    // Movement with wall-sliding: try full move, then X-only, then Y-only
    const moveR = MONSTER_SIZE / 2 - 2; // slightly smaller for movement checks
    const wantDX = Math.cos(targetAngle) * MONSTER_SPEED;
    const wantDY = Math.sin(targetAngle) * MONSTER_SPEED;

    const canGo = (x, y) =>
      !isPositionInsideObstacle(x, y, moveR) &&
      x > moveR + BORDER_THICKNESS && x < ARENA_WIDTH - moveR - BORDER_THICKNESS &&
      y > moveR + BORDER_THICKNESS && y < ARENA_HEIGHT - moveR - BORDER_THICKNESS;

    let nx = monsterTank.x + wantDX;
    let ny = monsterTank.y + wantDY;

    if (canGo(nx, ny)) {
      monsterTank.x = nx;
      monsterTank.y = ny;
      monsterTank.stuckCount = 0;
    } else if (canGo(monsterTank.x + wantDX, monsterTank.y)) {
      monsterTank.x += wantDX;
      monsterTank.stuckCount = 0;
    } else if (canGo(monsterTank.x, monsterTank.y + wantDY)) {
      monsterTank.y += wantDY;
      monsterTank.stuckCount = 0;
    } else {
      monsterTank.stuckCount = (monsterTank.stuckCount || 0) + 1;
      if (monsterTank.stuckCount > 60) {
        const safePos = findClearPosition();
        monsterTank.x = safePos.x;
        monsterTank.y = safePos.y;
        monsterTank.stuckCount = 0;
      }
    }

    // Check for mine collision with monster
    if (monsterTank) {
      for (const [mineId, mine] of mines.entries()) {
        const dx = monsterTank.x - mine.x;
        const dy = monsterTank.y - mine.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 55) { // Larger radius for monster
          mines.delete(mineId);
          monsterTank.health -= 1;
          monsterTank.lastHit = Date.now();

          const mineOwner = players.get(mine.playerId);
          if (mineOwner) {
            mineOwner.kills += 1;
          }

          io.emit('mineExploded', {
            mineId: mineId,
            victimId: 'monster',
            x: mine.x,
            y: mine.y
          });

          io.emit('monsterHit', {
            health: monsterTank.health,
            shooterId: mine.playerId
          });

          if (monsterTank.health <= 0) {
            io.emit('monsterDestroyed', { killerId: mine.playerId });
            monsterTank = null;
            monsterBullets = [];
            break;
          }
        }
      }
    }

    // Shoot at player
    if (!monsterTank) return;
    const now = Date.now();
    if (now - monsterTank.lastShot > MONSTER_SHOOT_INTERVAL) {
      monsterTank.lastShot = now;

      // Fire bullet
      const barrelLength = MONSTER_SIZE / 2 + 10;
      const bulletX = monsterTank.x + Math.cos(monsterTank.angle) * barrelLength;
      const bulletY = monsterTank.y + Math.sin(monsterTank.angle) * barrelLength;

      const bullet = {
        id: nextMonsterBulletId++,
        x: bulletX,
        y: bulletY,
        velocityX: Math.cos(monsterTank.angle) * 8,
        velocityY: Math.sin(monsterTank.angle) * 8
      };

      monsterBullets.push(bullet);

      io.emit('monsterBulletFired', bullet);
    }
  }

  // Broadcast updated position
  io.emit('monsterUpdate', {
    x: monsterTank.x,
    y: monsterTank.y,
    angle: monsterTank.angle,
    health: monsterTank.health
  });
}

function updateMonsterBullets() {
  for (let i = monsterBullets.length - 1; i >= 0; i--) {
    const bullet = monsterBullets[i];
    const prevX = bullet.x;
    const prevY = bullet.y;
    bullet.x += bullet.velocityX;
    bullet.y += bullet.velocityY;

    // Check if out of bounds
    if (bullet.x < 0 || bullet.x > ARENA_WIDTH || bullet.y < 0 || bullet.y > ARENA_HEIGHT) {
      monsterBullets.splice(i, 1);
      continue;
    }

    // Check if hit obstacle — swept to avoid tunneling through thin walls
    const steps = Math.max(1, Math.ceil(Math.hypot(bullet.x - prevX, bullet.y - prevY) / 4));
    let hitObstacle = false;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const sx = prevX + (bullet.x - prevX) * t;
      const sy = prevY + (bullet.y - prevY) * t;
      if (isPositionInsideObstacle(sx, sy, 4)) {
        damageCactusAt(sx, sy);
        hitObstacle = true;
        break;
      }
    }
    if (hitObstacle) {
      monsterBullets.splice(i, 1);
      continue;
    }

    // Check collision with players
    for (const [playerId, player] of players.entries()) {
      if (player.isDead || player.isEliminated) continue;

      const dx = bullet.x - player.x;
      const dy = bullet.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < 20) {
        // Hit player!
        monsterBullets.splice(i, 1);
        applyDamageToPlayer(playerId, player, DAMAGE_MONSTER_BULLET, 'monster', 0);
        break;
      }
    }
  }
}

function checkPowerupPickup(player) {
  for (const [id, powerup] of powerups.entries()) {
    const dx = player.x - powerup.x;
    const dy = player.y - powerup.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < POWERUP_PICKUP_DISTANCE) {
      // Remove power-up from map
      powerups.delete(id);

      // Add to player's active power-ups (with 10 second duration for now)
      if (!player.activePowerups) {
        player.activePowerups = {};
      }
      player.activePowerups[powerup.type] = Date.now() + 10000;

      // Broadcast pickup
      io.emit('powerupCollected', {
        playerId: player.id,
        powerupId: id,
        powerupType: powerup.type
      });

      console.log(`Player ${player.name} collected power-up: ${powerup.type}`);
      return true;
    }
  }
  return false;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Handle player join
  socket.on('join', (playerName) => {
    const name = (playerName || `Player ${players.size + 1}`).trim();

    // Check max players
    if (players.size >= MAX_PLAYERS) {
      socket.emit('error', 'Game is full');
      return;
    }

    // Prevent re-joining during the round reset window
    if (roundResetting) {
      socket.emit('error', 'Round is resetting. Please wait...');
      return;
    }

    // Block eliminated players from re-joining this round
    if (eliminatedNames.has(name.toLowerCase())) {
      socket.emit('error', 'You were eliminated this round. Wait for the next round to start.');
      return;
    }

    const spawnPos = getRandomSpawnPosition();
    const player = {
      id: socket.id,
      name: name,
      x: spawnPos.x,
      y: spawnPos.y,
      angle: 0,
      color: getAvailableColor(),
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      lives: 5,
      maxLives: 5,
      respawnsUsed: 0,
      kills: 0,
      isEliminated: false,
      isDead: false,
      activePowerups: {},
      spawnTime: Date.now()
    };

    players.set(socket.id, player);

    // Start game timer when first player joins
    if (players.size === 1 && gameStartTime === null) {
      gameStartTime = Date.now();
      gameEnded = false;
      console.log('Game timer started!');
    }

    // Send current player their info
    socket.emit('joined', player);

    // Send desert map tiles to the new player
    socket.emit('mapTiles', mapTiles);

    // Send existing power-ups to the new player
    socket.emit('powerupsState', Array.from(powerups.values()));

    // Send monster state if it exists
    if (monsterTank) {
      socket.emit('monsterSpawned', {
        x: monsterTank.x,
        y: monsterTank.y,
        health: monsterTank.health,
        maxHealth: monsterTank.maxHealth
      });
    }

    // Broadcast new player to everyone
    io.emit('playerJoined', player);

    // Send all existing players to new player
    socket.emit('gameState', Array.from(players.values()));

    console.log(`Player ${player.name} joined the game`);
  });

  // Handle player movement
  socket.on('move', (data) => {
    if (gameEnded) return;
    const player = players.get(socket.id);
    if (!player || player.isDead || player.isEliminated) return;

    // Check if player is frozen
    if (player.frozenUntil && Date.now() < player.frozenUntil) {
      // Reject movement if frozen
      return;
    }

    // Check if player has active phase power-up
    const hasPhase = player.activePowerups &&
                    player.activePowerups.phase &&
                    Date.now() < player.activePowerups.phase;

    // Update player position and angle
    // Phase: allow wall ghosting and out-of-bounds (client wraps)
    // Normal: clamp to arena and prevent moving through solid tiles
    const oldX = player.x;
    const oldY = player.y;

    let nextX = player.x;
    let nextY = player.y;

    if (data.x !== undefined) nextX = data.x;
    if (data.y !== undefined) nextY = data.y;

    if (!hasPhase) {
      nextX = Math.max(0, Math.min(ARENA_WIDTH, nextX));
      nextY = Math.max(0, Math.min(ARENA_HEIGHT, nextY));

      if (isPositionInsideObstacle(nextX, nextY, TANK_SIZE / 2)) {
        nextX = oldX;
        nextY = oldY;
      }
    }

    player.x = nextX;
    player.y = nextY;
    if (data.angle !== undefined) player.angle = data.angle;

    // Check for mine collision (all mines except own)
    for (const [mineId, mine] of mines.entries()) {
      if (mine.playerId !== socket.id) {
        const dx = player.x - mine.x;
        const dy = player.y - mine.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 30) {
          // Check spawn immunity
          if (hasSpawnImmunity(player)) {
            continue;
          }

          // Mine triggered!
          mines.delete(mineId);

          // Apply damage to player (shield blocks all damage) + increment kills for every successful hit
          const mineOwner = players.get(mine.playerId);
          const nextKills = mineOwner ? mineOwner.kills + 1 : 0;
          const dmgRes = applyDamageToPlayer(
            player.id,
            player,
            DAMAGE_MINE,
            mine.playerId,
            nextKills
          );
          if (mineOwner && dmgRes.applied) {
            mineOwner.kills = nextKills;
          }

          io.emit('mineExploded', {
            mineId: mineId,
            victimId: player.id,
            x: mine.x,
            y: mine.y
          });

          // (death/respawn/elimination handled inside applyDamageToPlayer)

          break; // Only trigger one mine at a time
        }
      }
    }

    // Check for power-up pickup
    checkPowerupPickup(player);

    // Broadcast updated position to all clients
    io.emit('playerMoved', {
      id: socket.id,
      x: player.x,
      y: player.y,
      angle: player.angle
    });
  });

  // Handle shooting
  socket.on('shoot', (data) => {
    if (gameEnded) return;
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead || shooter.isEliminated) return;

    // Store last shot for basic hit validation (e.g., cactus hits)
    const shotSpeed = Math.hypot(data.velocityX || 0, data.velocityY || 0);
    if (shotSpeed > 0) {
      lastShotByPlayer.set(socket.id, {
        x: data.x,
        y: data.y,
        dirX: (data.velocityX || 0) / shotSpeed,
        dirY: (data.velocityY || 0) / shotSpeed,
        time: Date.now()
      });
    }

    // Broadcast bullet to all clients
    io.emit('bulletFired', {
      shooterId: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle,
      velocityX: data.velocityX,
      velocityY: data.velocityY
    });

    // Check for hits
    if (data.hitPlayerId) {
      const hitPlayer = players.get(data.hitPlayerId);
      if (hitPlayer && !hitPlayer.isDead && !hitPlayer.isEliminated) {
        // Check spawn immunity
        if (hasSpawnImmunity(hitPlayer)) {
          return;
        }

        // Apply damage (shield blocks all damage) + increment kills for every successful hit
        const nextKills = shooter.kills + 1;
        const dmgRes = applyDamageToPlayer(
          hitPlayer.id,
          hitPlayer,
          DAMAGE_PLAYER_BULLET,
          shooter.id,
          nextKills
        );
        if (dmgRes.applied) {
          shooter.kills = nextKills;
        }
      }
    }
  });

  // Handle freeze bullet
  socket.on('freezeBullet', (data) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead || shooter.isEliminated) return;

    // Broadcast freeze bullet to all clients
    io.emit('freezeBulletFired', {
      shooterId: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle,
      velocityX: data.velocityX,
      velocityY: data.velocityY
    });

    // Check for hits
    if (data.hitPlayerId) {
      const hitPlayer = players.get(data.hitPlayerId);
      if (hitPlayer && !hitPlayer.isDead && !hitPlayer.isEliminated) {
        // Check spawn immunity
        if (hasSpawnImmunity(hitPlayer)) {
          return;
        }

        // Check if player has active shield
        const hasShield = hitPlayer.activePowerups &&
                         hitPlayer.activePowerups.shield &&
                         Date.now() < hitPlayer.activePowerups.shield;

        if (hasShield) {
          io.emit('shieldBlocked', {
            playerId: hitPlayer.id,
            shooterId: shooter.id
          });
          console.log(`Shield blocked freeze bullet on player ${hitPlayer.name}`);
          return;
        }

        // Freeze the player for 5 seconds
        hitPlayer.frozenUntil = Date.now() + 5000;

        io.emit('playerFrozen', {
          playerId: hitPlayer.id,
          duration: 5000
        });

        console.log(`Player ${hitPlayer.name} frozen by ${shooter.name}`);
      }
    }
  });

  // Handle land mine placement
  socket.on('placeMine', (data) => {
    const player = players.get(socket.id);
    if (!player || player.isDead || player.isEliminated) return;

    const mine = {
      id: nextMineId++,
      playerId: socket.id,
      x: data.x,
      y: data.y,
      placedAt: Date.now()
    };

    mines.set(mine.id, mine);

    // Broadcast to all clients
    io.emit('minePlaced', mine);

    console.log(`Player ${player.name} placed mine at (${Math.floor(data.x)}, ${Math.floor(data.y)})`);

    // Mine expires after 10 seconds
    setTimeout(() => {
      if (mines.has(mine.id)) {
        mines.delete(mine.id);
        io.emit('mineExpired', mine.id);
        console.log(`Mine ${mine.id} expired`);
      }
    }, 10000);
  });

  // Handle bullet hitting a cactus (reported by client)
  socket.on('hitCactus', (data) => {
    if (gameEnded) return;
  const x = data && typeof data.x === 'number' ? data.x : null;
  const y = data && typeof data.y === 'number' ? data.y : null;
  if (x === null || y === null) return;

  // Accept cactus hits only if they match the latest shot direction (and pass cooldown).
  if (!validateCactusHit(socket.id, x, y)) return;
  lastCactusHitByPlayer.set(socket.id, Date.now());
  damageCactusAt(x, y);
  });

  // Handle heat seeking missile
  socket.on('heatseeker', (data) => {
    if (gameEnded) return;
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead || shooter.isEliminated) return;

    const heatseeker = {
      id: nextHeatseekerId++,
      shooterId: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle,
      velocityX: Math.cos(data.angle) * 5, // Slower than normal bullets
      velocityY: Math.sin(data.angle) * 5,
      targetId: null,
      createdAt: Date.now()
    };

    heatseekers.set(heatseeker.id, heatseeker);

    // Broadcast to all clients
    io.emit('heatseekerFired', heatseeker);

    console.log(`Player ${shooter.name} fired heatseeker`);
  });

  // Handle shootMonster event
  socket.on('shootMonster', (data) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead || shooter.isEliminated || !monsterTank) return;

    // Check if bullet actually hits monster (within ~40px)
    const dx = data.x - monsterTank.x;
    const dy = data.y - monsterTank.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 55) {
      // Hit!
      monsterTank.health -= 1;
      shooter.kills += 1;

      io.emit('monsterHit', {
        health: monsterTank.health,
        shooterId: shooter.id
      });

      console.log(`Monster hit by ${shooter.name}! Health: ${monsterTank.health}`);

      if (monsterTank.health <= 0) {
        // Monster destroyed!
        io.emit('monsterDestroyed', {
          killerId: shooter.id
        });

        console.log(`Monster destroyed by ${shooter.name}!`);

        // Drop 3 power-ups when monster destroyed
        const offsets = [
          { x: -40, y: 0 },
          { x: 40, y: 0 },
          { x: 0, y: -40 }
        ];
        for (let i = 0; i < 3; i++) {
          const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
          const powerup = {
            id: nextPowerupId++,
            type: type,
            x: Math.max(30, Math.min(ARENA_WIDTH - 30, monsterTank.x + offsets[i].x)),
            y: Math.max(30, Math.min(ARENA_HEIGHT - 30, monsterTank.y + offsets[i].y)),
            spawnTime: Date.now()
          };
          powerups.set(powerup.id, powerup);
          io.emit('powerupSpawned', powerup);

          setTimeout(() => {
            if (powerups.has(powerup.id)) {
              powerups.delete(powerup.id);
              io.emit('powerupExpired', powerup.id);
            }
          }, POWERUP_LIFETIME);
        }

        monsterTank = null;
        monsterBullets = [];
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`Player ${player.name} disconnected`);

      if (respawnTimers.has(socket.id)) {
        clearTimeout(respawnTimers.get(socket.id));
        respawnTimers.delete(socket.id);
      }

      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
      checkAllEliminated();
    }
  });

  // Handle explicit leave
  socket.on('leave', () => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`Player ${player.name} left the game`);

      if (respawnTimers.has(socket.id)) {
        clearTimeout(respawnTimers.get(socket.id));
        respawnTimers.delete(socket.id);
      }

      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
      checkAllEliminated();
    }
  });
});

// End the current round: show rankings, reset state, let players rejoin
function endRound() {
  if (gameEnded) return;

  const playerArray = Array.from(players.values());
  const rankings = playerArray
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 3)
    .map((player, index) => ({
      rank: index + 1,
      name: player.name,
      kills: player.kills
    }));

  gameEnded = true;
  roundResetting = true;
  io.emit('gameOver', rankings);
  console.log('Game over! Rankings:', rankings);

  // Reset for next round
  gameStartTime = null;
  eliminatedNames.clear();

  for (const [id, p] of players.entries()) {
    const s = io.sockets.sockets.get(id);
    if (s) s.emit('roundOver');
  }
  players.clear();
  respawnTimers.forEach(t => clearTimeout(t));
  respawnTimers.clear();
  mines.clear();
  heatseekers.clear();
  monsterTank = null;
  monsterBullets = [];
  powerups.clear();
  mapTiles = generateDesertMap();

  lastShotByPlayer.clear();
  lastCactusHitByPlayer.clear();

  // Allow new round joins after the client finishes its 8s round-over UI delay
  setTimeout(() => {
    roundResetting = false;
  }, 8000);
}

// Check if all players are eliminated or gone — if so, end round early
function checkAllEliminated() {
  if (!gameStartTime || gameEnded) return;

  if (players.size === 0) {
    console.log('No players remaining — ending round');
    endRound();
    return;
  }

  const anyAlive = Array.from(players.values()).some(p => !p.isEliminated);
  if (!anyAlive) {
    console.log('All players eliminated — ending round early');
    endRound();
  }
}

// Broadcast game state at 10fps (playerMoved handles real-time sync)
setInterval(() => {
  if (players.size > 0) {
    io.emit('gameState', Array.from(players.values()));

    // Check if game should end (timer expired)
    if (gameStartTime && Date.now() - gameStartTime >= GAME_DURATION) {
      endRound();
    } else if (gameStartTime) {
      const remaining = GAME_DURATION - (Date.now() - gameStartTime);
      io.emit('gameTimer', remaining);
    }
  }
}, 100);

// Update monster tank AI at ~20fps
setInterval(() => {
  updateMonsterTankAI();
  updateMonsterBullets();
}, 50);

// Update heat seeking missiles at 60fps
setInterval(() => {
  for (const [id, heatseeker] of heatseekers.entries()) {
    // Remove old missiles (after 5 seconds)
    if (Date.now() - heatseeker.createdAt > 5000) {
      heatseekers.delete(id);
      io.emit('heatseekerExpired', id);
      continue;
    }

    // Find nearest alive enemy (including monster tank)
    let nearestEnemy = null;
    let nearestDistance = Infinity;
    let isTargetingMonster = false;

    for (const [playerId, player] of players.entries()) {
      if (playerId === heatseeker.shooterId || player.isDead || player.isEliminated) {
        continue;
      }

      const dx = player.x - heatseeker.x;
      const dy = player.y - heatseeker.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestEnemy = player;
        isTargetingMonster = false;
      }
    }

    // Also check monster tank as a target
    if (monsterTank && monsterTank.health > 0) {
      const dx = monsterTank.x - heatseeker.x;
      const dy = monsterTank.y - heatseeker.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestEnemy = monsterTank;
        isTargetingMonster = true;
      }
    }

    heatseeker.isTargetingMonster = isTargetingMonster;

    // Update missile trajectory toward target
    if (nearestEnemy) {
      heatseeker.targetId = nearestEnemy.id;
      const dx = nearestEnemy.x - heatseeker.x;
      const dy = nearestEnemy.y - heatseeker.y;
      const targetAngle = Math.atan2(dy, dx);

      // Smoothly turn toward target (add some curve)
      let angleDiff = targetAngle - heatseeker.angle;
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

      // Turn at most 0.15 radians per tick
      const turnRate = 0.15;
      if (Math.abs(angleDiff) > turnRate) {
        heatseeker.angle += Math.sign(angleDiff) * turnRate;
      } else {
        heatseeker.angle = targetAngle;
      }

      // Update velocity based on new angle
      heatseeker.velocityX = Math.cos(heatseeker.angle) * 5;
      heatseeker.velocityY = Math.sin(heatseeker.angle) * 5;
    }

    // Update position
    heatseeker.x += heatseeker.velocityX;
    heatseeker.y += heatseeker.velocityY;

    // Check if out of bounds
    if (heatseeker.x < 0 || heatseeker.x > ARENA_WIDTH ||
        heatseeker.y < 0 || heatseeker.y > ARENA_HEIGHT) {
      heatseekers.delete(id);
      io.emit('heatseekerExpired', id);
      continue;
    }

    // Check collision with target
    if (nearestEnemy) {
      const dx = heatseeker.x - nearestEnemy.x;
      const dy = heatseeker.y - nearestEnemy.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = heatseeker.isTargetingMonster ? 55 : 35;

      if (distance < hitRadius) {
        // Hit!
        heatseekers.delete(id);
        const shooter = players.get(heatseeker.shooterId);

        // Handle monster tank hit
        if (heatseeker.isTargetingMonster && monsterTank) {
          monsterTank.health -= 1;
          monsterTank.lastHit = Date.now();
          if (shooter) shooter.kills += 1;

          io.emit('monsterHit', {
            health: monsterTank.health,
            shooterId: heatseeker.shooterId
          });
          io.emit('heatseekerExpired', id);

          if (monsterTank.health <= 0) {
            io.emit('monsterDestroyed', { killerId: heatseeker.shooterId });
            // Drop 3 power-ups (handled elsewhere - spawn them here)
            const offsets = [{ x: -40, y: 0 }, { x: 40, y: 0 }, { x: 0, y: -40 }];
            for (let i = 0; i < 3; i++) {
              const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
              const powerup = {
                id: nextPowerupId++,
                type: type,
                x: Math.max(30, Math.min(ARENA_WIDTH - 30, monsterTank.x + offsets[i].x)),
                y: Math.max(30, Math.min(ARENA_HEIGHT - 30, monsterTank.y + offsets[i].y)),
                spawnTime: Date.now()
              };
              powerups.set(powerup.id, powerup);
              io.emit('powerupSpawned', powerup);
            }
            monsterTank = null;
            monsterBullets = [];
          }
          continue;
        }

        // Handle player hit
        // Check spawn immunity
        if (hasSpawnImmunity(nearestEnemy)) {
          heatseekers.delete(id);
          io.emit('heatseekerExpired', id);
          continue;
        }

        // Check if player has active shield
        io.emit('heatseekerHit', {
          heatseekerId: id,
          playerId: nearestEnemy.id
        });
        const nextKills = shooter ? shooter.kills + 1 : 0;
        const dmgRes = applyDamageToPlayer(
          nearestEnemy.id,
          nearestEnemy,
          DAMAGE_HEATSEEKER,
          heatseeker.shooterId,
          nextKills
        );
        if (shooter && dmgRes.applied) {
          shooter.kills = nextKills;
        }

        continue;
      }
    }

    // Broadcast updated position
    io.emit('heatseekerUpdate', {
      id: heatseeker.id,
      x: heatseeker.x,
      y: heatseeker.y,
      angle: heatseeker.angle,
      targetId: heatseeker.targetId
    });
  }
}, 1000 / 60);

// Start power-up spawn system
schedulePowerupSpawn();

// Spawn first monster after 30 seconds, then respawn every 2 minutes
setTimeout(() => {
  spawnMonster();
}, 30000);

setInterval(() => {
  spawnMonster();
}, MONSTER_SPAWN_INTERVAL);

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Tank Battle server running on http://localhost:${PORT}`);
  console.log(`Arena size: ${ARENA_WIDTH}x${ARENA_HEIGHT}`);
  console.log(`Max players: ${MAX_PLAYERS}`);
  console.log('Power-up spawn system initialized');
});

