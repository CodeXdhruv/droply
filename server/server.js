require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors:                 { origin: '*', methods: ['GET', 'POST'] },
  transports:           ['websocket', 'polling'],
  pingInterval:         10000,   // send ping every 10 s
  pingTimeout:          20000,   // wait 20 s for pong before disconnect
  maxHttpBufferSize:    1e6,
  serveClient:          false,
  perMessageDeflate:    false,
});

app.use(express.json());
app.use(require('cors')());

// ── Session store ─────────────────────────────────────────────────────────────
// sessions: code → { senderId, receivers: Map<peerId, socketId>, timer }
const sessions = new Map();

// ── Logging ───────────────────────────────────────────────────────────────────
const ts  = () => new Date().toISOString();
const log = {
  info:    msg => console.log(`ℹ️  [${ts()}] ${msg}`),
  success: msg => console.log(`✅ [${ts()}] ${msg}`),
  error:   msg => console.error(`❌ [${ts()}] ${msg}`),
  warn:    msg => console.warn(`⚠️  [${ts()}] ${msg}`),
};

// ── HTTP endpoints ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ name: 'Droply Signaling Server', status: 'running' }));

app.get('/health', (_req, res) => res.json({
  status:            'ok',
  activeSessions:    sessions.size,
  connections:       io.engine.clientsCount,
  uptime:            Math.floor(process.uptime()),
}));

// Mobile receiver landing page
app.get('/receive', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('<h1>Missing code parameter</h1>');
  res.send(receiverPage(code));
});

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  log.success(`Connected: ${socket.id.slice(0, 10)}`);

  // ── Sender registers a code ──────────────────────────────────────────────
  socket.on('sender-ready', ({ code }) => {
    if (!code || code.length !== 6) {
      return socket.emit('error', { message: 'Invalid code format' });
    }

    // Clean up any previous session with same code
    if (sessions.has(code)) clearSession(code);

    const timer = setTimeout(() => {
      log.warn(`Session expired: ${code}`);
      io.to(sessions.get(code)?.senderId).emit('code-expired');
      clearSession(code);
    }, 180_000);

    sessions.set(code, { senderId: socket.id, receivers: new Map(), timer });
    log.info(`Session created: ${code} by ${socket.id.slice(0, 10)}`);
    socket.emit('sender-ready-ack', { code });
  });

  // ── Receiver joins ───────────────────────────────────────────────────────
  socket.on('receiver-ready', ({ code }) => {
    const session = sessions.get(code);
    if (!session) return socket.emit('error', { message: 'Invalid or expired code' });

    const peerId = 'p-' + Math.random().toString(36).slice(2, 10);
    session.receivers.set(peerId, socket.id);

    log.info(`Receiver joined: ${peerId} on code ${code}`);
    socket.emit('receiver-ready-ack', { peerId });
    io.to(session.senderId).emit('receiver-joined', { peerId });
  });

  // ── WebRTC signaling relay ───────────────────────────────────────────────
  socket.on('offer', ({ code, offer, peerId }) => {
    const session = sessions.get(code);
    if (!session) return;
    const receiverSocketId = session.receivers.get(peerId);
    if (!receiverSocketId) return log.warn(`offer: unknown peerId ${peerId}`);
    io.to(receiverSocketId).emit('offer', { offer, peerId });
  });

  socket.on('answer', ({ code, answer, peerId }) => {
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.senderId).emit('answer', { answer, peerId });
  });

  socket.on('ice-candidate', ({ code, candidate, peerId }) => {
    const session = sessions.get(code);
    if (!session || !candidate) return;

    if (session.senderId === socket.id) {
      // Sender → specific receiver
      const recvId = session.receivers.get(peerId);
      if (recvId) io.to(recvId).emit('ice-candidate', { candidate, peerId });
    } else {
      // Receiver → sender
      io.to(session.senderId).emit('ice-candidate', { candidate, peerId });
    }
  });

  socket.on('peer-complete', ({ code, peerId }) => {
    const session = sessions.get(code);
    if (!session) return;
    io.to(session.senderId).emit('peer-complete', { peerId });
  });

  socket.on('code-expired', ({ code }) => clearSession(code));

  // ── Disconnect cleanup ───────────────────────────────────────────────────
  socket.on('disconnect', () => {
    log.warn(`Disconnected: ${socket.id.slice(0, 10)}`);

    for (const [code, session] of sessions) {
      if (session.senderId === socket.id) {
        // Sender left — notify all receivers
        session.receivers.forEach((receiverSocketId, peerId) => {
          io.to(receiverSocketId).emit('peer-disconnected', { peerId });
        });
        clearSession(code);
        break;
      }

      // Check if a receiver left
      for (const [peerId, receiverSocketId] of session.receivers) {
        if (receiverSocketId === socket.id) {
          session.receivers.delete(peerId);
          io.to(session.senderId).emit('peer-disconnected', { peerId });
          log.info(`Receiver ${peerId} left session ${code}`);
          break;
        }
      }
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function clearSession(code) {
  const session = sessions.get(code);
  if (session) { clearTimeout(session.timer); sessions.delete(code); }
  log.info(`Session cleared: ${code} | active: ${sessions.size}`);
}

// ── Mobile receiver page — full WebRTC client, no extension needed ────────────
function receiverPage(code) {
  // SERVER_URL is injected at render time so the client script knows where to connect.
  const serverUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Droply – Receive file</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      background: linear-gradient(145deg, #6C5CE7 0%, #a29bfe 100%);
    }

    .card {
      background: #fff;
      border-radius: 20px;
      padding: 32px 24px;
      width: 100%;
      max-width: 400px;
      text-align: center;
      box-shadow: 0 24px 64px rgba(0,0,0,.22);
    }

    .logo { font-size: 40px; margin-bottom: 4px; }

    h1 {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #6C5CE7, #a29bfe);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 6px;
    }

    /* ── States ── */
    .state { display: none; }
    .state.active { display: block; }

    /* connecting */
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid #e0e0fe;
      border-top-color: #6C5CE7;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 24px auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .status-text { color: #555; font-size: 15px; margin-top: 8px; }

    /* progress */
    .file-icon { font-size: 48px; margin: 16px 0 8px; }
    .file-name { font-size: 17px; font-weight: 600; color: #222; word-break: break-all; margin-bottom: 4px; }
    .file-size { font-size: 13px; color: #888; margin-bottom: 20px; }

    .progress-wrap {
      background: #f0effe;
      border-radius: 999px;
      height: 10px;
      overflow: hidden;
      margin: 12px 0 6px;
    }
    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #6C5CE7, #a29bfe);
      border-radius: 999px;
      width: 0%;
      transition: width 0.2s ease;
    }
    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
    }
    .speed { font-size: 12px; color: #aaa; margin-top: 4px; }

    /* complete */
    .complete-icon { font-size: 64px; margin: 12px 0; }
    .complete-name { font-size: 16px; font-weight: 600; color: #333; word-break: break-all; margin-bottom: 4px; }
    .complete-size { font-size: 13px; color: #888; margin-bottom: 24px; }

    /* error */
    .error-icon { font-size: 48px; margin: 16px 0 8px; }
    .error-msg { font-size: 14px; color: #e17055; margin-bottom: 20px; }

    /* button */
    .btn {
      display: block;
      width: 100%;
      padding: 15px;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      margin-top: 12px;
      transition: opacity .15s, transform .1s;
    }
    .btn:active { transform: scale(0.98); opacity: .85; }
    .btn-primary { background: linear-gradient(135deg, #6C5CE7, #a29bfe); color: #fff; }
    .btn-outline { background: transparent; border: 2px solid #6C5CE7; color: #6C5CE7; }

    .footer-note { font-size: 11px; color: rgba(255,255,255,.7); margin-top: 20px; }
  </style>
</head>
<body>

<div class="card">
  <div class="logo">🐒</div>
  <h1>Droply</h1>

  <!-- STATE: connecting -->
  <div class="state active" id="s-connecting">
    <div class="spinner"></div>
    <p class="status-text" id="connect-status">Connecting to sender…</p>
  </div>

  <!-- STATE: receiving -->
  <div class="state" id="s-receiving">
    <div class="file-icon">📄</div>
    <div class="file-name" id="recv-name">—</div>
    <div class="file-size" id="recv-size">—</div>
    <div class="progress-wrap">
      <div class="progress-bar" id="recv-bar"></div>
    </div>
    <div class="progress-label">
      <span id="recv-bytes">0 B</span>
      <span id="recv-pct">0%</span>
    </div>
    <div class="speed" id="recv-speed"></div>
  </div>

  <!-- STATE: complete -->
  <div class="state" id="s-complete">
    <div class="complete-icon">✅</div>
    <div class="complete-name" id="done-name"></div>
    <div class="complete-size" id="done-size"></div>
    <button class="btn btn-primary" id="download-btn">⬇️ Save file</button>
    <button class="btn btn-outline" id="share-btn" style="display:none">↗️ Share file</button>
  </div>

  <!-- STATE: error -->
  <div class="state" id="s-error">
    <div class="error-icon">⚠️</div>
    <p class="error-msg" id="error-msg">Something went wrong.</p>
    <button class="btn btn-outline" onclick="location.reload()">Try again</button>
  </div>
</div>

<p class="footer-note">Keep this page open during the transfer</p>

<!-- Socket.IO client from CDN -->
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
// ── Config (injected by server) ───────────────────────────────────────────────
const SERVER_URL = '${serverUrl}';
const CODE       = '${code}';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// ── State ─────────────────────────────────────────────────────────────────────
let pc        = null;
let myPeerId  = null;
let chunks    = [];
let meta      = null;
let blobUrl   = null;
let lastBytes = 0, lastTime = Date.now();

// ── UI helpers ────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setStatus(msg) {
  document.getElementById('connect-status').textContent = msg;
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  show('s-error');
}

function formatBytes(b) {
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function updateProgress(received, total) {
  const pct = total ? Math.min(Math.floor(received / total * 100), 100) : 0;
  document.getElementById('recv-bar').style.width  = pct + '%';
  document.getElementById('recv-pct').textContent  = pct + '%';
  document.getElementById('recv-bytes').textContent = formatBytes(received) + ' / ' + formatBytes(total);

  const now   = Date.now();
  const dt    = (now - lastTime) / 1000;
  if (dt > 0.5) {
    const speed = (received - lastBytes) / dt;
    document.getElementById('recv-speed').textContent = formatBytes(speed) + '/s';
    lastBytes = received;
    lastTime  = now;
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
setStatus('Connecting to server…');
const socket = io(SERVER_URL, {
  transports:           ['websocket'],
  reconnection:         false,   // if connection drops mid-transfer, don't silently reconnect
});

socket.on('connect', () => {
  setStatus('Joined — waiting for sender…');
  socket.emit('receiver-ready', { code: CODE });
});

socket.on('connect_error', () => showError('Could not reach the Droply server. Check your connection.'));

socket.on('error', d => showError(d?.message || 'Server error'));

socket.on('receiver-ready-ack', ({ peerId }) => {
  myPeerId = peerId;
  setStatus('Connecting to sender…');
  setupPeerConnection();
});

socket.on('offer', async ({ offer, peerId }) => {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { code: CODE, answer, peerId });
  } catch (e) {
    showError('WebRTC handshake failed: ' + e.message);
  }
});

socket.on('ice-candidate', async ({ candidate }) => {
  if (!pc || !candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
});

socket.on('peer-disconnected', () => {
  // Only show error if we haven't already finished
  if (!blobUrl) showError('Sender disconnected before the transfer completed.');
});

socket.on('code-expired', () => showError('This share code has expired. Ask the sender to generate a new one.'));

// ── WebRTC ────────────────────────────────────────────────────────────────────
function setupPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { code: CODE, candidate: e.candidate, peerId: myPeerId });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('Connected — waiting for file…');
    if (pc.connectionState === 'failed')    showError('P2P connection failed. You may be behind a restrictive firewall.');
  };

  // The sender opens the data channel; we receive it here
  pc.ondatachannel = e => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';

    dc.onmessage = ev => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);

        if (msg.type === 'META') {
          meta = msg;
          chunks = [];
          lastBytes = 0; lastTime = Date.now();

          // Switch to receiving UI
          document.getElementById('recv-name').textContent = msg.name;
          document.getElementById('recv-size').textContent = formatBytes(msg.size);
          setFileIcon(msg.name);
          show('s-receiving');

        } else if (msg.type === 'END') {
          completeTransfer();
        }

      } else {
        // Binary chunk
        chunks.push(new Uint8Array(ev.data));
        const received = chunks.reduce((s, c) => s + c.length, 0);
        updateProgress(received, meta ? meta.size : 0);
      }
    };

    dc.onerror = () => showError('Data channel error during transfer.');
  };
}

function setFileIcon(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const map = {
    '.pdf':'📄', '.doc':'📝', '.docx':'📝',
    '.xls':'📊', '.xlsx':'📊',
    '.ppt':'📋', '.pptx':'📋',
    '.png':'🖼️', '.jpg':'🖼️', '.jpeg':'🖼️', '.gif':'🖼️', '.webp':'🖼️',
    '.mp4':'🎬', '.mov':'🎬', '.avi':'🎬', '.mkv':'🎬',
    '.mp3':'🎵', '.wav':'🎵',
    '.zip':'🗜️', '.rar':'🗜️', '.7z':'🗜️',
    '.txt':'📃', '.csv':'📃', '.json':'📃',
  };
  document.querySelector('.file-icon').textContent = map[ext] || '📁';
}

function completeTransfer() {
  const blob = new Blob(chunks, { type: meta?.mime || 'application/octet-stream' });
  blobUrl = URL.createObjectURL(blob);

  document.getElementById('done-name').textContent = meta?.name || 'file';
  document.getElementById('done-size').textContent = formatBytes(blob.size);
  show('s-complete');

  // Wire download button
  const dlBtn = document.getElementById('download-btn');
  dlBtn.onclick = () => {
    const a = Object.assign(document.createElement('a'), { href: blobUrl, download: meta?.name || 'download' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Wire Web Share API button (mobile browsers support this natively)
  const shareBtn = document.getElementById('share-btn');
  if (navigator.canShare) {
    shareBtn.style.display = 'block';
    shareBtn.onclick = async () => {
      try {
        const file = new File(chunks.map(c => new Uint8Array(c)), meta?.name || 'file', { type: meta?.mime });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: meta?.name });
        } else {
          // Fallback: share the URL/link
          await navigator.share({ title: 'Droply file', text: meta?.name });
        }
      } catch (_) {}
    };
  }

  socket.emit('peer-complete', { code: CODE, peerId: myPeerId });

  // Trigger auto-download on mobile after a short delay
  // (browsers require a user gesture for downloads; we already have one from page load)
  // Instead we just highlight the button — don't force-download without user tap
}
</script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.success(`Droply server running on :${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
