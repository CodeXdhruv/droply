// filepath: /home/dhruv/droply/server/server.js
// Droply Signaling Server - Optimized with Comprehensive Logging
// WebRTC signaling using Socket.IO with fast connection optimization
// Production-ready deployment for Render, Heroku, Railway, etc.

require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Environment variables
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];

// OPTIMIZED Socket.IO Configuration with Enhanced CORS for Extensions
const io = socketIo(server, {
  cors: {
    origin: ['*', 'chrome-extension://*'],
    methods: ['GET', 'POST'],
    credentials: false,
    allowEIO3: true
  },
  pingInterval: 3000,
  pingTimeout: 2000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  serveClient: false,
  perMessageDeflate: false,
  httpCompression: false,
  maxHttpBufferSize: 1e6,
  upgradeTimeout: 10000,
  connectTimeout: 10000,
  // Add these for extension compatibility
  path: '/socket.io/',
  serveClient: false
});

// Middleware with enhanced CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));
app.use(express.json());

// Store active sessions
const sessions = new Map();
const sessionExpiryMap = new Map();

// ENHANCED LOGGING UTILITY
const log = {
  info: (msg) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`),
  success: (msg) => console.log(`✅ [${new Date().toISOString()}] ${msg}`),
  error: (msg) => console.error(`❌ [${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`),
  debug: (msg) => console.log(`🔍 [${new Date().toISOString()}] ${msg}`),
  event: (event, socketId, data) => console.log(`📡 [${new Date().toISOString()}] EVENT: ${event} | Socket: ${socketId.substring(0, 8)}... | Data: ${JSON.stringify(data)}`)
};

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: sessions.size,
    activeConnections: io.engine.clientsCount,
    uptime: process.uptime()
  };
  log.debug(`Health check request: ${JSON.stringify(health)}`);
  res.json(health);
});

// Socket.IO Events
io.on('connection', (socket) => {
  log.success(`🟢 CLIENT CONNECTED: ${socket.id.substring(0, 12)}...`);
  log.info(`📊 Active connections: ${io.engine.clientsCount} | Active sessions: ${sessions.size}`);

  socket.on('sender-ready', (data) => {
    const { code } = data;
    log.event('sender-ready', socket.id, { code });

    if (!code || code.length !== 6) {
      log.error(`Invalid code format from ${socket.id.substring(0, 8)}...: "${code}"`);
      socket.emit('error', { message: 'Invalid code format' });
      return;
    }

    const session = {
      code,
      senderId: socket.id,
      receiverId: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 180000
    };
    
    sessions.set(code, session);
    log.success(`📝 SESSION CREATED: Code="${code}" | Sender="${socket.id.substring(0, 12)}..."`);
    log.info(`📊 Total active sessions: ${sessions.size}`);

    socket.emit('sender-ready-ack', { code });
    log.debug(`✅ ACK sent to sender for code: ${code}`);

    const expiryTimer = setTimeout(() => {
      if (sessions.has(code)) {
        sessions.delete(code);
        sessionExpiryMap.delete(code);
        io.to(socket.id).emit('code-expired', { code });
        log.warn(`⏰ SESSION EXPIRED: ${code}`);
      }
    }, 180000);

    sessionExpiryMap.set(code, expiryTimer);
  });

  socket.on('receiver-ready', (data) => {
    const { code } = data;
    log.event('receiver-ready', socket.id, { code });

    if (!sessions.has(code)) {
      log.error(`❌ INVALID/EXPIRED CODE: "${code}" from receiver ${socket.id.substring(0, 8)}...`);
      socket.emit('error', { message: 'Invalid or expired code' });
      return;
    }

    const session = sessions.get(code);

    if (session.receiverId) {
      log.warn(`⚠️  Code already in use: ${code}`);
      socket.emit('error', { message: 'Code already in use' });
      return;
    }

    session.receiverId = socket.id;
    sessions.set(code, session);

    log.success(`🟢 RECEIVER CONNECTED: "${socket.id.substring(0, 12)}..." for code "${code}"`);
    log.info(`🔗 ════════════════════════════════════════════════════════`);
    log.info(`🔗 SESSION LINK ESTABLISHED (Both peers ready!)`);
    log.info(`🔗 Sender:   ${session.senderId.substring(0, 12)}...`);
    log.info(`🔗 Receiver: ${socket.id.substring(0, 12)}...`);
    log.info(`🔗 Code:     ${code}`);
    log.info(`🔗 ════════════════════════════════════════════════════════`);

    log.info(`📢 NOTIFYING SENDER that receiver is ready for code: "${code}"`);
    io.to(session.senderId).emit('receiver-ready', { code });
    log.success(`📡 "receiver-ready" event SENT to sender - WebRTC handshake starting...`);
  });

  socket.on('offer', (data) => {
    const { code, offer } = data;
    log.event('offer', socket.id, { code, offerType: offer?.type });

    if (!sessions.has(code)) {
      log.error(`❌ Offer for unknown code: ${code}`);
      return;
    }

    const session = sessions.get(code);

    if (!session.receiverId) {
      log.warn(`⚠️  Offer received but no receiver for code ${code}`);
      return;
    }

    log.info(`📨 RELAYING OFFER (SDP) from Sender to Receiver`);
    log.debug(`   Code: ${code}`);
    log.debug(`   Type: ${offer?.type}`);
    
    io.to(session.receiverId).emit('offer', {
      code: data.code,
      offer: data.offer
    });
    
    log.success(`✅ Offer relayed successfully for code: "${code}"`);
  });

  socket.on('answer', (data) => {
    const { code, answer } = data;
    log.event('answer', socket.id, { code, answerType: answer?.type });

    if (!sessions.has(code)) {
      log.error(`❌ Answer for unknown code: ${code}`);
      return;
    }

    const session = sessions.get(code);

    if (!session.senderId) {
      log.warn(`⚠️  Answer received but no sender for code ${code}`);
      return;
    }

    log.info(`📨 RELAYING ANSWER (SDP) from Receiver to Sender`);
    log.debug(`   Code: ${code}`);
    log.debug(`   Type: ${answer?.type}`);
    
    io.to(session.senderId).emit('answer', {
      code: data.code,
      answer: data.answer
    });
    
    log.success(`✅ Answer relayed successfully for code: "${code}"`);
  });

  socket.on('ice-candidate', (data) => {
    const { code, candidate } = data;
    
    if (!sessions.has(code)) {
      log.warn(`⚠️  ICE candidate for unknown code: ${code}`);
      return;
    }
    
    const session = sessions.get(code);
    const targetId = session.senderId === socket.id ? session.receiverId : session.senderId;
    
    if (targetId) {
      io.to(targetId).emit('ice-candidate', {
        code: code,
        candidate: candidate
      });
      log.debug(`🧊 ICE candidate relayed for code: ${code}`);
    }
  });

  socket.on('disconnect', () => {
    log.warn(`🔴 CLIENT DISCONNECTED: ${socket.id.substring(0, 12)}...`);
    
    let cleanedCount = 0;
    for (const [code, session] of sessions.entries()) {
      if (session.senderId === socket.id) {
        log.warn(`  └─ Cleaning up session: "${code}" (was SENDER)`);
        if (session.receiverId) {
          io.to(session.receiverId).emit('peer-disconnected', { code });
          log.info(`  └─ Notified receiver that sender disconnected`);
        }
        sessions.delete(code);
        const timer = sessionExpiryMap.get(code);
        if (timer) clearTimeout(timer);
        sessionExpiryMap.delete(code);
        cleanedCount++;
      } else if (session.receiverId === socket.id) {
        log.warn(`  └─ Cleaning up session: "${code}" (was RECEIVER)`);
        io.to(session.senderId).emit('peer-disconnected', { code });
        log.info(`  └─ Notified sender that receiver disconnected`);
        session.receiverId = null;
        sessions.set(code, session);
        cleanedCount++;
      }
    }
    
    log.info(`🧹 Cleaned ${cleanedCount} session(s) | Remaining: ${sessions.size} active sessions`);
    log.info(`📊 Current connections: ${io.engine.clientsCount}`);
  });

  socket.on('error', (error) => {
    log.error(`Socket error from ${socket.id.substring(0, 8)}...: ${error}`);
  });
});

io.on('error', (error) => {
  log.error(`Socket.IO Server Error: ${error.message}`);
});

server.listen(PORT, () => {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   🚀 DROPLY SIGNALING SERVER STARTED                   ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  log.success(`Server running on http://localhost:${PORT}`);
  log.info(`📊 Health check: http://localhost:${PORT}/health`);
  log.info(`⚙️  Socket.IO optimized for fast connections`);
  log.info(`🔍 All events are being logged with timestamps`);
  console.log('\n');
});

process.on('SIGTERM', () => {
  log.warn('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    log.success('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log.warn('SIGINT received, shutting down gracefully...');
  server.close(() => {
    log.success('Server closed');
    process.exit(0);
  });
});
