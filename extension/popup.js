// ===== LOGGING =====
const Logger = {
  log:     (msg, ...a) => console.log(`📝 ${msg}`, ...a),
  success: (msg, ...a) => console.log(`✅ ${msg}`, ...a),
  error:   (msg, ...a) => console.error(`❌ ${msg}`, ...a),
  warn:    (msg, ...a) => console.warn(`⚠️ ${msg}`, ...a),
};

// ===== CONFIG =====
const SERVER_URL = 'https://droply-bxti.onrender.com'; // Production Server
// const SERVER_URL = 'http://localhost:3000';           // Local Development Server
const RTC_CONFIG  = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 4,
};
const CHUNK_SIZE    = 65536;        // 64 KB
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const EXPIRY_TIME   = 120;          // seconds

const SUPPORTED_EXTENSIONS = new Set([
  '.png','.jpg','.jpeg','.gif','.bmp','.webp','.svg',
  '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
  '.txt','.csv','.json','.xml',
  '.zip','.rar','.7z','.tar','.gz',
  '.mp3','.wav','.mp4','.avi','.mov','.mkv',
  '.exe','.msi','.apk','.iso',
]);

function validateFile(file) {
  if (file.size === 0)             return { valid: false, message: 'Cannot send empty files' };
  if (file.size > MAX_FILE_SIZE)   return { valid: false, message: `File too large (${(file.size/1024/1024).toFixed(1)} MB > 100 MB)` };
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { valid: false, message: `File type ${ext} not supported` };
  return { valid: true };
}

// ===== GLOBAL STATE =====
let socket         = null;
let selectedFile   = null;
let isSender       = false;
let generatedCode  = '';
let myPeerId       = null;         // receiver only
let timerInterval  = null;
let chunkCache     = [];           // ArrayBuffer slices, read-only after buffering

// Multi-receiver (sender side)
const peerConnections = new Map(); // peerId → RTCPeerConnection
const dataChannels    = new Map(); // peerId → RTCDataChannel
const peerProgress    = new Map(); // peerId → { sent, total, done }
// Each pump runs independently; no shared mutable offset between receivers
const peerPumps       = new Map(); // peerId → { cancel: fn } — lets us abort a stalled pump

// Receiver side — single connection
let recvPc      = null;
let recvDc      = null;
let recvChunks  = [];
let recvMeta    = null;
let recvBlobUrl = null;
let iceBuffers  = new Map(); // peerId -> candidate[]

let currentScreen = 'screen-splash';
let prevScreen    = 'screen-send';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  Logger.log('Droply initialized');
  if (typeof QRCode === 'undefined') Logger.error('QRCode library not loaded');
  initSocket();
  wireEventListeners();
  initTheme();
});

// ===== EVENT WIRING =====
function wireEventListeners() {
  document.getElementById('get-started-btn').addEventListener('click', () => showScreen('screen-send'));

  document.getElementById('tab-send').addEventListener('click',    () => switchTab('send'));
  document.getElementById('tab-receive').addEventListener('click', () => switchTab('receive'));

  document.querySelectorAll('.settings-btn').forEach(btn =>
    btn.addEventListener('click', () => showScreen('screen-settings'))
  );
  document.getElementById('back-btn').addEventListener('click', () => showScreen(prevScreen || 'screen-send'));

  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop',      e => { e.preventDefault(); dropZone.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  document.getElementById('remove-file-btn').addEventListener('click', removeFile);
  document.getElementById('generate-btn').addEventListener('click', generateCode);

  document.getElementById('receive-code-input').addEventListener('input', function () {
    const clean = this.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    this.value = clean;
    document.getElementById('connect-btn').disabled = clean.length < 6;
  });
  document.getElementById('connect-btn').addEventListener('click', startReceive);

  document.getElementById('copy-btn').addEventListener('click',  copyCode);
  document.getElementById('share-btn').addEventListener('click', shareCode);

  const tabReceiveCode = document.getElementById('tab-receive-code');
  if (tabReceiveCode) tabReceiveCode.addEventListener('click', () => switchTab('receive'));

  document.getElementById('open-file-btn').addEventListener('click', downloadFile);
  document.getElementById('done-btn').addEventListener('click', resetAll);

  document.getElementById('theme-toggle-item').addEventListener('click', toggleTheme);
  document.getElementById('clear-history-item').addEventListener('click', clearHistory);
}

// ===== NAVIGATION =====
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (!target) return;
  target.classList.add('active');
  if (currentScreen !== id && id !== 'screen-settings') prevScreen = currentScreen;
  currentScreen = id;
}

function switchTab(tab) {
  const isSend = tab === 'send';
  isSender = isSend;
  document.getElementById('send-tab-content').style.display    = isSend ? 'flex' : 'none';
  document.getElementById('receive-tab-content').style.display = isSend ? 'none' : 'flex';
  document.getElementById('tab-send').classList.toggle('active',    isSend);
  document.getElementById('tab-receive').classList.toggle('active', !isSend);
}

// ===== FILE HANDLING =====
function handleFile(file) {
  const result = validateFile(file);
  if (!result.valid) { showToast('error', 'Invalid file', result.message); return; }

  selectedFile = file;
  document.getElementById('drop-zone').style.display = 'none';

  const chip = document.getElementById('file-chip');
  chip.classList.add('visible');
  document.getElementById('chip-name').textContent = file.name;
  document.getElementById('chip-size').textContent = formatBytes(file.size);
  document.getElementById('generate-btn').disabled = false;

  bufferFile(file);
}

async function bufferFile(file) {
  chunkCache = [];
  const buf = await file.arrayBuffer();
  for (let i = 0; i < buf.byteLength; i += CHUNK_SIZE) {
    chunkCache.push(buf.slice(i, i + CHUNK_SIZE));
  }
  Logger.success('File buffered', chunkCache.length + ' chunks');
}

function removeFile() {
  selectedFile = null;
  chunkCache   = [];
  document.getElementById('file-chip').classList.remove('visible');
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('drop-zone').style.display = '';
}

function formatBytes(bytes) {
  if (!bytes)          return '0 B';
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ===== GENERATE CODE (SENDER) =====
function generateCode() {
  if (!selectedFile) return;

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  generatedCode = code;

  document.getElementById('display-code').textContent = code.slice(0, 3) + ' • ' + code.slice(3);
  document.getElementById('code-chip-name').textContent = selectedFile.name;
  document.getElementById('code-chip-size').textContent = formatBytes(selectedFile.size);



  isSender = true;
  showScreen('screen-code');
  socket.emit('sender-ready', { code });
  startTimer();
}

function startTimer() {
  clearInterval(timerInterval);
  let s = EXPIRY_TIME;
  updateTimerDisplay(s);
  timerInterval = setInterval(() => {
    s--;
    updateTimerDisplay(s);
    if (s <= 0) {
      clearInterval(timerInterval);
      showToast('warning', 'Code expired', 'This code is no longer valid.');
      socket.emit('code-expired', { code: generatedCode });
      resetAll();
    }
  }, 1000);
}

function updateTimerDisplay(s) {
  const el = document.getElementById('timer-display');
  if (el) el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ===== RECEIVE (RECEIVER) =====
function startReceive() {
  const code = document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (code.length < 6) return;
  isSender = false;
  showScreen('screen-connecting');
  socket.emit('receiver-ready', { code });
}

// ===== PEER CONNECTION — SENDER SIDE (multi-receiver) =====

// How much data we allow queued per channel before pausing.
// 4 MB is generous but prevents the JS heap from ballooning on slow receivers.
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;  // pause sending
const BACKPRESSURE_LOW  =     512 * 1024;   // resume sending (via bufferedamountlow)

function createSenderPeer(peerId) {
  if (peerConnections.has(peerId)) return;
  Logger.log('Creating sender peer for', peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections.set(peerId, pc);
  peerProgress.set(peerId, { sent: 0, total: selectedFile ? selectedFile.size : 0, done: false });

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { code: generatedCode, candidate: e.candidate, peerId });
  };

  pc.onconnectionstatechange = () => {
    Logger.log(`Sender peer ${peerId}:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cancelPump(peerId);
      peerConnections.delete(peerId);
      dataChannels.delete(peerId);
      peerProgress.delete(peerId);
      updateReceiverBadge();
    }
  };

  // ordered:true, no maxRetransmits — reliable delivery, TCP-like
  const dc = pc.createDataChannel('file-transfer', { ordered: true });
  dc.binaryType = 'arraybuffer';

  // bufferedamountlow fires when the queue drains below BACKPRESSURE_LOW,
  // which is how we resume a paused pump without polling.
  dc.bufferedAmountLowThreshold = BACKPRESSURE_LOW;

  dataChannels.set(peerId, dc);

  dc.onopen = () => {
    Logger.success('Channel open for', peerId);
    showScreen('screen-transfer');
    document.getElementById('transfer-filename').textContent = selectedFile.name;
    startFilePump(peerId, dc);
  };

  dc.onerror = e => Logger.error('Channel error for', peerId, e);

  pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false })
    .then(offer => { pc.setLocalDescription(offer); socket.emit('offer', { code: generatedCode, offer, peerId }); })
    .catch(e => Logger.error('Offer failed', e));
}

// ── Independent, event-driven pump per receiver ───────────────────────────────
// Each receiver gets its own idx cursor into the shared (read-only) chunkCache.
// The pump never touches another receiver's state.
function startFilePump(peerId, dc) {
  if (!selectedFile || chunkCache.length === 0) return;

  const prog = peerProgress.get(peerId);
  prog.total = selectedFile.size;

  // Metadata first
  dc.send(JSON.stringify({ type: 'META', name: selectedFile.name, size: selectedFile.size, mime: selectedFile.type }));

  let idx       = 0;
  let paused    = false;
  let cancelled = false;

  // Resume callback wired to the bufferedamountlow event
  function onDrain() {
    if (cancelled) return;
    paused = false;
    pump();
  }
  dc.addEventListener('bufferedamountlow', onDrain);

  function pump() {
    if (cancelled) return;

    // Finished
    if (idx >= chunkCache.length) {
      dc.send(JSON.stringify({ type: 'END' }));
      prog.sent = prog.total;
      prog.done = true;
      updateReceiverBadge();
      socket.emit('peer-complete', { code: generatedCode, peerId });
      dc.removeEventListener('bufferedamountlow', onDrain);
      peerPumps.delete(peerId);
      Logger.success('Transfer complete for', peerId);
      return;
    }

    // Back-pressure: stop and let bufferedamountlow resume us
    if (dc.bufferedAmount >= BACKPRESSURE_HIGH) {
      paused = true;
      return; // bufferedamountlow will call onDrain → pump()
    }

    const chunk = chunkCache[idx++];
    dc.send(chunk);
    prog.sent += chunk.byteLength;

    // Throttle UI updates — only repaint every 16 ms (≈60 fps)
    scheduleUIUpdate(peerId, prog.sent, prog.total);

    // Yield to the event loop so ICE/signaling messages aren't starved.
    // Using MessageChannel (microtask-ish but yields) is faster than setTimeout(0).
    mcPort.postMessage(null);
  }

  // Store cancel handle so resetConnectionCore can stop runaway pumps
  peerPumps.set(peerId, {
    cancel: () => {
      cancelled = true;
      dc.removeEventListener('bufferedamountlow', onDrain);
    },
  });

  // Wire MessageChannel to drive the pump loop without starving the event loop
  const mc = new MessageChannel();
  const mcPort = mc.port2;
  mc.port1.onmessage = () => { if (!paused && !cancelled) pump(); };

  pump(); // kick off
}

function cancelPump(peerId) {
  const handle = peerPumps.get(peerId);
  if (handle) { handle.cancel(); peerPumps.delete(peerId); }
}

// ── Throttled UI update (shared across all receivers — shows aggregate) ───────
let uiRafPending = false;
let uiSentTotal  = 0;
let uiFileTotal  = 0;

function scheduleUIUpdate(peerId, sent, total) {
  // Aggregate across all receivers for the progress bar
  uiFileTotal = total;
  // For multi-receiver: show the slowest receiver's progress (most conservative)
  let minSent = Infinity;
  peerProgress.forEach(p => { if (!p.done && p.total > 0) minSent = Math.min(minSent, p.sent); });
  uiSentTotal = minSent === Infinity ? sent : minSent;

  if (!uiRafPending) {
    uiRafPending = true;
    requestAnimationFrame(() => {
      uiRafPending = false;
      updateRealProgress(uiSentTotal, uiFileTotal);
      updateReceiverBadge();
    });
  }
}

// ===== PEER CONNECTION — RECEIVER SIDE =====
function createReceiverPeer(peerId) {
  Logger.log('Creating receiver peer for', peerId);
  recvPc = new RTCPeerConnection(RTC_CONFIG);

  recvPc.onicecandidate = e => {
    if (e.candidate) {
      const code = document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      socket.emit('ice-candidate', { code, candidate: e.candidate, peerId });
    }
  };

  recvPc.onconnectionstatechange = () => {
    Logger.log('Receiver peer state:', recvPc.connectionState);
    if (recvPc.connectionState === 'failed' || recvPc.connectionState === 'closed') {
      showToast('warning', 'Disconnected', 'Connection to sender lost.');
      resetConnectionCore();
      showScreen('screen-send');
    }
  };

  recvPc.ondatachannel = e => {
    recvDc = e.channel;
    recvDc.binaryType = 'arraybuffer';
    recvDc.onmessage = ev => handleReceivedData(ev.data);
    recvDc.onerror   = ev => Logger.error('Recv channel error', ev);
    showScreen('screen-transfer');
  };
}

function handleReceivedData(data) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'META') {
      recvMeta = msg;
      document.getElementById('transfer-filename').textContent = msg.name;
    } else if (msg.type === 'END') {
      finalizeReceive();
    }
  } else {
    recvChunks.push(new Uint8Array(data));
    const received = recvChunks.reduce((s, c) => s + c.length, 0);
    updateRealProgress(received, recvMeta ? recvMeta.size : 0);
  }
}

function finalizeReceive() {
  const blob    = new Blob(recvChunks, { type: recvMeta.mime });
  recvBlobUrl   = URL.createObjectURL(blob);
  
  // Clear memory immediately
  recvChunks = [];
  
  showComplete(recvMeta.name, recvMeta.size);
}

function downloadFile() {
  if (!recvBlobUrl) return;
  const a = Object.assign(document.createElement('a'), { href: recvBlobUrl, download: recvMeta?.name || 'download' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Proactive cleanup
  setTimeout(() => {
    if (recvBlobUrl) {
      URL.revokeObjectURL(recvBlobUrl);
      recvBlobUrl = null;
    }
  }, 10000);
}

// ===== PROGRESS =====
let lastBytesAt = 0, lastTimeAt = 0;

function updateRealProgress(current, total) {
  if (!total) return;
  const pct = Math.min(Math.floor((current / total) * 100), 100);

  document.getElementById('transfer-percent').textContent = pct + '%';
  document.getElementById('progress-fill').style.width    = pct + '%';
  document.getElementById('transfer-bytes').textContent   = formatBytes(current) + ' of ' + formatBytes(total);

  const now = Date.now();
  if (now - lastTimeAt > 500) {
    const speed = (current - lastBytesAt) / ((now - lastTimeAt) / 1000);
    document.getElementById('transfer-speed').textContent = formatBytes(speed) + '/s';
    lastBytesAt = current;
    lastTimeAt  = now;
  }

  const monkey = document.getElementById('transfer-monkey');
  if (monkey) {
    monkey.style.left   = (15 + (pct / 100) * 55) + '%';
    monkey.style.bottom = (12 + Math.sin(pct * 0.3) * 15) + 'px';
  }
}

// ===== RECEIVER BADGE (sender UI) =====
function updateReceiverBadge() {
  const badge     = document.getElementById('receiver-count-badge');
  const container = document.getElementById('receiver-list-container');
  if (!badge || !container) return;

  const count = peerConnections.size;
  if (!count) { badge.style.display = 'none'; container.innerHTML = ''; return; }

  badge.style.display = 'block';
  badge.textContent   = `${count} receiver${count > 1 ? 's' : ''} connected`;

  container.innerHTML = '';
  peerConnections.forEach((_, peerId) => {
    const prog = peerProgress.get(peerId);
    const pct  = prog && prog.total ? Math.floor((prog.sent / prog.total) * 100) : 0;
    container.innerHTML += `
      <div class="receiver-item">
        <div class="receiver-item-left"><span>📱</span><span>Receiver ${peerId.slice(-4)}</span></div>
        <div class="receiver-progress">${prog?.done ? '✅ Complete' : pct + '%'}</div>
      </div>`;
  });
}

// ===== COMPLETE =====
function showComplete(fileName, fileSize) {
  clearInterval(timerInterval);
  document.getElementById('complete-filename').textContent = fileName;
  document.getElementById('complete-size').textContent     = formatBytes(fileSize);
  showScreen('screen-complete');
  spawnConfetti();
  showToast('success', isSender ? 'File sent!' : 'File received!', 'Transfer complete.');
}

function spawnConfetti() {
  const container = document.getElementById('confetti-container');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#6C5CE7','#F9CA24','#00B894','#E17055','#74B9FF','#FD79A8'];
  for (let i = 0; i < 18; i++) {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;width:${6+Math.random()*5}px;height:${6+Math.random()*5}px;background:${colors[i%colors.length]};border-radius:${Math.random()>.5?'50%':'3px'};left:${10+Math.random()*80}%;top:${10+Math.random()*30}%;animation:confettiFall ${1+Math.random()*.8}s ease-out ${Math.random()*.5}s forwards`;
    container.appendChild(el);
  }
}

// ===== RESET =====
function resetConnectionCore() {
  clearInterval(timerInterval);
  timerInterval = null;

  // Cancel all active pumps first (prevents sends on closing channels)
  peerPumps.forEach((_, peerId) => cancelPump(peerId));

  // Sender side
  peerConnections.forEach(pc => { try { pc.close(); } catch (_) {} });
  dataChannels.forEach(dc    => { try { dc.close();  } catch (_) {} });
  peerConnections.clear();
  dataChannels.clear();
  peerProgress.clear();

  // Receiver side
  if (recvDc) { try { recvDc.close(); } catch (_) {} recvDc = null; }
  if (recvPc) { try { recvPc.close(); } catch (_) {} recvPc = null; }
  recvChunks = [];
  recvMeta   = null;
  if (recvBlobUrl) { URL.revokeObjectURL(recvBlobUrl); recvBlobUrl = null; }

  uiSentTotal  = 0;
  uiFileTotal  = 0;
  uiRafPending = false;
  lastBytesAt  = 0;
  lastTimeAt   = 0;
}

function resetAll() {
  resetConnectionCore();
  removeFile();
  generatedCode = '';
  myPeerId      = null;
  document.getElementById('receive-code-input').value = '';
  document.getElementById('connect-btn').disabled = true;
  showScreen('screen-send');
  switchTab('send');
}

// ===== SOCKET.IO =====
function initSocket() {
  Logger.log('Connecting to', SERVER_URL);
  try {
    socket = io(SERVER_URL, {
      transports:          ['websocket', 'polling'],
      reconnection:        true,
      reconnectionDelay:   1000,
      reconnectionAttempts: 10,
    });
  } catch (e) { Logger.error('Socket init failed', e); return; }

  socket.on('connect',       () => { Logger.success('Socket connected', socket.id); setStatusDot('var(--green)'); });
  socket.on('disconnect',    r  => { Logger.warn('Socket disconnected', r);         setStatusDot('var(--red)');   });
  socket.on('connect_error', e  => Logger.error('Socket connect error', e.message));
  socket.on('error',         d  => { Logger.error('Server error', d); showToast('error', 'Error', d?.message || 'Server error'); });

  // ── Sender events ──

  socket.on('sender-ready-ack', d => Logger.success('Sender ACK', d));

  socket.on('receiver-joined', ({ peerId }) => {
    Logger.success('Receiver joined', peerId);
    createSenderPeer(peerId);
  });

  socket.on('answer', async ({ answer, peerId }) => {
    const pc = peerConnections.get(peerId);
    if (!pc) return Logger.warn('No sender peer for answer', peerId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      Logger.log('Answer set for', peerId);
      
      // Process buffered ICE candidates
      const buffer = iceBuffers.get(peerId);
      if (buffer) {
        while (buffer.length) {
          await pc.addIceCandidate(buffer.shift());
        }
        iceBuffers.delete(peerId);
      }
    } catch (e) { Logger.error('setRemoteDescription failed', e); }
  });

  // ── Receiver events ──

  socket.on('receiver-ready-ack', ({ peerId }) => {
    Logger.success('Receiver ACK, peerId:', peerId);
    myPeerId = peerId;
    createReceiverPeer(peerId);
  });

  socket.on('offer', async ({ offer, peerId }) => {
    // Receiver handles offers
    if (!recvPc) return Logger.warn('No receiver peer for offer');
    try {
      await recvPc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await recvPc.createAnswer();
      await recvPc.setLocalDescription(answer);
      const code = document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      socket.emit('answer', { code, answer, peerId });
      Logger.log('Answer sent for', peerId);

      // Process buffered ICE candidates
      const buffer = iceBuffers.get(peerId);
      if (buffer) {
        while (buffer.length) {
          await recvPc.addIceCandidate(buffer.shift());
        }
        iceBuffers.delete(peerId);
      }
    } catch (e) { Logger.error('Offer handling failed', e); }
  });

  // ── Shared ICE ──

  socket.on('ice-candidate', async ({ candidate, peerId }) => {
    // Try sender map first, then receiver connection
    const pc = peerConnections.get(peerId) || recvPc;
    if (!pc || !candidate) return;
    
    try {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        if (!iceBuffers.has(peerId)) iceBuffers.set(peerId, []);
        iceBuffers.get(peerId).push(new RTCIceCandidate(candidate));
      }
    } catch (e) { Logger.warn('addIceCandidate failed', e.message); }
  });

  // ── Misc ──

  socket.on('peer-complete', ({ peerId }) => {
    Logger.success('Peer completed', peerId);
    const prog = peerProgress.get(peerId);
    if (prog) { prog.sent = prog.total; updateReceiverBadge(); }
  });

  socket.on('peer-disconnected', ({ peerId }) => {
    Logger.warn('Peer disconnected', peerId);
    if (isSender) {
      peerConnections.delete(peerId);
      dataChannels.delete(peerId);
      peerProgress.delete(peerId);
      updateReceiverBadge();
    } else {
      showToast('warning', 'Sender disconnected', 'The sender left the session.');
      resetConnectionCore();
      showScreen('screen-send');
    }
  });

  socket.on('code-expired', () => {
    showToast('warning', 'Code expired', 'This code is no longer valid.');
    resetConnectionCore();
    showScreen('screen-send');
  });
}

function setStatusDot(color) {
  document.querySelectorAll('.status-dot').forEach(el => el.style.background = color);
}

// ===== UI HELPERS =====
function copyCode() {
  if (navigator.clipboard) navigator.clipboard.writeText(generatedCode).catch(() => {});
  const btn = document.getElementById('copy-btn');
  btn.classList.add('copied');
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Code`;
  }, 2000);
  showToast('success', 'Copied!', 'Code copied to clipboard.');
}

function shareCode() {
  showToast('info', 'Share code', `Use code: ${generatedCode}`);
}

function showToast(type, title, msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✅', warning: '⚠️', error: '📡', info: '💡' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || '📢'}</span><div class="toast-content"><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div></div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity    = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function initTheme() {
  applyTheme(localStorage.getItem('droply-theme') || 'light');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('droply-theme', theme);
  const label = document.querySelector('#theme-toggle-item .settings-item-value');
  if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast('success', 'Theme changed', `Switched to ${next} mode.`);
}

function clearHistory() {
  showToast('success', 'History cleared', 'Transfer history has been cleared.');
}
