// Connect to Socket.io server
const socket = io();

// Canvas setup
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const playerCountEl = document.getElementById('playerCount');

// Name screen elements
const nameScreen = document.getElementById('nameScreen');
const nameInput = document.getElementById('nameInput');
const startButton = document.getElementById('startButton');

// Track if player has joined
let hasJoined = false;

// Sound Manager using Web Audio API
const SoundManager = {
    audioContext: null,
    isInitialized: false,
    engineOscillator: null,
    engineGain: null,
    isEngineRunning: false,

    // Initialize AudioContext on first user interaction
    init() {
        if (this.isInitialized) return;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.isInitialized = true;
            console.log('Audio initialized');
        } catch (e) {
            console.error('Web Audio API not supported', e);
        }
    },

    // Shooting sound - quick frequency sweep
    playShoot() {
        if (!this.isInitialized) return;

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        // Quick "pew" sound - frequency sweep from high to low
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(200, this.audioContext.currentTime + 0.1);

        // Volume envelope - quick fade out
        gainNode.gain.setValueAtTime(0.15, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);

        oscillator.start();
        oscillator.stop(this.audioContext.currentTime + 0.1);
    },

    // Explosion sound - noise + rumble
    playExplosion() {
        if (!this.isInitialized) return;

        const duration = 0.25;
        const currentTime = this.audioContext.currentTime;

        // Create noise using multiple oscillators
        const noiseOscillator = this.audioContext.createOscillator();
        const noiseGain = this.audioContext.createGain();
        const noiseFilter = this.audioContext.createBiquadFilter();

        noiseOscillator.type = 'sawtooth';
        noiseOscillator.frequency.setValueAtTime(100, currentTime);
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.setValueAtTime(1000, currentTime);
        noiseFilter.frequency.exponentialRampToValueAtTime(100, currentTime + duration);

        noiseOscillator.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.audioContext.destination);

        noiseGain.gain.setValueAtTime(0.2, currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, currentTime + duration);

        noiseOscillator.start(currentTime);
        noiseOscillator.stop(currentTime + duration);

        // Low frequency rumble
        const rumbleOscillator = this.audioContext.createOscillator();
        const rumbleGain = this.audioContext.createGain();

        rumbleOscillator.type = 'sine';
        rumbleOscillator.frequency.setValueAtTime(60, currentTime);
        rumbleOscillator.frequency.exponentialRampToValueAtTime(30, currentTime + duration);

        rumbleOscillator.connect(rumbleGain);
        rumbleGain.connect(this.audioContext.destination);

        rumbleGain.gain.setValueAtTime(0.25, currentTime);
        rumbleGain.gain.exponentialRampToValueAtTime(0.01, currentTime + duration);

        rumbleOscillator.start(currentTime);
        rumbleOscillator.stop(currentTime + duration);
    },

    // Start engine sound - continuous hum
    startEngine() {
        if (!this.isInitialized || this.isEngineRunning) return;

        this.engineOscillator = this.audioContext.createOscillator();
        this.engineGain = this.audioContext.createGain();

        this.engineOscillator.type = 'triangle';
        this.engineOscillator.frequency.setValueAtTime(80, this.audioContext.currentTime);

        this.engineOscillator.connect(this.engineGain);
        this.engineGain.connect(this.audioContext.destination);

        // Subtle volume
        this.engineGain.gain.setValueAtTime(0, this.audioContext.currentTime);
        this.engineGain.gain.linearRampToValueAtTime(0.08, this.audioContext.currentTime + 0.1);

        this.engineOscillator.start();
        this.isEngineRunning = true;
    },

    // Stop engine sound
    stopEngine() {
        if (!this.isInitialized || !this.isEngineRunning) return;

        if (this.engineGain && this.engineOscillator) {
            this.engineGain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
            this.engineOscillator.stop(this.audioContext.currentTime + 0.1);
            this.isEngineRunning = false;
        }
    },

    // Shield deflect sound - high pitched ping
    playDeflect() {
        if (!this.isInitialized) return;

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        // High pitched "ping" sound
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1200, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.15);

        // Volume envelope
        gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);

        oscillator.start();
        oscillator.stop(this.audioContext.currentTime + 0.15);
    }
};

// Game constants
const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const TANK_WIDTH = 30;
const TANK_HEIGHT = 20;
const TANK_SPEED = 3;
const BULLET_SPEED = 8;
const BULLET_RADIUS = 4;
const COLLISION_DISTANCE = 20;
const NORMAL_FIRE_RATE = 500; // 500ms between shots
const RAPID_FIRE_RATE = 80;   // 80ms between shots for machine gun

// Local player state
let localPlayer = {
    id: null,
    x: ARENA_WIDTH / 2,
    y: ARENA_HEIGHT / 2,
    angle: 0,
    color: '#4CAF50',
    isDead: false,
    isEliminated: false,
    lives: 3,
    respawnTime: 0,
    activePowerups: {},
    lastShotTime: 0
};

// All players state
let players = {};

// Bullets state
let bullets = [];

// Obstacles (will be received from server)
let obstacles = [];

// Power-ups state
let powerups = [];

// Mines state
let mines = [];

// Heat seeking missiles state
let heatseekers = [];

// Monster Tank state
let monsterTank = null; // {x, y, angle, health, maxHealth}
let monsterBullets = [];
let monsterAnnouncement = null; // {text, time}

// Game timer state
let gameTimeRemaining = 0;

// Game over state
let gameOverData = null; // {rankings: [], showTime: timestamp}

// Keyboard input state
const keys = {
    w: false,
    a: false,
    s: false,
    d: false
};

// Handle keyboard input
document.addEventListener('keydown', (e) => {
    // Don't capture keys if player hasn't joined yet (typing name)
    if (!hasJoined) return;

    // Initialize audio on first user interaction
    if (!SoundManager.isInitialized) {
        SoundManager.init();
    }

    if (localPlayer.isDead || localPlayer.isEliminated) return;

    const key = e.key.toLowerCase();
    if (key in keys) {
        keys[key] = true;
        e.preventDefault();
    }
});

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key in keys) {
        keys[key] = false;
        e.preventDefault();
    }
    // Handle shooting with SPACE key
    if (e.key === ' ') {
        shootBullet();
        e.preventDefault();
    }
    // Handle landmine placement with 'E' key
    if (key === 'e') {
        placeLandmine();
        e.preventDefault();
    }
});

// Handle shooting with mouse click
canvas.addEventListener('click', () => {
    // Check if game over modal is showing
    if (gameOverData) {
        const elapsed = Date.now() - gameOverData.showTime;
        // Only allow dismissal after showing for at least 1 second
        if (elapsed > 1000) {
            gameOverData = null;
        }
        return;
    }

    // Initialize audio on first user interaction
    if (!SoundManager.isInitialized) {
        SoundManager.init();
    }
    shootBullet();
});

// Handle start button click
startButton.addEventListener('click', () => {
    startGame();
});

// Handle Enter key in name input
nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        startGame();
    }
});

// Start game function
function startGame() {
    if (hasJoined) return;

    // Get player name from input, default to "Player" if empty
    const playerName = nameInput.value.trim() || 'Player';

    // Initialize audio on user interaction
    SoundManager.init();

    // Hide name screen
    nameScreen.style.display = 'none';

    // Join the game
    socket.emit('join', playerName);
    hasJoined = true;
}

// Socket event listeners
socket.on('connect', () => {
    console.log('Connected to server');
    // Don't auto-join anymore - wait for user to click Start Game
});

// Handle joined event - server assigns id, position, color
socket.on('joined', (playerData) => {
    console.log('Joined game as:', playerData);
    localPlayer.id = playerData.id;
    localPlayer.x = playerData.x;
    localPlayer.y = playerData.y;
    localPlayer.angle = playerData.angle;
    localPlayer.color = playerData.color;
    localPlayer.lives = playerData.lives || 3;
    localPlayer.isDead = playerData.isDead || false;
    localPlayer.isEliminated = playerData.isEliminated || false;
});

// Handle obstacles event - receive obstacles from server
socket.on('obstacles', (obstaclesData) => {
    console.log('Received obstacles:', obstaclesData);
    obstacles = obstaclesData;
});

// Handle power-ups state - receive existing power-ups when joining
socket.on('powerupsState', (powerupsData) => {
    console.log('Received power-ups:', powerupsData);
    powerups = powerupsData;
});

// Handle power-up spawned event
socket.on('powerupSpawned', (powerup) => {
    console.log('Power-up spawned:', powerup);
    powerups.push(powerup);
});

// Handle power-up collected event
socket.on('powerupCollected', (data) => {
    console.log('Power-up collected:', data);
    // Remove from local power-ups array
    powerups = powerups.filter(p => p.id !== data.powerupId);

    // If local player collected it, add to active power-ups
    if (data.playerId === localPlayer.id) {
        localPlayer.activePowerups[data.powerupType] = Date.now() + 10000;
    }
});

// Handle power-up expired event
socket.on('powerupExpired', (powerupId) => {
    console.log('Power-up expired:', powerupId);
    powerups = powerups.filter(p => p.id !== powerupId);
});

// Handle game state - server sends array of players
socket.on('gameState', (playersArray) => {
    // Convert array to object keyed by id
    const playersObj = {};
    for (const player of playersArray) {
        playersObj[player.id] = player;
    }
    players = playersObj;

    // Update player count
    const playerCount = Object.keys(players).length;
    playerCountEl.textContent = `Players: ${playerCount}/6`;
});

// Handle player moved event - real-time position updates
socket.on('playerMoved', (data) => {
    if (players[data.id]) {
        players[data.id].x = data.x;
        players[data.id].y = data.y;
        players[data.id].angle = data.angle;
    }
});

// Handle player left event - remove disconnected players
socket.on('playerLeft', (playerId) => {
    delete players[playerId];
    console.log('Player left:', playerId);
});

// Handle bullet fired event - add bullets from other players
socket.on('bulletFired', (bulletData) => {
    bullets.push(bulletData);
});

// Handle shield blocked event - show deflect effect
socket.on('shieldBlocked', (data) => {
    console.log('Shield blocked:', data);
    // Play deflect sound
    SoundManager.playDeflect();

    // Flash the shielded player briefly
    if (players[data.playerId]) {
        players[data.playerId].flashTime = Date.now();
    }
});

// Handle player hit event - show visual effect
socket.on('playerHit', (data) => {
    console.log('Player hit:', data);
    // Play explosion sound
    SoundManager.playExplosion();

    // Flash the hit player
    if (players[data.playerId]) {
        players[data.playerId].flashTime = Date.now();
        players[data.playerId].lives = data.lives;
    }
    // Update killer's score
    if (players[data.killerId]) {
        players[data.killerId].kills = data.kills;
    }
});

// Handle player died event - gray out dead player
socket.on('playerDied', (data) => {
    console.log('Player died:', data);
    if (players[data.playerId]) {
        players[data.playerId].isDead = true;
    }
    if (players[data.killerId]) {
        players[data.killerId].kills = data.kills;
    }

    // If local player died, start respawn countdown
    if (data.playerId === localPlayer.id) {
        localPlayer.isDead = true;
        localPlayer.respawnTime = Date.now() + 3000;
    }
});

// Handle player respawned event
socket.on('playerRespawned', (data) => {
    console.log('Player respawned:', data);
    if (players[data.playerId]) {
        players[data.playerId].x = data.x;
        players[data.playerId].y = data.y;
        players[data.playerId].angle = data.angle;
        players[data.playerId].lives = data.lives;
        players[data.playerId].isDead = false;
        players[data.playerId].respawnsUsed = data.respawnsUsed;
    }

    // If local player respawned
    if (data.playerId === localPlayer.id) {
        localPlayer.x = data.x;
        localPlayer.y = data.y;
        localPlayer.angle = data.angle;
        localPlayer.lives = data.lives;
        localPlayer.isDead = false;
        localPlayer.respawnTime = 0;
    }
});

// Handle player eliminated event
socket.on('playerEliminated', (data) => {
    console.log('Player eliminated:', data);
    if (players[data.playerId]) {
        players[data.playerId].isEliminated = true;
        players[data.playerId].isDead = true;
    }

    // If local player eliminated
    if (data.playerId === localPlayer.id) {
        localPlayer.isEliminated = true;
        localPlayer.isDead = true;
        localPlayer.respawnTime = 0;
    }
});

// Handle freeze bullet fired event
socket.on('freezeBulletFired', (bulletData) => {
    bullets.push({ ...bulletData, isFreeze: true });
});

// Handle player frozen event
socket.on('playerFrozen', (data) => {
    console.log('Player frozen:', data);
    if (players[data.playerId]) {
        players[data.playerId].frozenUntil = Date.now() + data.duration;
    }
    if (data.playerId === localPlayer.id) {
        localPlayer.frozenUntil = Date.now() + data.duration;
    }
});

// Handle mine placed event
socket.on('minePlaced', (mine) => {
    console.log('Mine placed:', mine);
    mines.push(mine);
});

// Handle mine exploded event
socket.on('mineExploded', (data) => {
    console.log('Mine exploded:', data);
    mines = mines.filter(m => m.id !== data.mineId);
    // Play explosion sound
    SoundManager.playExplosion();
});

// Handle mine expired event
socket.on('mineExpired', (mineId) => {
    console.log('Mine expired:', mineId);
    mines = mines.filter(m => m.id !== mineId);
});

// Handle heatseeker fired event
socket.on('heatseekerFired', (heatseeker) => {
    console.log('Heatseeker fired:', heatseeker);
    heatseekers.push(heatseeker);
});

// Handle heatseeker update event
socket.on('heatseekerUpdate', (data) => {
    const heatseeker = heatseekers.find(h => h.id === data.id);
    if (heatseeker) {
        heatseeker.x = data.x;
        heatseeker.y = data.y;
        heatseeker.angle = data.angle;
        heatseeker.targetId = data.targetId;
    }
});

// Handle heatseeker hit event
socket.on('heatseekerHit', (data) => {
    console.log('Heatseeker hit:', data);
    heatseekers = heatseekers.filter(h => h.id !== data.heatseekerId);
    // Play explosion sound
    SoundManager.playExplosion();
});

// Handle heatseeker expired event
socket.on('heatseekerExpired', (heatseekerId) => {
    console.log('Heatseeker expired:', heatseekerId);
    heatseekers = heatseekers.filter(h => h.id !== heatseekerId);
});

// Handle monster spawned event
socket.on('monsterSpawned', (data) => {
    console.log('Monster Tank spawned!', data);
    monsterTank = {
        x: data.x,
        y: data.y,
        angle: 0,
        health: data.health,
        maxHealth: data.maxHealth
    };
    // Show announcement
    monsterAnnouncement = {
        text: 'MONSTER TANK INCOMING!',
        time: Date.now()
    };
    SoundManager.playExplosion();
});

// Handle monster update event
socket.on('monsterUpdate', (data) => {
    if (monsterTank) {
        monsterTank.x = data.x;
        monsterTank.y = data.y;
        monsterTank.angle = data.angle;
        monsterTank.health = data.health;
    }
});

// Handle monster hit event
socket.on('monsterHit', (data) => {
    console.log('Monster hit!', data);
    if (monsterTank) {
        monsterTank.health = data.health;
        monsterTank.flashTime = Date.now();
    }
    SoundManager.playExplosion();
});

// Handle monster destroyed event
socket.on('monsterDestroyed', (data) => {
    console.log('Monster destroyed by:', data.killerId);
    monsterTank = null;
    monsterBullets = [];
    SoundManager.playExplosion();
    SoundManager.playExplosion();
});

// Handle monster bullet fired event
socket.on('monsterBulletFired', (bullet) => {
    monsterBullets.push(bullet);
});

// Handle game timer event
socket.on('gameTimer', (remaining) => {
    gameTimeRemaining = remaining;
});

// Handle game over event
socket.on('gameOver', (rankings) => {
    console.log('Game over! Rankings:', rankings);
    gameOverData = {
        rankings: rankings,
        showTime: Date.now()
    };
    SoundManager.playExplosion();
    SoundManager.playExplosion();
});

// Helper function to check if position collides with obstacles
function isPositionInsideObstacle(x, y, radius = TANK_WIDTH / 2) {
    for (const obstacle of obstacles) {
        if (x + radius > obstacle.x &&
            x - radius < obstacle.x + obstacle.width &&
            y + radius > obstacle.y &&
            y - radius < obstacle.y + obstacle.height) {
            return true;
        }
    }
    return false;
}

// Game logic
function updatePlayer() {
    // Don't allow movement if dead or eliminated
    if (localPlayer.isDead || localPlayer.isEliminated) return;

    // Don't allow movement if frozen
    if (localPlayer.frozenUntil && Date.now() < localPlayer.frozenUntil) {
        return;
    }

    let dx = 0;
    let dy = 0;

    // Calculate movement direction
    if (keys.w) dy -= 1;
    if (keys.s) dy += 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;

    // Handle engine sound based on movement
    const isMoving = (dx !== 0 || dy !== 0);
    if (isMoving && !SoundManager.isEngineRunning) {
        SoundManager.startEngine();
    } else if (!isMoving && SoundManager.isEngineRunning) {
        SoundManager.stopEngine();
    }

    // If moving, update position and angle
    if (dx !== 0 || dy !== 0) {
        // Normalize diagonal movement
        const length = Math.sqrt(dx * dx + dy * dy);
        let speed = TANK_SPEED;

        // Check if player has active speed power-up
        if (localPlayer.activePowerups.speed && Date.now() < localPlayer.activePowerups.speed) {
            speed *= 1.5;
        }

        dx = (dx / length) * speed;
        dy = (dy / length) * speed;

        // Store old position
        const oldX = localPlayer.x;
        const oldY = localPlayer.y;

        // Update position
        localPlayer.x += dx;
        localPlayer.y += dy;

        // Check if player has active phase power-up
        const hasPhase = localPlayer.activePowerups.phase &&
                        Date.now() < localPlayer.activePowerups.phase;

        if (hasPhase) {
            // Phase power-up: wrap around edges instead of clamping
            if (localPlayer.x < 0) {
                localPlayer.x = ARENA_WIDTH;
            } else if (localPlayer.x > ARENA_WIDTH) {
                localPlayer.x = 0;
            }

            if (localPlayer.y < 0) {
                localPlayer.y = ARENA_HEIGHT;
            } else if (localPlayer.y > ARENA_HEIGHT) {
                localPlayer.y = 0;
            }
        } else {
            // Normal: keep tank inside bounds
            localPlayer.x = Math.max(TANK_WIDTH / 2, Math.min(ARENA_WIDTH - TANK_WIDTH / 2, localPlayer.x));
            localPlayer.y = Math.max(TANK_HEIGHT / 2, Math.min(ARENA_HEIGHT - TANK_HEIGHT / 2, localPlayer.y));
        }

        // Check collision with obstacles (unless phasing allows ghosting through)
        if (isPositionInsideObstacle(localPlayer.x, localPlayer.y)) {
            // Revert position if colliding
            localPlayer.x = oldX;
            localPlayer.y = oldY;
        } else {
            // Update angle to face movement direction
            localPlayer.angle = Math.atan2(dy, dx);

            // Emit move event
            socket.emit('move', {
                x: localPlayer.x,
                y: localPlayer.y,
                angle: localPlayer.angle
            });
        }
    }
}

// Shooting function
function shootBullet() {
    if (!localPlayer.id || localPlayer.isDead || localPlayer.isEliminated) return;

    // Check fire rate based on machine gun power-up
    const now = Date.now();
    const hasMachineGun = localPlayer.activePowerups.machinegun &&
                         now < localPlayer.activePowerups.machinegun;
    const fireRate = hasMachineGun ? RAPID_FIRE_RATE : NORMAL_FIRE_RATE;

    // Check if enough time has passed since last shot
    if (now - localPlayer.lastShotTime < fireRate) {
        return; // Too soon to shoot again
    }

    // Update last shot time
    localPlayer.lastShotTime = now;

    // Play shooting sound
    SoundManager.playShoot();

    // Calculate barrel tip position
    const barrelLength = TANK_WIDTH / 2 + 10;
    const bulletX = localPlayer.x + Math.cos(localPlayer.angle) * barrelLength;
    const bulletY = localPlayer.y + Math.sin(localPlayer.angle) * barrelLength;

    // Calculate bullet velocity
    const velocityX = Math.cos(localPlayer.angle) * BULLET_SPEED;
    const velocityY = Math.sin(localPlayer.angle) * BULLET_SPEED;

    // Check if player has freeze power-up active
    if (localPlayer.activePowerups.freeze && now < localPlayer.activePowerups.freeze) {
        // Fire freeze bullet instead
        const freezeBullet = {
            x: bulletX,
            y: bulletY,
            angle: localPlayer.angle,
            velocityX: velocityX,
            velocityY: velocityY,
            shooterId: localPlayer.id,
            isFreeze: true
        };

        bullets.push(freezeBullet);
        socket.emit('freezeBullet', freezeBullet);

        // Remove freeze power-up
        delete localPlayer.activePowerups.freeze;
        return;
    }

    // Check if player has heatseeker power-up active
    if (localPlayer.activePowerups.heatseeker && now < localPlayer.activePowerups.heatseeker) {
        // Fire heatseeker instead
        socket.emit('heatseeker', {
            x: bulletX,
            y: bulletY,
            angle: localPlayer.angle
        });

        // Remove heatseeker power-up
        delete localPlayer.activePowerups.heatseeker;
        return;
    }

    // Create bullet object
    const bullet = {
        x: bulletX,
        y: bulletY,
        angle: localPlayer.angle,
        velocityX: velocityX,
        velocityY: velocityY,
        shooterId: localPlayer.id
    };

    // Add to local bullets array
    bullets.push(bullet);

    // Emit to server
    socket.emit('shoot', bullet);
}

// Landmine placement function
function placeLandmine() {
    if (!localPlayer.id || localPlayer.isDead || localPlayer.isEliminated) return;

    const now = Date.now();

    // Check if player has landmine power-up active
    if (localPlayer.activePowerups.landmine && now < localPlayer.activePowerups.landmine) {
        // Place mine at current position
        socket.emit('placeMine', {
            x: localPlayer.x,
            y: localPlayer.y
        });

        // Remove landmine power-up
        delete localPlayer.activePowerups.landmine;

        console.log('Landmine placed!');
    }
}

// Helper function to check if bullet collides with obstacles
function doesBulletHitObstacle(x, y) {
    for (const obstacle of obstacles) {
        if (x >= obstacle.x &&
            x <= obstacle.x + obstacle.width &&
            y >= obstacle.y &&
            y <= obstacle.y + obstacle.height) {
            return true;
        }
    }
    return false;
}

// Update monster bullets
function updateMonsterBullets() {
    for (let i = monsterBullets.length - 1; i >= 0; i--) {
        const bullet = monsterBullets[i];
        bullet.x += bullet.velocityX;
        bullet.y += bullet.velocityY;

        // Check if bullet is out of bounds
        if (bullet.x < 0 || bullet.x > ARENA_WIDTH ||
            bullet.y < 0 || bullet.y > ARENA_HEIGHT) {
            monsterBullets.splice(i, 1);
            continue;
        }

        // Check if bullet hit obstacle
        if (doesBulletHitObstacle(bullet.x, bullet.y)) {
            monsterBullets.splice(i, 1);
            continue;
        }
    }
}

// Update bullets
function updateBullets() {
    // Update bullet positions
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        bullet.x += bullet.velocityX;
        bullet.y += bullet.velocityY;

        // Check if bullet is out of bounds
        if (bullet.x < 0 || bullet.x > ARENA_WIDTH ||
            bullet.y < 0 || bullet.y > ARENA_HEIGHT) {
            bullets.splice(i, 1);
            continue;
        }

        // Check if bullet hit obstacle
        if (doesBulletHitObstacle(bullet.x, bullet.y)) {
            bullets.splice(i, 1);
            continue;
        }

        // Check collision with tanks (only check bullets shot by local player)
        if (bullet.shooterId === localPlayer.id) {
            // Check collision with monster tank
            if (monsterTank) {
                const dx = bullet.x - monsterTank.x;
                const dy = bullet.y - monsterTank.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 40) {
                    // Hit monster!
                    socket.emit('shootMonster', {
                        x: bullet.x,
                        y: bullet.y
                    });
                    bullets.splice(i, 1);
                    continue;
                }
            }

            for (const id in players) {
                // Skip if hitting own tank, dead player, or eliminated player
                if (id === bullet.shooterId || players[id].isDead || players[id].isEliminated) continue;

                const player = players[id];
                const dx = bullet.x - player.x;
                const dy = bullet.y - player.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Check if bullet hit tank
                if (distance < COLLISION_DISTANCE) {
                    // Check if it's a freeze bullet
                    if (bullet.isFreeze) {
                        socket.emit('freezeBullet', {
                            ...bullet,
                            hitPlayerId: id
                        });
                    } else {
                        // Emit hit event to server
                        socket.emit('shoot', {
                            ...bullet,
                            hitPlayerId: id
                        });
                    }
                    // Remove bullet
                    bullets.splice(i, 1);
                    break;
                }
            }
        }
    }
}

// Helper function to draw rounded rectangles
function roundRect(ctx, x, y, width, height, radius) {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
}

// Helper function to create darker/lighter shade of a color
function shadeColor(color, percent) {
    const num = parseInt(color.replace("#", ""), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.max(0, Math.min(255, (num >> 16) + amt));
    const G = Math.max(0, Math.min(255, (num >> 8 & 0x00FF) + amt));
    const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
    return "#" + (0x1000000 + (R << 16) + (G << 8) + B).toString(16).slice(1);
}

// Drawing functions
function drawTank(x, y, angle, color, isLocal = false, isDead = false, isEliminated = false, flashTime = 0, lives = 3) {
    // Don't render local player's tank until they've joined
    if (isLocal && !hasJoined) return;

    // Check for flicker effect if power-up expires soon
    let shouldFlicker = false;
    if (isLocal && !isDead && !isEliminated) {
        const now = Date.now();
        for (const type in localPlayer.activePowerups) {
            const expiresAt = localPlayer.activePowerups[type];
            if (expiresAt - now < 3000 && expiresAt - now > 0) {
                // Flicker every 150ms in last 3 seconds
                shouldFlicker = Math.floor(now / 150) % 2 === 0;
                break;
            }
        }
    }

    // Don't draw if flickering
    if (shouldFlicker) return;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Apply flash effect if recently hit (within 200ms)
    const isFlashing = Date.now() - flashTime < 200;

    // Apply gray out effect if dead or eliminated
    if (isDead || isEliminated) {
        ctx.globalAlpha = 0.3;
    } else if (isFlashing) {
        ctx.globalAlpha = 0.5;
    }

    // Determine colors
    const bodyColor = (isDead || isEliminated) ? '#666' : color;
    const darkColor = (isDead || isEliminated) ? '#444' : shadeColor(color, -40);
    const outlineColor = isLocal ? '#fff' : '#000';
    const outlineWidth = isLocal ? 2.5 : 1.5;

    // Draw tank treads (left)
    ctx.fillStyle = darkColor;
    ctx.fillRect(-TANK_WIDTH / 2 - 2, -TANK_HEIGHT / 2 - 3, 4, TANK_HEIGHT + 6);

    // Draw tank treads (right)
    ctx.fillRect(TANK_WIDTH / 2 - 2, -TANK_HEIGHT / 2 - 3, 4, TANK_HEIGHT + 6);

    // Draw main tank body (rounded rectangle)
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    roundRect(ctx, -TANK_WIDTH / 2, -TANK_HEIGHT / 2, TANK_WIDTH, TANK_HEIGHT, 3);
    ctx.fill();

    // Draw body outline
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.beginPath();
    roundRect(ctx, -TANK_WIDTH / 2, -TANK_HEIGHT / 2, TANK_WIDTH, TANK_HEIGHT, 3);
    ctx.stroke();

    // Draw turret (circular)
    const turretRadius = 7;
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.fill();

    // Draw turret outline
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw barrel/cannon (thick rectangle extending from turret)
    const barrelLength = 14;
    const barrelWidth = 4;
    ctx.fillStyle = darkColor;
    ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);

    // Draw barrel outline
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.strokeRect(0, -barrelWidth / 2, barrelLength, barrelWidth);

    ctx.restore();

    // Draw power-up effects for local player
    if (isLocal && !isDead && !isEliminated) {
        const now = Date.now();

        // Draw shield effect - blue glowing ring
        if (localPlayer.activePowerups.shield && now < localPlayer.activePowerups.shield) {
            ctx.save();
            const pulsePhase = (now % 500) / 500;
            const ringRadius = 25 + Math.sin(pulsePhase * Math.PI * 2) * 3;

            // Outer glow
            const gradient = ctx.createRadialGradient(x, y, ringRadius - 5, x, y, ringRadius + 5);
            gradient.addColorStop(0, 'rgba(100, 150, 255, 0)');
            gradient.addColorStop(0.5, 'rgba(100, 150, 255, 0.6)');
            gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 8;
            ctx.beginPath();
            ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
            ctx.stroke();

            // Inner ring
            ctx.strokeStyle = 'rgba(100, 150, 255, 0.8)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Draw phase effect - purple tint and semi-transparency
        if (localPlayer.activePowerups.phase && now < localPlayer.activePowerups.phase) {
            ctx.save();
            const pulsePhase = (now % 600) / 600;
            const alpha = 0.3 + Math.sin(pulsePhase * Math.PI * 2) * 0.15;

            // Purple glow around tank
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, 35);
            gradient.addColorStop(0, `rgba(180, 100, 255, ${alpha})`);
            gradient.addColorStop(1, 'rgba(180, 100, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, 35, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Draw speed effect - green speed lines trailing behind tank
        if (localPlayer.activePowerups.speed && now < localPlayer.activePowerups.speed) {
            ctx.save();
            const pulsePhase = (now % 400) / 400;

            // Draw motion lines behind the tank
            ctx.translate(x, y);
            ctx.rotate(angle);

            for (let i = 0; i < 3; i++) {
                const offset = -15 - (i * 8) - (pulsePhase * 8);
                const alpha = 0.6 - (i * 0.2) - pulsePhase;
                const lineLength = 12 - (i * 2);

                if (alpha > 0) {
                    ctx.strokeStyle = `rgba(50, 255, 50, ${alpha})`;
                    ctx.lineWidth = 3 - i;
                    ctx.beginPath();
                    ctx.moveTo(offset, -5);
                    ctx.lineTo(offset - lineLength, -5);
                    ctx.moveTo(offset, 5);
                    ctx.lineTo(offset - lineLength, 5);
                    ctx.stroke();
                }
            }

            ctx.restore();
        }
    }

    // Draw eliminated text above tank
    if (isEliminated) {
        ctx.fillStyle = '#ff0000';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('ELIMINATED', x, y - 25);
    }

    // Draw frozen effect if player is frozen
    const player = isLocal ? localPlayer : players[Object.keys(players).find(id => players[id].x === x && players[id].y === y)];
    if (player && player.frozenUntil && Date.now() < player.frozenUntil) {
        // Draw cyan ice tint over tank
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#00FFFF';
        ctx.beginPath();
        ctx.arc(x, y, TANK_WIDTH / 2 + 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Draw frozen timer above tank
        const timeLeft = Math.ceil((player.frozenUntil - Date.now()) / 1000);
        ctx.fillStyle = '#00FFFF';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`FROZEN ${timeLeft}s`, x, y - 30);
    } else {
        // Draw lives indicator for local player if not frozen
        if (isLocal && !isEliminated && !isDead) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`Lives: ${lives}`, x, y - 25);
        }
    }
}

function drawBullet(x, y, isFreeze = false) {
    if (isFreeze) {
        // Draw freeze bullet as cyan/light blue and larger
        ctx.fillStyle = '#00FFFF';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, BULLET_RADIUS * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    } else {
        // Normal bullet
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, BULLET_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawMine(mine) {
    const x = mine.x;
    const y = mine.y;
    const size = 12;

    // Draw mine as orange/red circle
    ctx.fillStyle = '#FF6600';
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw spikes
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI / 2);
        const x1 = x + Math.cos(angle) * size;
        const y1 = y + Math.sin(angle) * size;
        const x2 = x + Math.cos(angle) * (size + 4);
        const y2 = y + Math.sin(angle) * (size + 4);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }
}

function drawHeatseeker(heatseeker) {
    const x = heatseeker.x;
    const y = heatseeker.y;
    const angle = heatseeker.angle;
    const size = 10;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Draw heatseeker as yellow/orange triangle
    ctx.fillStyle = '#FFCC00';
    ctx.strokeStyle = '#FF6600';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size, size / 2);
    ctx.lineTo(-size, -size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw flame trail
    ctx.fillStyle = '#FF6600';
    ctx.beginPath();
    ctx.arc(-size, 0, size / 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawMonsterTank() {
    if (!monsterTank) return;

    const x = monsterTank.x;
    const y = monsterTank.y;
    const angle = monsterTank.angle;
    const size = 60;

    // Apply flash effect if recently hit (within 200ms)
    const isFlashing = monsterTank.flashTime && Date.now() - monsterTank.flashTime < 200;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (isFlashing) {
        ctx.globalAlpha = 0.5;
    }

    // Monster color - dark red/maroon
    const bodyColor = '#8B0000';
    const darkColor = '#5A0000';

    // Draw larger treads
    ctx.fillStyle = darkColor;
    ctx.fillRect(-size / 2 - 4, -size / 2 - 6, 8, size + 12);
    ctx.fillRect(size / 2 - 4, -size / 2 - 6, 8, size + 12);

    // Draw main tank body
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    roundRect(ctx, -size / 2, -size / 2, size, size * 0.66, 5);
    ctx.fill();

    // Draw body outline
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    roundRect(ctx, -size / 2, -size / 2, size, size * 0.66, 5);
    ctx.stroke();

    // Draw spikes for menacing look
    ctx.fillStyle = '#FF0000';
    for (let i = 0; i < 4; i++) {
        const spikeAngle = (i * Math.PI / 2);
        const spikeX = Math.cos(spikeAngle) * (size / 3);
        const spikeY = Math.sin(spikeAngle) * (size / 3);
        ctx.beginPath();
        ctx.moveTo(spikeX, spikeY);
        ctx.lineTo(spikeX + Math.cos(spikeAngle) * 8, spikeY + Math.sin(spikeAngle) * 8);
        ctx.lineTo(spikeX + Math.cos(spikeAngle + 0.3) * 8, spikeY + Math.sin(spikeAngle + 0.3) * 8);
        ctx.closePath();
        ctx.fill();
    }

    // Draw turret (larger)
    const turretRadius = 14;
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw barrel (thicker)
    const barrelLength = 28;
    const barrelWidth = 8;
    ctx.fillStyle = darkColor;
    ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, -barrelWidth / 2, barrelLength, barrelWidth);

    ctx.restore();

    // Draw health bar above monster
    const barWidth = 80;
    const barHeight = 10;
    const barX = x - barWidth / 2;
    const barY = y - size / 2 - 20;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(barX - 2, barY - 2, barWidth + 4, barHeight + 4);

    // Health bar
    const healthPercent = monsterTank.health / monsterTank.maxHealth;
    ctx.fillStyle = healthPercent > 0.5 ? '#00FF00' : (healthPercent > 0.25 ? '#FFFF00' : '#FF0000');
    ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);

    // Border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barWidth, barHeight);

    // Health text
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`${monsterTank.health}/${monsterTank.maxHealth}`, x, barY - 5);

    // Draw "MONSTER" label
    ctx.fillStyle = '#FF0000';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('MONSTER BOSS', x, y + size / 2 + 15);
}

function drawObstacles() {
    ctx.fillStyle = '#4a4a4a';
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;

    for (const obstacle of obstacles) {
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
        ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
    }
}

function drawArenaBorder() {
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
}

function drawPowerup(powerup) {
    const x = powerup.x;
    const y = powerup.y;
    const size = 20;

    ctx.save();

    // Add pulsing glow effect
    const pulsePhase = (Date.now() % 1000) / 1000;
    const glowSize = size + Math.sin(pulsePhase * Math.PI * 2) * 3;

    // Draw glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowSize);

    switch(powerup.type) {
        case 'shield':
            gradient.addColorStop(0, 'rgba(100, 150, 255, 0.5)');
            gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw shield icon (blue circle)
            ctx.fillStyle = '#6496FF';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            break;

        case 'machinegun':
            gradient.addColorStop(0, 'rgba(255, 80, 80, 0.5)');
            gradient.addColorStop(1, 'rgba(255, 80, 80, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw machine gun icon (red square)
            ctx.fillStyle = '#FF5050';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            ctx.strokeRect(x - size / 2, y - size / 2, size, size);
            break;

        case 'phase':
            gradient.addColorStop(0, 'rgba(180, 100, 255, 0.5)');
            gradient.addColorStop(1, 'rgba(180, 100, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw phase icon (purple diamond)
            ctx.fillStyle = '#B464FF';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, y - size / 2);
            ctx.lineTo(x + size / 2, y);
            ctx.lineTo(x, y + size / 2);
            ctx.lineTo(x - size / 2, y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;

        case 'freeze':
            gradient.addColorStop(0, 'rgba(100, 255, 255, 0.5)');
            gradient.addColorStop(1, 'rgba(100, 255, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw freeze icon (cyan circle with snowflake pattern)
            ctx.fillStyle = '#64FFFF';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Add snowflake lines
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, y - size / 3);
            ctx.lineTo(x, y + size / 3);
            ctx.moveTo(x - size / 3, y);
            ctx.lineTo(x + size / 3, y);
            ctx.stroke();
            break;

        case 'landmine':
            gradient.addColorStop(0, 'rgba(255, 150, 50, 0.5)');
            gradient.addColorStop(1, 'rgba(255, 150, 50, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw landmine icon (orange triangle)
            ctx.fillStyle = '#FF9632';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x, y - size / 2);
            ctx.lineTo(x + size / 2, y + size / 2);
            ctx.lineTo(x - size / 2, y + size / 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;

        case 'heatseeker':
            gradient.addColorStop(0, 'rgba(255, 220, 50, 0.5)');
            gradient.addColorStop(1, 'rgba(255, 220, 50, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw heatseeker icon (yellow star)
            ctx.fillStyle = '#FFDC32';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const angle = (i * 2 * Math.PI / 5) - Math.PI / 2;
                const outerX = x + Math.cos(angle) * size / 2;
                const outerY = y + Math.sin(angle) * size / 2;
                const innerAngle = angle + Math.PI / 5;
                const innerX = x + Math.cos(innerAngle) * size / 4;
                const innerY = y + Math.sin(innerAngle) * size / 4;

                if (i === 0) {
                    ctx.moveTo(outerX, outerY);
                } else {
                    ctx.lineTo(outerX, outerY);
                }
                ctx.lineTo(innerX, innerY);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;

        case 'speed':
            gradient.addColorStop(0, 'rgba(50, 255, 50, 0.5)');
            gradient.addColorStop(1, 'rgba(50, 255, 50, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, glowSize, 0, Math.PI * 2);
            ctx.fill();

            // Draw speed icon (green lightning bolt)
            ctx.fillStyle = '#32FF32';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + size / 4, y - size / 2);
            ctx.lineTo(x - size / 6, y);
            ctx.lineTo(x + size / 6, y);
            ctx.lineTo(x - size / 4, y + size / 2);
            ctx.lineTo(x + size / 6, y + size / 8);
            ctx.lineTo(x - size / 8, y + size / 8);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;
    }

    ctx.restore();
}

function drawPowerupHUD() {
    if (!localPlayer.id) return;

    const now = Date.now();
    const padding = 10;
    const iconSize = 30;
    const startX = 10;
    const startY = ARENA_HEIGHT - 50;

    let index = 0;
    for (const type in localPlayer.activePowerups) {
        const expiresAt = localPlayer.activePowerups[type];
        const timeLeft = (expiresAt - now) / 1000;

        // Remove expired power-ups
        if (timeLeft <= 0) {
            delete localPlayer.activePowerups[type];
            continue;
        }

        const x = startX + index * (iconSize + padding);
        const y = startY;

        // Draw background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(x, y, iconSize, iconSize + 20);

        // Draw mini icon
        const miniPowerup = { type: type, x: x + iconSize / 2, y: y + iconSize / 2 };
        ctx.save();
        ctx.scale(0.7, 0.7);
        drawPowerup({ ...miniPowerup, x: miniPowerup.x / 0.7, y: miniPowerup.y / 0.7 });
        ctx.restore();

        // Draw countdown
        ctx.fillStyle = timeLeft < 3 ? '#ff0000' : '#fff';
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(Math.ceil(timeLeft) + 's', x + iconSize / 2, y + iconSize + 15);

        // Add instruction for landmine placement
        if (type === 'landmine') {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px Arial';
            ctx.fillText('Press E', x + iconSize / 2, y - 5);
        }

        index++;
    }
}

function drawScoreboard() {
    // Convert players object to array and sort by kills (highest first)
    const playerArray = Object.values(players).sort((a, b) => (b.kills || 0) - (a.kills || 0));

    if (playerArray.length === 0) return;

    // Scoreboard dimensions
    const padding = 10;
    const rowHeight = 25;
    const colorSquareSize = 15;
    const boardWidth = 200;
    const boardHeight = padding * 2 + rowHeight * (playerArray.length + 1);
    const boardX = ARENA_WIDTH - boardWidth - 10;
    const boardY = 10;

    // Draw semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(boardX, boardY, boardWidth, boardHeight);

    // Draw border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(boardX, boardY, boardWidth, boardHeight);

    // Draw header
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('LEADERBOARD', boardX + padding, boardY + padding + 12);

    // Draw each player row
    playerArray.forEach((player, index) => {
        const rowY = boardY + padding + rowHeight + 10 + (index * rowHeight);
        const isLocalPlayer = player.id === localPlayer.id;

        // Highlight local player's row
        if (isLocalPlayer) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.fillRect(boardX, rowY - 15, boardWidth, rowHeight);
        }

        // Draw color indicator square
        ctx.fillStyle = player.color;
        ctx.fillRect(boardX + padding, rowY - 10, colorSquareSize, colorSquareSize);

        // Draw player name
        ctx.fillStyle = '#fff';
        ctx.font = isLocalPlayer ? 'bold 12px Arial' : '12px Arial';
        ctx.textAlign = 'left';
        const playerName = player.name || `Player ${player.id.substring(0, 4)}`;
        ctx.fillText(playerName, boardX + padding + colorSquareSize + 8, rowY);

        // Draw kills
        ctx.textAlign = 'right';
        ctx.fillText(`${player.kills || 0}`, boardX + boardWidth - padding, rowY);
    });
}

function drawGameTimer() {
    if (gameTimeRemaining <= 0) return;

    // Convert milliseconds to MM:SS format
    const totalSeconds = Math.ceil(gameTimeRemaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Draw timer at top center of screen
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(ARENA_WIDTH / 2 - 60, 5, 120, 30);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(ARENA_WIDTH / 2 - 60, 5, 120, 30);

    // Change color if under 1 minute
    ctx.fillStyle = totalSeconds < 60 ? '#ff0000' : '#fff';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timeString, ARENA_WIDTH / 2, 20);
    ctx.restore();
}

function drawGameOver() {
    if (!gameOverData) return;

    const elapsed = Date.now() - gameOverData.showTime;

    // Auto-dismiss after 10 seconds
    if (elapsed > 10000) {
        gameOverData = null;
        return;
    }

    // Draw semi-transparent overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Draw modal background
    const modalWidth = 400;
    const modalHeight = 350;
    const modalX = ARENA_WIDTH / 2 - modalWidth / 2;
    const modalY = ARENA_HEIGHT / 2 - modalHeight / 2;

    ctx.fillStyle = 'rgba(40, 40, 40, 0.95)';
    ctx.fillRect(modalX, modalY, modalWidth, modalHeight);

    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 4;
    ctx.strokeRect(modalX, modalY, modalWidth, modalHeight);

    // Draw title
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', ARENA_WIDTH / 2, modalY + 50);

    // Draw rankings
    const rankings = gameOverData.rankings;
    const startY = modalY + 100;
    const rowHeight = 60;

    rankings.forEach((ranking, index) => {
        const y = startY + index * rowHeight;

        // Draw rank medal/circle
        let medalColor;
        let rankText;
        if (index === 0) {
            medalColor = '#FFD700'; // Gold
            rankText = '1st';
        } else if (index === 1) {
            medalColor = '#C0C0C0'; // Silver
            rankText = '2nd';
        } else {
            medalColor = '#CD7F32'; // Bronze
            rankText = '3rd';
        }

        ctx.fillStyle = medalColor;
        ctx.beginPath();
        ctx.arc(modalX + 50, y, 20, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(rankText, modalX + 50, y + 5);

        // Draw player name
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(ranking.name, modalX + 90, y + 5);

        // Draw kills
        ctx.textAlign = 'right';
        ctx.fillText(`${ranking.kills} kills`, modalX + modalWidth - 30, y + 5);
    });

    // Draw dismiss instruction
    ctx.fillStyle = '#aaa';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Click anywhere to dismiss', ARENA_WIDTH / 2, modalY + modalHeight - 20);
}

function render() {
    // Clear canvas
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    // Draw arena border
    drawArenaBorder();

    // Draw obstacles
    drawObstacles();

    // Draw power-ups
    for (const powerup of powerups) {
        drawPowerup(powerup);
    }

    // Draw mines
    for (const mine of mines) {
        drawMine(mine);
    }

    // Draw all players
    for (const id in players) {
        const player = players[id];
        const isLocal = id === localPlayer.id;
        drawTank(
            player.x,
            player.y,
            player.angle,
            player.color,
            isLocal,
            player.isDead || false,
            player.isEliminated || false,
            player.flashTime || 0,
            player.lives || 3
        );
    }

    // Draw all bullets
    for (const bullet of bullets) {
        drawBullet(bullet.x, bullet.y, bullet.isFreeze || false);
    }

    // Draw heat seeking missiles
    for (const heatseeker of heatseekers) {
        drawHeatseeker(heatseeker);
    }

    // Draw monster tank
    drawMonsterTank();

    // Draw monster bullets
    for (const bullet of monsterBullets) {
        drawBullet(bullet.x, bullet.y, false);
    }

    // Draw monster announcement
    if (monsterAnnouncement) {
        const elapsed = Date.now() - monsterAnnouncement.time;
        if (elapsed < 3000) {
            const alpha = elapsed < 2000 ? 1 : 1 - (elapsed - 2000) / 1000;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(ARENA_WIDTH / 2 - 200, 100, 400, 60);
            ctx.strokeStyle = '#FF0000';
            ctx.lineWidth = 4;
            ctx.strokeRect(ARENA_WIDTH / 2 - 200, 100, 400, 60);
            ctx.fillStyle = '#FF0000';
            ctx.font = 'bold 32px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(monsterAnnouncement.text, ARENA_WIDTH / 2, 130);
            ctx.restore();
        } else {
            monsterAnnouncement = null;
        }
    }

    // Draw power-up HUD
    drawPowerupHUD();

    // Draw scoreboard
    drawScoreboard();

    // Draw game timer
    drawGameTimer();

    // Draw game over modal
    drawGameOver();

    // Draw respawn countdown for local player
    if (localPlayer.isDead && localPlayer.respawnTime > 0 && !localPlayer.isEliminated) {
        const timeLeft = Math.ceil((localPlayer.respawnTime - Date.now()) / 1000);
        if (timeLeft > 0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 48px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`Respawning in ${timeLeft}...`, ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
        }
    }

    // Draw eliminated message for local player
    if (localPlayer.isEliminated) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
        ctx.fillStyle = '#ff0000';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ELIMINATED', ARENA_WIDTH / 2, ARENA_HEIGHT / 2 - 30);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px Arial';
        ctx.fillText('Spectating...', ARENA_WIDTH / 2, ARENA_HEIGHT / 2 + 30);
    }
}

// Game loop
function gameLoop() {
    updatePlayer();
    updateBullets();
    updateMonsterBullets();
    render();
    requestAnimationFrame(gameLoop);
}

// Start game loop
gameLoop();
