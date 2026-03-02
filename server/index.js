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
const POWERUP_TYPES = ['shield', 'machinegun', 'phase', 'freeze', 'landmine', 'heatseeker'];
const MAX_POWERUPS = 3;
const POWERUP_SPAWN_MIN = 10000; // 10 seconds
const POWERUP_SPAWN_MAX = 15000; // 15 seconds
const POWERUP_LIFETIME = 30000; // 30 seconds
const POWERUP_PICKUP_DISTANCE = 25;

// Obstacles - tactical layout with corners, corridors, and central structures
const OBSTACLES = [
  // Corner cover spots (L-shaped corners)
  { x: 60, y: 60, width: 80, height: 20 },      // Top-left horizontal
  { x: 60, y: 60, width: 20, height: 80 },      // Top-left vertical
  { x: 660, y: 60, width: 80, height: 20 },     // Top-right horizontal
  { x: 720, y: 60, width: 20, height: 80 },     // Top-right vertical
  { x: 60, y: 520, width: 80, height: 20 },     // Bottom-left horizontal
  { x: 60, y: 460, width: 20, height: 80 },     // Bottom-left vertical
  { x: 660, y: 520, width: 80, height: 20 },    // Bottom-right horizontal
  { x: 720, y: 460, width: 20, height: 80 },    // Bottom-right vertical

  // Central structures (offset from true center to allow movement)
  { x: 320, y: 240, width: 160, height: 20 },   // Top horizontal barrier
  { x: 320, y: 340, width: 160, height: 20 },   // Bottom horizontal barrier

  // Vertical corridor walls (with gaps for movement)
  { x: 250, y: 150, width: 20, height: 120 },   // Left vertical wall
  { x: 530, y: 330, width: 20, height: 120 },   // Right vertical wall
];

// Available colors for players
const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F'];

// Game state
const players = new Map();
const respawnTimers = new Map();
const powerups = new Map();
let nextPowerupId = 0;
let powerupSpawnTimer = null;

// Power-up specific state
const mines = new Map();
let nextMineId = 0;
const heatseekers = new Map();
let nextHeatseekerId = 0;

// Monster Tank state
let monsterTank = null; // {x, y, angle, health, maxHealth, lastShot}
const MONSTER_SPAWN_INTERVAL = 120000; // 2 minutes
const MONSTER_MAX_HEALTH = 20;
const MONSTER_SIZE = 60; // 2x normal
const MONSTER_SPEED = 1.5; // slower than players
const MONSTER_SHOOT_INTERVAL = 1500; // shoots every 1.5s
let monsterBullets = [];
let nextMonsterBulletId = 0;

// Helper functions
function isPositionInsideObstacle(x, y, radius = TANK_SIZE / 2) {
  for (const obstacle of OBSTACLES) {
    if (x + radius > obstacle.x &&
        x - radius < obstacle.x + obstacle.width &&
        y + radius > obstacle.y &&
        y - radius < obstacle.y + obstacle.height) {
      return true;
    }
  }
  return false;
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
function spawnMonster() {
  if (monsterTank !== null) return; // Already exists

  // Spawn at center of map
  monsterTank = {
    x: ARENA_WIDTH / 2,
    y: ARENA_HEIGHT / 2,
    angle: 0,
    health: MONSTER_MAX_HEALTH,
    maxHealth: MONSTER_MAX_HEALTH,
    lastShot: Date.now()
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

  // Find nearest alive player
  let nearestPlayer = null;
  let nearestDistance = Infinity;

  for (const [playerId, player] of players.entries()) {
    if (player.isDead || player.isEliminated) continue;

    const dx = player.x - monsterTank.x;
    const dy = player.y - monsterTank.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPlayer = player;
    }
  }

  if (nearestPlayer) {
    // Rotate toward nearest player
    const targetAngle = Math.atan2(nearestPlayer.y - monsterTank.y, nearestPlayer.x - monsterTank.x);
    let angleDiff = targetAngle - monsterTank.angle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Turn slowly
    const turnRate = 0.05;
    if (Math.abs(angleDiff) > turnRate) {
      monsterTank.angle += Math.sign(angleDiff) * turnRate;
    } else {
      monsterTank.angle = targetAngle;
    }

    // Move toward player
    const oldX = monsterTank.x;
    const oldY = monsterTank.y;
    monsterTank.x += Math.cos(monsterTank.angle) * MONSTER_SPEED;
    monsterTank.y += Math.sin(monsterTank.angle) * MONSTER_SPEED;

    // Avoid obstacles and boundaries
    if (isPositionInsideObstacle(monsterTank.x, monsterTank.y, MONSTER_SIZE / 2) ||
        monsterTank.x < MONSTER_SIZE / 2 || monsterTank.x > ARENA_WIDTH - MONSTER_SIZE / 2 ||
        monsterTank.y < MONSTER_SIZE / 2 || monsterTank.y > ARENA_HEIGHT - MONSTER_SIZE / 2) {
      // Revert position and try different angle
      monsterTank.x = oldX;
      monsterTank.y = oldY;
      monsterTank.angle += Math.PI / 4; // Turn 45 degrees
    }

    // Shoot at player
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
    bullet.x += bullet.velocityX;
    bullet.y += bullet.velocityY;

    // Check if out of bounds
    if (bullet.x < 0 || bullet.x > ARENA_WIDTH || bullet.y < 0 || bullet.y > ARENA_HEIGHT) {
      monsterBullets.splice(i, 1);
      continue;
    }

    // Check if hit obstacle
    if (isPositionInsideObstacle(bullet.x, bullet.y, 4)) {
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

        // Check shield
        const hasShield = player.activePowerups && player.activePowerups.shield && Date.now() < player.activePowerups.shield;
        if (hasShield) {
          io.emit('shieldBlocked', { playerId: playerId, shooterId: 'monster' });
          break;
        }

        player.lives -= 1;

        io.emit('playerHit', {
          playerId: playerId,
          lives: player.lives,
          killerId: 'monster',
          kills: 0
        });

        if (player.lives <= 0) {
          player.isDead = true;
          player.respawnsUsed += 1;

          io.emit('playerDied', {
            playerId: playerId,
            killerId: 'monster'
          });

          if (player.respawnsUsed < player.maxLives) {
            const timerId = setTimeout(() => {
              const p = players.get(playerId);
              if (p && p.isDead) {
                const spawnPos = getRandomSpawnPosition();
                p.x = spawnPos.x;
                p.y = spawnPos.y;
                p.angle = 0;
                p.lives = 1;
                p.isDead = false;

                io.emit('playerRespawned', {
                  playerId: p.id,
                  x: p.x,
                  y: p.y,
                  angle: p.angle,
                  lives: p.lives,
                  respawnsUsed: p.respawnsUsed
                });
              }
              respawnTimers.delete(playerId);
            }, 3000);

            respawnTimers.set(playerId, timerId);
          } else {
            player.isEliminated = true;
            io.emit('playerEliminated', {
              playerId: playerId,
              killerId: 'monster'
            });
          }
        }
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
    // Check max players
    if (players.size >= MAX_PLAYERS) {
      socket.emit('error', 'Game is full');
      return;
    }

    const spawnPos = getRandomSpawnPosition();
    const player = {
      id: socket.id,
      name: playerName || `Player ${players.size + 1}`,
      x: spawnPos.x,
      y: spawnPos.y,
      angle: 0,
      color: getAvailableColor(),
      lives: 3,
      maxLives: 3,
      respawnsUsed: 0,
      kills: 0,
      isEliminated: false,
      isDead: false,
      activePowerups: {}
    };

    players.set(socket.id, player);

    // Send current player their info
    socket.emit('joined', player);

    // Send obstacles to the new player
    socket.emit('obstacles', OBSTACLES);

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
    // If player has phase, allow out-of-bounds positions (they wrap on client)
    if (hasPhase) {
      if (data.x !== undefined) player.x = data.x;
      if (data.y !== undefined) player.y = data.y;
    } else {
      if (data.x !== undefined) player.x = Math.max(0, Math.min(ARENA_WIDTH, data.x));
      if (data.y !== undefined) player.y = Math.max(0, Math.min(ARENA_HEIGHT, data.y));
    }
    if (data.angle !== undefined) player.angle = data.angle;

    // Check for mine collision (all mines except own)
    for (const [mineId, mine] of mines.entries()) {
      if (mine.playerId !== socket.id) {
        const dx = player.x - mine.x;
        const dy = player.y - mine.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 30) {
          // Mine triggered!
          mines.delete(mineId);

          // Apply damage to player
          player.lives -= 1;
          const mineOwner = players.get(mine.playerId);
          if (mineOwner) {
            mineOwner.kills += 1;
          }

          io.emit('mineExploded', {
            mineId: mineId,
            victimId: player.id,
            x: mine.x,
            y: mine.y
          });

          io.emit('playerHit', {
            playerId: player.id,
            lives: player.lives,
            killerId: mine.playerId,
            kills: mineOwner ? mineOwner.kills : 0
          });

          if (player.lives <= 0) {
            player.isDead = true;
            player.respawnsUsed += 1;

            io.emit('playerDied', {
              playerId: player.id,
              killerId: mine.playerId
            });

            // Check if player has respawns remaining
            if (player.respawnsUsed < player.maxLives) {
              const timerId = setTimeout(() => {
                const p = players.get(player.id);
                if (p && p.isDead) {
                  const spawnPos = getRandomSpawnPosition();
                  p.x = spawnPos.x;
                  p.y = spawnPos.y;
                  p.angle = 0;
                  p.lives = 1;
                  p.isDead = false;

                  io.emit('playerRespawned', {
                    playerId: p.id,
                    x: p.x,
                    y: p.y,
                    angle: p.angle,
                    lives: p.lives,
                    respawnsUsed: p.respawnsUsed
                  });
                }
                respawnTimers.delete(player.id);
              }, 3000);

              respawnTimers.set(player.id, timerId);
            } else {
              player.isEliminated = true;
              io.emit('playerEliminated', {
                playerId: player.id,
                killerId: mine.playerId
              });
            }
          }

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
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead || shooter.isEliminated) return;

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
        // Check if player has active shield
        const hasShield = hitPlayer.activePowerups &&
                         hitPlayer.activePowerups.shield &&
                         Date.now() < hitPlayer.activePowerups.shield;

        if (hasShield) {
          // Shield blocks the hit - emit shield blocked event
          io.emit('shieldBlocked', {
            playerId: hitPlayer.id,
            shooterId: shooter.id
          });
          console.log(`Shield blocked hit on player ${hitPlayer.name}`);
          return; // Don't process the hit
        }

        hitPlayer.lives -= 1;
        shooter.kills += 1;

        io.emit('playerHit', {
          playerId: hitPlayer.id,
          lives: hitPlayer.lives,
          killerId: shooter.id,
          kills: shooter.kills
        });

        if (hitPlayer.lives <= 0) {
          hitPlayer.isDead = true;
          hitPlayer.respawnsUsed += 1;

          io.emit('playerDied', {
            playerId: hitPlayer.id,
            killerId: shooter.id
          });

          // Check if player has respawns remaining (3 lives = 3 deaths before elimination)
          if (hitPlayer.respawnsUsed < hitPlayer.maxLives) {
            // Start 3-second respawn timer
            const timerId = setTimeout(() => {
              const player = players.get(hitPlayer.id);
              if (player && player.isDead) {
                // Respawn player at random position
                const spawnPos = getRandomSpawnPosition();
                player.x = spawnPos.x;
                player.y = spawnPos.y;
                player.angle = 0;
                player.lives = 1;
                player.isDead = false;

                io.emit('playerRespawned', {
                  playerId: player.id,
                  x: player.x,
                  y: player.y,
                  angle: player.angle,
                  lives: player.lives,
                  respawnsUsed: player.respawnsUsed
                });

                console.log(`Player ${player.name} respawned (${player.respawnsUsed}/${player.maxLives} deaths)`);
              }
              respawnTimers.delete(hitPlayer.id);
            }, 3000);

            respawnTimers.set(hitPlayer.id, timerId);
            console.log(`Player ${hitPlayer.name} will respawn in 3 seconds (${hitPlayer.respawnsUsed}/${hitPlayer.maxLives} deaths)`);
          } else {
            // Player is eliminated
            hitPlayer.isEliminated = true;
            io.emit('playerEliminated', {
              playerId: hitPlayer.id,
              killerId: shooter.id
            });
            console.log(`Player ${hitPlayer.name} eliminated`);
          }
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

  // Handle heat seeking missile
  socket.on('heatseeker', (data) => {
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

    if (distance < 40) {
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

      // Clear any pending respawn timer
      if (respawnTimers.has(socket.id)) {
        clearTimeout(respawnTimers.get(socket.id));
        respawnTimers.delete(socket.id);
      }

      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
    }
  });

  // Handle explicit leave
  socket.on('leave', () => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`Player ${player.name} left the game`);

      // Clear any pending respawn timer
      if (respawnTimers.has(socket.id)) {
        clearTimeout(respawnTimers.get(socket.id));
        respawnTimers.delete(socket.id);
      }

      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
    }
  });
});

// Broadcast game state at 60fps
setInterval(() => {
  if (players.size > 0) {
    io.emit('gameState', Array.from(players.values()));
  }
}, 1000 / 60);

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

    // Find nearest alive enemy
    let nearestEnemy = null;
    let nearestDistance = Infinity;

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
      }
    }

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

      if (distance < 25) {
        // Hit!
        heatseekers.delete(id);

        // Check if player has active shield
        const hasShield = nearestEnemy.activePowerups &&
                         nearestEnemy.activePowerups.shield &&
                         Date.now() < nearestEnemy.activePowerups.shield;

        if (hasShield) {
          io.emit('shieldBlocked', {
            playerId: nearestEnemy.id,
            shooterId: heatseeker.shooterId
          });
          io.emit('heatseekerExpired', id);
          continue;
        }

        nearestEnemy.lives -= 1;
        const shooter = players.get(heatseeker.shooterId);
        if (shooter) {
          shooter.kills += 1;
        }

        io.emit('heatseekerHit', {
          heatseekerId: id,
          playerId: nearestEnemy.id
        });

        io.emit('playerHit', {
          playerId: nearestEnemy.id,
          lives: nearestEnemy.lives,
          killerId: heatseeker.shooterId,
          kills: shooter ? shooter.kills : 0
        });

        if (nearestEnemy.lives <= 0) {
          nearestEnemy.isDead = true;
          nearestEnemy.respawnsUsed += 1;

          io.emit('playerDied', {
            playerId: nearestEnemy.id,
            killerId: heatseeker.shooterId
          });

          // Check if player has respawns remaining
          if (nearestEnemy.respawnsUsed < nearestEnemy.maxLives) {
            const timerId = setTimeout(() => {
              const player = players.get(nearestEnemy.id);
              if (player && player.isDead) {
                const spawnPos = getRandomSpawnPosition();
                player.x = spawnPos.x;
                player.y = spawnPos.y;
                player.angle = 0;
                player.lives = 1;
                player.isDead = false;

                io.emit('playerRespawned', {
                  playerId: player.id,
                  x: player.x,
                  y: player.y,
                  angle: player.angle,
                  lives: player.lives,
                  respawnsUsed: player.respawnsUsed
                });
              }
              respawnTimers.delete(nearestEnemy.id);
            }, 3000);

            respawnTimers.set(nearestEnemy.id, timerId);
          } else {
            nearestEnemy.isEliminated = true;
            io.emit('playerEliminated', {
              playerId: nearestEnemy.id,
              killerId: heatseeker.shooterId
            });
          }
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

// Schedule monster tank spawns every 2 minutes
setInterval(() => {
  spawnMonster();
}, MONSTER_SPAWN_INTERVAL);

// Spawn first monster after 2 minutes
setTimeout(() => {
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
