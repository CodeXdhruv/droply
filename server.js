// filepath: /home/dhruv/droply/server/server.js
// Droply Signaling Server - Optimized with Comprehensive Logging
// WebRTC signaling using Socket.IO with fast connection optimization
// Production-ready deployment for Render, Heroku, Railway, etc.

require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

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

// Web receiver page - for mobile QR code scanning
app.get('/receive', (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.status(400).send('<h1>Invalid request - missing code parameter</h1>');
  }

  log.info(`📱 Mobile receiver page requested with code: ${code}`);

  // Send HTML page with code embedded
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Droply - Receive File</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
    }

    .header {
      margin-bottom: 30px;
    }

    .header h1 {
      font-size: 36px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 10px;
    }

    .subtitle {
      color: #666;
      font-size: 14px;
    }

    .content {
      margin: 30px 0;
    }

    .code-display {
      background: #f5f7fa;
      padding: 20px;
      border-radius: 12px;
      margin: 20px 0;
      border-left: 4px solid #667eea;
    }

    .code-label {
      color: #999;
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .code-text {
      font-size: 32px;
      font-weight: 700;
      color: #333;
      font-family: 'Courier New', monospace;
      letter-spacing: 4px;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 14px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      margin: 10px 0;
      width: 100%;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
    }

    .btn-primary:active {
      transform: translateY(0);
    }

    .btn-secondary {
      background: white;
      color: #667eea;
      border: 2px solid #667eea;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      margin: 10px 0;
    }

    .btn-secondary:hover {
      background: #f5f7fa;
    }

    .status {
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
      font-size: 14px;
      display: none;
    }

    .status.info {
      background: #e3f2fd;
      color: #1976d2;
      display: block;
    }

    .status.success {
      background: #e8f5e9;
      color: #2e7d32;
      display: block;
    }

    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }

    .info-text {
      color: #999;
      font-size: 12px;
      margin-top: 15px;
      line-height: 1.6;
    }

    .steps {
      background: #f5f7fa;
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
      text-align: left;
      font-size: 13px;
    }

    .steps ol {
      margin-left: 20px;
      margin-top: 10px;
    }

    .steps li {
      margin: 8px 0;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="icon">📁</div>
      <h1>Droply</h1>
      <p class="subtitle">Instant File Sharing</p>
    </div>

    <div class="content">
      <div class="status success" id="successStatus">
        ✅ Share code ready!
      </div>

      <p style="color: #666; margin: 20px 0;">A file has been shared with you using Droply.</p>
      
      <div class="code-display">
        <div class="code-label">Your Share Code</div>
        <div class="code-text" id="shareCode">${code}</div>
      </div>

      <button class="btn-primary" onclick="copyCode()">
        📋 Copy Code
      </button>

      <div class="steps">
        <strong>📱 To receive the file:</strong>
        <ol>
          <li>Install Droply extension on your device</li>
          <li>Open the Droply extension</li>
          <li>Go to the "Receive" tab</li>
          <li>Paste this code: <strong>${code}</strong></li>
          <li>Click "Connect" and wait for the transfer</li>
        </ol>
      </div>

      <button class="btn-secondary" onclick="installGuide()">
        🔗 Install Droply Extension
      </button>
    </div>

    <div class="info-text">
      💡 Keep this page open during the transfer
    </div>
  </div>

  <script>
    function copyCode() {
      const code = document.getElementById('shareCode').textContent;
      navigator.clipboard.writeText(code).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    }

    function installGuide() {
      window.open('https://chrome.google.com/webstore/detail/droply/YOUR_EXTENSION_ID', '_blank');
    }
  </script>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
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
