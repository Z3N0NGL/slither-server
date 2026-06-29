const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game State
const WORLD_WIDTH = 5000;
const WORLD_HEIGHT = 5000;
const BORDER_SIZE = 20;
let players = {};
let orbs = [];
const MAX_ORBS = 500;
const ORB_RADIUS = 8;

function createOrb() {
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: Math.random() * (WORLD_WIDTH - 200) + 100,
        y: Math.random() * (WORLD_HEIGHT - 200) + 100,
        radius: ORB_RADIUS,
        color: `hsl(${Math.random() * 360}, 70%, 55%)`,
        pulse: Math.random() * Math.PI * 2
    };
}

for (let i = 0; i < MAX_ORBS; i++) {
    orbs.push(createOrb());
}

setInterval(() => {
    while (orbs.length < MAX_ORBS) {
        orbs.push(createOrb());
    }
}, 1000);

// Fast game loop (60fps for smooth movement)
setInterval(() => {
    orbs.forEach(orb => {
        orb.pulse += 0.05;
    });
    
    // Send compact state
    const statePlayers = Object.values(players).map(p => ({
        id: p.id,
        name: p.name,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        angle: Math.round(p.angle * 100) / 100,
        segments: p.segments.map(s => ({
            x: Math.round(s.x),
            y: Math.round(s.y),
            radius: Math.round(s.radius)
        })),
        score: p.score,
        color: p.color,
        tag: p.tag,
        tagColor: p.tagColor,
        isAlive: p.isAlive
    }));
    
    io.emit('gameState', {
        players: statePlayers,
        orbs: orbs,
        worldWidth: WORLD_WIDTH,
        worldHeight: WORLD_HEIGHT
    });
}, 1000 / 30); // 30 updates per second for smoothness

io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);
    
    socket.on('join', (data) => {
        const playerName = data.name || 'Player';
        const x = Math.random() * (WORLD_WIDTH - 400) + 200;
        const y = Math.random() * (WORLD_HEIGHT - 400) + 200;
        
        players[socket.id] = {
            id: socket.id,
            name: playerName,
            x: x,
            y: y,
            angle: 0,
            speed: 3,
            segments: Array(15).fill(null).map((_, i) => ({
                x: x - (i * 15),
                y: y,
                radius: 20 - (i * 0.8)
            })),
            score: 0,
            color: `hsl(${Math.random() * 360}, 70%, 50%)`,
            tag: '',
            tagColor: '#ffffff',
            isAlive: true,
            isBoosting: false,
            length: 15
        };
        
        socket.emit('playerId', socket.id);
        io.emit('playerJoined', {
            id: socket.id,
            name: playerName
        });
        console.log(`👋 ${playerName} joined the game`);
    });
    
    socket.on('mouseMove', (data) => {
        if (players[socket.id] && players[socket.id].isAlive) {
            players[socket.id].targetAngle = Math.atan2(
                data.y - players[socket.id].y,
                data.x - players[socket.id].x
            );
        }
    });
    
    socket.on('keyMove', (data) => {
        if (players[socket.id] && players[socket.id].isAlive) {
            players[socket.id].targetAngle = data.angle;
            players[socket.id].isBoosting = data.boosting || false;
        }
    });
    
    socket.on('boosting', (boosting) => {
        if (players[socket.id]) {
            players[socket.id].isBoosting = boosting;
        }
    });
    
    // Continuous movement update
    socket.on('updateMovement', (data) => {
        const player = players[socket.id];
        if (!player || !player.isAlive) return;
        
        // Smooth angle interpolation
        if (player.targetAngle !== undefined) {
            let diff = player.targetAngle - player.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            player.angle += diff * 0.15; // Smooth turning
        }
        
        let speed = player.isBoosting ? player.speed * 1.8 : player.speed;
        if (data.speedMultiplier) {
            speed *= data.speedMultiplier;
        }
        
        player.x += Math.cos(player.angle) * speed;
        player.y += Math.sin(player.angle) * speed;
        
        // Border collision
        if (player.x < BORDER_SIZE) player.x = BORDER_SIZE;
        if (player.x > WORLD_WIDTH - BORDER_SIZE) player.x = WORLD_WIDTH - BORDER_SIZE;
        if (player.y < BORDER_SIZE) player.y = BORDER_SIZE;
        if (player.y > WORLD_HEIGHT - BORDER_SIZE) player.y = WORLD_HEIGHT - BORDER_SIZE;
        
        // Check orb collisions
        orbs = orbs.filter(orb => {
            const dist = Math.hypot(player.x - orb.x, player.y - orb.y);
            if (dist < player.segments[0].radius + orb.radius) {
                player.score += 10;
                if (player.length < 50) {
                    player.length += 0.2;
                    const lastSegment = player.segments[player.segments.length - 1];
                    player.segments.push({
                        x: lastSegment.x,
                        y: lastSegment.y,
                        radius: Math.max(5, 20 - (player.segments.length * 0.8))
                    });
                }
                return false;
            }
            return true;
        });
        
        // Update segments
        const head = player.segments[0];
        head.x = player.x;
        head.y = player.y;
        
        for (let i = 1; i < player.segments.length; i++) {
            const segment = player.segments[i];
            const prev = player.segments[i - 1];
            const dist = Math.hypot(segment.x - prev.x, segment.y - prev.y);
            const spacing = 12;
            
            if (dist > spacing) {
                const angle = Math.atan2(segment.y - prev.y, segment.x - prev.x);
                segment.x = prev.x + Math.cos(angle) * spacing;
                segment.y = prev.y + Math.sin(angle) * spacing;
            }
        }
        
        // Check player collisions
        Object.values(players).forEach(otherPlayer => {
            if (otherPlayer.id === socket.id || !otherPlayer.isAlive) return;
            if (data.antiKill) return;
            
            const head = player.segments[0];
            otherPlayer.segments.forEach(segment => {
                const dist = Math.hypot(head.x - segment.x, head.y - segment.y);
                const collisionDist = head.radius + segment.radius;
                
                if (dist < collisionDist - 5) {
                    player.isAlive = false;
                    socket.emit('playerDied', { killedBy: otherPlayer.name });
                    
                    for (let i = 0; i < player.score / 10; i++) {
                        orbs.push({
                            id: Math.random().toString(36).substr(2, 9),
                            x: player.x + (Math.random() - 0.5) * 100,
                            y: player.y + (Math.random() - 0.5) * 100,
                            radius: ORB_RADIUS,
                            color: player.color,
                            pulse: Math.random() * Math.PI * 2
                        });
                    }
                    
                    setTimeout(() => {
                        player.x = Math.random() * (WORLD_WIDTH - 400) + 200;
                        player.y = Math.random() * (WORLD_HEIGHT - 400) + 200;
                        player.score = 0;
                        player.length = 15;
                        player.segments = Array(15).fill(null).map((_, i) => ({
                            x: player.x - (i * 15),
                            y: player.y,
                            radius: 20 - (i * 0.8)
                        }));
                        player.isAlive = true;
                        socket.emit('playerRespawned');
                    }, 3333);
                }
            });
        });
    });
    
    socket.on('adminAction', (data) => {
        const targetPlayer = players[data.targetId];
        if (!targetPlayer) return;
        
        switch(data.action) {
            case 'kick':
                io.to(data.targetId).emit('kicked');
                delete players[data.targetId];
                break;
            case 'teleportTo':
                if (players[socket.id]) {
                    players[socket.id].x = targetPlayer.x;
                    players[socket.id].y = targetPlayer.y;
                }
                break;
            case 'bringHere':
                if (players[socket.id]) {
                    targetPlayer.x = players[socket.id].x + 50;
                    targetPlayer.y = players[socket.id].y + 50;
                }
                break;
            case 'kill':
                targetPlayer.isAlive = false;
                io.to(data.targetId).emit('playerDied', { killedBy: 'Admin' });
                break;
            case 'giveSize':
                targetPlayer.length += 10;
                for (let i = 0; i < 10; i++) {
                    const lastSegment = targetPlayer.segments[targetPlayer.segments.length - 1];
                    targetPlayer.segments.push({
                        x: lastSegment.x,
                        y: lastSegment.y,
                        radius: Math.max(5, 20 - (targetPlayer.segments.length * 0.8))
                    });
                }
                targetPlayer.score += 100;
                break;
        }
    });
    
    socket.on('updateTag', (data) => {
        if (players[socket.id]) {
            players[socket.id].tag = data.tag;
            players[socket.id].tagColor = data.tagColor;
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        if (players[socket.id]) {
            io.emit('playerLeft', players[socket.id].name);
            delete players[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🕹️  Slither.io Z3N0 Server Running!');
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🌐 Network: http://100.115.92.206:${PORT}`);
    console.log('👥 Waiting for players to connect...');
});

// Discord OAuth Proxy

app.get('/api/discord/login', (req, res) => {
    const DISCORD_CLIENT_ID = '1521216585292058734';
    const DISCORD_REDIRECT_URI = 'https://z3n0tbh.itch.io/pingio';
    const DISCORD_SECRET = 'pnauu7mRFl9h8RRqHqR_1B0oeKU2uIfH';
    
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    const params = new URLSearchParams();
    params.append('client_id', DISCORD_CLIENT_ID);
    params.append('client_secret', DISCORD_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', DISCORD_REDIRECT_URI);
    
    fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    .then(r => r.json())
    .then(data => {
        if (data.access_token) {
            return fetch('https://discord.com/api/users/@me', {
                headers: { 'Authorization': `Bearer ${data.access_token}` }
            }).then(r => r.json());
        }
        throw new Error('No token');
    })
    .then(user => res.json(user))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Discord OAuth Proxy
app.get('/api/discord/login', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'No code' });
    
    try {
        const params = new URLSearchParams();
        params.append('client_id', '1521216585292058734');
        params.append('client_secret', 'pnauu7mRFl9h8RRqHqR_1B0oeKU2uIfH');
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', 'https://z3n0tbh.itch.io/pingio');
        
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: params,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const tokenData = await tokenRes.json();
        
        if (!tokenData.access_token) throw new Error('No token');
        
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();
        res.json(user);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Proxy: get Discord user by token
app.get('/api/discord/me', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'No token' });
    try {
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const user = await userRes.json();
        res.json(user);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});
