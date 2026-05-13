// ===== LOGGING =====
const Logger = {
  log: (msg, data = '') => console.log(`📝 ${msg}`, data),
  success: (msg, data = '') => console.log(`✅ ${msg}`, data),
  error: (msg, data = '') => console.error(`❌ ${msg}`, data),
  warn: (msg, data = '') => console.warn(`⚠️ ${msg}`, data),
  debug: (msg, data = '') => console.log(`🔍 ${msg}`, data)
};

// ===== CONFIG =====
const SERVER_URL = 'https://droply-bxti.onrender.com';
const RTC_CONFIG = {
  iceServers: [
    // STUN servers (fast, for direct connections)
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun2.l.google.com:19302'] },
    
    // TURN servers (fallback for firewall-restricted networks)
    {
      urls: ['turn:openrelay.metered.ca:80'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: ['turn:openrelay.metered.ca:443'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 5  // Reduced from 15 for faster gathering
};
const RTC_OFFER_OPTIONS = { offerToReceiveAudio: false, offerToReceiveVideo: false, voiceActivityDetection: false, iceRestart: false };
const CHUNK_SIZE = 65536;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const EXPIRY_TIME = 120;
const CONNECTION_TIMEOUT = 30000;

const SUPPORTED_FILE_TYPES = {
  '.png':'Image','.jpg':'Image','.jpeg':'Image','.gif':'Image','.bmp':'Image','.webp':'Image','.svg':'Image',
  '.pdf':'PDF','.doc':'Word','.docx':'Word','.xls':'Excel','.xlsx':'Excel','.ppt':'PPT','.pptx':'PPT',
  '.txt':'Text','.csv':'CSV','.json':'JSON','.xml':'XML',
  '.zip':'Archive','.rar':'Archive','.7z':'Archive','.tar':'Archive','.gz':'Archive',
  '.mp3':'Audio','.wav':'Audio','.mp4':'Video','.avi':'Video','.mov':'Video','.mkv':'Video',
  '.exe':'Executable','.msi':'Installer','.apk':'Android','.iso':'ISO'
};

function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) return { valid: false, message: `File too large (${(file.size/1024/1024).toFixed(1)}MB > 100MB)` };
  if (file.size === 0) return { valid: false, message: 'Cannot send empty files' };
  const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
  if (!SUPPORTED_FILE_TYPES[ext]) return { valid: false, message: `File type ${ext} not supported` };
  return { valid: true, message: 'OK', fileType: SUPPORTED_FILE_TYPES[ext] };
}

// ===== GLOBAL STATE =====
let socket = null, selectedFile = null;
let isSender = false;
const peerConnections = new Map();
const dataChannels = new Map();
const peerProgress = new Map();
let preWarmConnection = null;
let chunkCache = [];
let fileBuffered = false;
let myPeerId = null; // for receiver
let timerInterval = null;
let transferStartTime = 0, lastBytesUpdate = 0, lastTimeUpdate = 0;
let transferState = { isTransferring: false, totalSize: 0, sentBytes: 0, receivedBytes: 0 };
let receivedFileChunks = [], receivedFileMetadata = null, receivedBlobUrl = null;

let generatedCodeRaw = '';

// ===== UI STATE VARIABLES (for the new template) =====
let currentScreen = 'screen-splash';
let prevScreen = 'screen-send';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  Logger.log('Droply initialized');
  
  // Check if QRCode library is loaded
  if (typeof QRCode === 'undefined') {
    Logger.error('QRCode library not loaded! Check qrcode.min.js');
  } else {
    Logger.success('QRCode library loaded successfully');
  }
  
  initSocket();
  wireEventListeners();
  initTheme();
});

function wireEventListeners() {
  // Splash
  document.getElementById('get-started-btn').addEventListener('click', () => showScreen('screen-send'));

  // Tabs (send screen)
  document.getElementById('tab-send').addEventListener('click', () => switchTab('send'));
  document.getElementById('tab-receive').addEventListener('click', () => switchTab('receive'));

  // Settings buttons (all screens use .settings-btn class)
  document.querySelectorAll('.settings-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen('screen-settings'));
  });

  // Back button
  document.getElementById('back-btn').addEventListener('click', () => showScreen(prevScreen || 'screen-send'));

  // Drag & drop
  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', (e) => {
    // Only remove class if truly leaving the zone (not entering a child)
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Remove file button
  document.getElementById('remove-file-btn').addEventListener('click', removeFile);

  // Generate code
  document.getElementById('generate-btn').addEventListener('click', generateCode);

  // Receive code input
  document.getElementById('receive-code-input').addEventListener('input', function() {
    handleCodeInput(this);
  });

  // Connect button
  document.getElementById('connect-btn').addEventListener('click', startReceive);

  // Copy / Share code
  document.getElementById('copy-btn').addEventListener('click', copyCode);
  document.getElementById('share-btn').addEventListener('click', shareCode);

  // Code screen tab (receive tab on code screen)
  const tabReceiveCode = document.getElementById('tab-receive-code');
  if (tabReceiveCode) tabReceiveCode.addEventListener('click', () => switchTab('receive'));

  // Complete screen
  document.getElementById('open-file-btn').addEventListener('click', downloadFile);
  document.getElementById('done-btn').addEventListener('click', resetAll);

  // Settings items
  document.getElementById('theme-toggle-item').addEventListener('click', toggleTheme);
  document.getElementById('clear-history-item').addEventListener('click', clearHistory);
}

// ===== UI NAVIGATION =====
function showScreen(id) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    if (currentScreen !== id && id !== 'screen-settings') {
      prevScreen = currentScreen;
    }
    currentScreen = id;
  }
}

function switchTab(tab) {
  const sendContent = document.getElementById('send-tab-content');
  const receiveContent = document.getElementById('receive-tab-content');
  const tabSend = document.getElementById('tab-send');
  const tabReceive = document.getElementById('tab-receive');

  if (tab === 'send') {
    isSender = true;
    sendContent.style.display = 'flex';
    receiveContent.style.display = 'none';
    tabSend.classList.add('active');
    tabReceive.classList.remove('active');
  } else {
    isSender = false;
    sendContent.style.display = 'none';
    receiveContent.style.display = 'flex';
    tabSend.classList.remove('active');
    tabReceive.classList.add('active');
  }
}

// ===== FILE HANDLING =====
function handleFile(file) {
  if (!file) return;
  const result = validateFile(file);
  if (!result.valid) {
    showToast('error', 'Invalid File', result.message);
    return;
  }
  
  selectedFile = file;

  // Hide the drop zone so the chip + button are fully visible
  document.getElementById('drop-zone').style.display = 'none';

  const chip = document.getElementById('file-chip');
  chip.classList.add('visible');
  document.getElementById('chip-name').textContent = file.name;
  document.getElementById('chip-size').textContent = formatBytes(file.size);
  document.getElementById('generate-btn').disabled = false;
  bufferFileIntoRAM(file);
}

async function bufferFileIntoRAM(file) {
  chunkCache = [];
  fileBuffered = false;
  const buffer = await file.arrayBuffer();
  for (let i = 0; i < buffer.byteLength; i += CHUNK_SIZE) {
    chunkCache.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  fileBuffered = true;
}

function removeFile() {
  selectedFile = null;
  chunkCache = [];
  fileBuffered = false;
  document.getElementById('file-chip').classList.remove('visible');
  document.getElementById('generate-btn').disabled = true;
  // Restore the drop zone
  document.getElementById('drop-zone').style.display = '';
}


function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function overlayMonkeyOnQR(container) {
  // Wait for QR canvas or image to be rendered before overlaying
  setTimeout(() => {
    let canvas = container.querySelector('canvas');
    let img = container.querySelector('img');
    
    if (!canvas && !img) {
      Logger.warn('QR canvas or img not found for monkey overlay');
      return;
    }
    
    try {
      // If there's an image, convert it to canvas for manipulation
      if (img && !canvas) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 160;
        tempCanvas.height = 160;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 160, 160);
        canvas = tempCanvas;
      }
      
      if (!canvas) return;
      
      const ctx = canvas.getContext('2d');
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const circleRadius = 28; // Circle around monkey
      
      // Draw white background circle
      ctx.beginPath();
      ctx.arc(centerX, centerY, circleRadius, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Draw subtle shadow
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      
      // Draw monkey SVG as image
      const svgData = `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
        <circle cx="22" cy="58" r="14" fill="#C8874B" />
        <circle cx="98" cy="58" r="14" fill="#C8874B" />
        <circle cx="22" cy="58" r="9" fill="#E8A570" />
        <circle cx="98" cy="58" r="9" fill="#E8A570" />
        <ellipse cx="60" cy="85" rx="26" ry="22" fill="#C8874B" />
        <ellipse cx="60" cy="88" rx="16" ry="14" fill="#E8A570" />
        <circle cx="60" cy="52" r="32" fill="#C8874B" />
        <ellipse cx="60" cy="60" rx="20" ry="16" fill="#E8A570" />
        <circle cx="50" cy="48" r="6" fill="white" />
        <circle cx="70" cy="48" r="6" fill="white" />
        <circle cx="51" cy="49" r="3.5" fill="#2D2D2D" />
        <circle cx="71" cy="49" r="3.5" fill="#2D2D2D" />
        <circle cx="52" cy="48" r="1.2" fill="white" />
        <circle cx="72" cy="48" r="1.2" fill="white" />
        <ellipse cx="60" cy="58" rx="6" ry="4" fill="#B8704A" />
        <circle cx="57.5" cy="57.5" r="1.5" fill="#8B4513" />
        <circle cx="62.5" cy="57.5" r="1.5" fill="#8B4513" />
        <path d="M51 64 Q60 71 69 64" stroke="#8B4513" stroke-width="1.8" fill="none" stroke-linecap="round" />
      </svg>`;
      
      const monkeyImg = new Image();
      monkeyImg.onload = () => {
        // Draw monkey image centered in the white circle (scaled to 40x40)
        const monkeySize = 40;
        ctx.drawImage(monkeyImg, centerX - monkeySize / 2, centerY - monkeySize / 2, monkeySize, monkeySize);
        Logger.success('Monkey overlay rendered on QR code');
        
        // If we created a temp canvas, update the container with it
        if (img && canvas !== container.querySelector('canvas')) {
          container.innerHTML = '';
          container.appendChild(canvas);
        }
      };
      monkeyImg.onerror = () => {
        Logger.error('Failed to load monkey SVG for overlay');
      };
      monkeyImg.src = 'data:image/svg+xml;base64,' + btoa(svgData);
    } catch (err) {
      Logger.error('Error overlaying monkey on QR', err);
    }
  }, 250);
}

function updateReceiverBadge() {
  const badge = document.getElementById('receiver-count-badge');
  const container = document.getElementById('receiver-list-container');
  if (!badge || !container) return;
  
  const count = peerConnections.size;
  if (count === 0) {
    badge.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  
  badge.style.display = 'block';
  badge.textContent = `${count} receiver${count > 1 ? 's' : ''} connected`;
  
  container.innerHTML = '';
  peerConnections.forEach((pc, peerId) => {
    const prog = peerProgress.get(peerId);
    const progressText = prog && prog.total > 0 ? Math.floor((prog.sent / prog.total) * 100) + '%' : 'Connecting...';
    const isDone = prog && prog.sent > 0 && prog.sent >= prog.total;
    
    container.innerHTML += `
      <div class="receiver-item">
        <div class="receiver-item-left">
          <span>📱</span>
          <span>Receiver ${peerId.substring(0,4)}</span>
        </div>
        <div class="receiver-progress">
          ${isDone ? '✅ Complete' : progressText}
        </div>
      </div>
    `;
  });
}

// ===== GENERATE CODE =====
function generateCode() {
  if (!selectedFile) return;
  
  // Real implementation
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let part1 = '', part2 = '';
  for (let i = 0; i < 3; i++) part1 += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 3; i++) part2 += chars[Math.floor(Math.random() * chars.length)];
  generatedCodeRaw = part1 + part2;

  Logger.success('Generated code', generatedCodeRaw);
  
  document.getElementById('display-code').textContent = part1 + ' • ' + part2;
  document.getElementById('code-chip-name').textContent = selectedFile.name;
  document.getElementById('code-chip-size').textContent = formatBytes(selectedFile.size);

  // Generate QR code with receiver URL
  const receiverUrl = `${SERVER_URL}/receive?code=${generatedCodeRaw}`;
  Logger.debug('QR receiver URL', receiverUrl);
  
  const qrContainer = document.getElementById('qr-canvas');
  if (qrContainer) {
    // Completely clear the container
    qrContainer.innerHTML = '';
    
    try {
      // Create a new instance with proper options
      const qrOptions = {
        text: receiverUrl,
        width: 160,
        height: 160,
        colorDark: '#6C5CE7',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
        useSVG: false
      };
      
      // Generate QR code
      new QRCode(qrContainer, qrOptions);
      Logger.success('QR code generated successfully');
      
      // Wait for the QR code canvas to be fully rendered
      setTimeout(() => {
        const canvas = qrContainer.querySelector('canvas');
        if (canvas) {
          Logger.debug('QR canvas found, overlaying monkey...');
          overlayMonkeyOnQR(qrContainer);
        } else {
          Logger.warn('QR canvas not found after generation');
        }
      }, 300);
    } catch (err) {
      Logger.error('QR generation failed', err);
      qrContainer.innerHTML = '<p style="color: red; font-size: 12px;">QR Error</p>';
    }
  } else {
    Logger.error('QR container not found');
  }

  showScreen('screen-code');
  updateReceiverBadge();
  
  // Connect to signaling server as sender
  isSender = true;
  
  // Pre-warm STUN connection (gather ICE candidates early)
  if (!preWarmConnection) {
    Logger.log('Pre-warming STUN connection...');
    preWarmConnection = new RTCPeerConnection(RTC_CONFIG);
    preWarmConnection.createDataChannel('warmup');
    // This triggers ICE gathering without needing full connection
  }
  
  // Notify server that sender is ready
  socket.emit('sender-ready', { code: generatedCodeRaw });
  Logger.log('Sent sender-ready event', { code: generatedCodeRaw });
  
  startTimer();
}

function startTimer() {
  clearInterval(timerInterval);
  let timerSeconds = EXPIRY_TIME;
  updateTimerDisplay(timerSeconds);
  
  timerInterval = setInterval(() => {
    timerSeconds--;
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      showToast('warning', 'Code Expired', 'This code is no longer valid.');
      socket.emit('code-expired', { code: generatedCodeRaw });
      resetAll();
    }
    updateTimerDisplay(timerSeconds);
  }, 1000);
}

function updateTimerDisplay(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2,'0');
  const s = (seconds % 60).toString().padStart(2,'0');
  const el = document.getElementById('timer-display');
  if (el) el.textContent = m + ':' + s;
}

// ===== RECEIVE INPUT =====
function handleCodeInput(input) {
  const val = input.value.trim().toUpperCase();
  input.value = val;
  document.getElementById('connect-btn').disabled = val.length < 6;
}

function startReceive() {
  const code = document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '');
  if (code.length < 6) return;
  
  isSender = false;
  const startTime = Date.now();
  Logger.success('Receiver starting connection', { code, timestamp: startTime });
  showScreen('screen-connecting');
  
  socket.emit('receiver-ready', { code, startTime });
}

// ===== CORE TRANSFER LOGIC =====

// Multi-receiver peer connection setup
function startPeerConnectionForReceiver(peerId) {
  Logger.log('Starting peer connection for receiver', peerId);
  
  if (peerConnections.has(peerId)) {
    Logger.warn('Peer connection already exists for', peerId);
    return;
  }
  
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections.set(peerId, pc);
  peerProgress.set(peerId, { sent: 0, total: 0 });
  
  // Add connection timeout (15 seconds) with user feedback
  const connectionTimer = setTimeout(() => {
    const state = pc.connectionState;
    if (state !== 'connected') {
      Logger.error('Connection timeout after 15 seconds for peerId', peerId);
      showToast('error', 'Connection Timeout', 'Taking longer than expected. Retrying...');
      
      // Auto-retry: emit receiver-ready again
      setTimeout(() => {
        Logger.log('Auto-retrying connection for peerId', peerId);
        const code = document.getElementById('receive-code-input')?.value?.replace(/[^A-Z0-9]/gi, '');
        if (code && code.length >= 6) {
          socket.emit('receiver-ready', { code, startTime: Date.now() });
        }
      }, 2000);
    }
  }, 15000);
  
  setupPeerConnectionListeners(peerId, pc);
  
  if (isSender) {
    // Sender creates offer
    try {
      const dc = pc.createDataChannel('file-transfer', { ordered: true, maxRetransmits: 3 });
      dataChannels.set(peerId, dc);
      setupDataChannelForReceiver(peerId, dc);
      
      pc.createOffer(RTC_OFFER_OPTIONS).then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('offer', { code: generatedCodeRaw, offer, peerId });
        Logger.log('Offer sent for peerId', peerId);
      }).catch(e => Logger.error('Offer creation failed:', e));
    } catch (e) {
      Logger.error('Data channel creation failed:', e.message);
    }
  } else {
    // Receiver waits for data channel
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      dataChannels.set(peerId, dc);
      setupDataChannelForReceiver(peerId, dc);
    };
  }
  
  // Clear timeout on successful connection
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      clearTimeout(connectionTimer);
      Logger.success('Connection established! Timeout cleared.', peerId);
    }
  };
}

// Track peer connection state for a specific receiver
function setupPeerConnectionListeners(peerId, pc) {
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    Logger.log('Connection state for peerId', peerId, state);
    
    if (state === 'connected') {
      if (!isSender) showScreen('screen-transfer');
    } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      if (isSender) {
        peerConnections.delete(peerId);
        dataChannels.delete(peerId);
        peerProgress.delete(peerId);
        updateReceiverBadge();
      } else {
        resetConnectionCore();
        showScreen('screen-send');
      }
    }
  };
  
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const code = isSender ? generatedCodeRaw : document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '');
      socket.emit('ice-candidate', { code, candidate: e.candidate, peerId });
    }
  };
  
  pc.onicecandidateerror = (e) => {
    Logger.warn('ICE error for peerId', peerId, e.errorCode);
  };
}

function setupDataChannelForReceiver(peerId, dc) {
  dc.binaryType = 'arraybuffer';
  
  dc.onopen = () => {
    Logger.success('Data channel open for peerId', peerId);
    if (isSender && selectedFile) {
      // Initialize progress tracking
      const prog = peerProgress.get(peerId) || { sent: 0, total: selectedFile.size };
      peerProgress.set(peerId, prog);
      updateReceiverBadge();
      
      showScreen('screen-transfer');
      if (!document.getElementById('transfer-filename').textContent) {
        document.getElementById('transfer-filename').textContent = selectedFile.name;
      }
      transferStartTime = Date.now();
      
      // Send metadata and start transfer for this receiver
      sendFileMetadataToReceiver(peerId, dc);
      setTimeout(() => sendFileChunksToReceiver(peerId, dc), 100);
    }
  };
  
  dc.onclose = () => {
    Logger.warn('Data channel closed for peerId', peerId);
  };
  
  dc.onerror = (e) => {
    Logger.error('Data channel error for peerId', peerId, e);
  };
  
  dc.onmessage = (e) => {
    if (!isSender) {
      handleDataMessage(e.data);
    }
  };
}

// Send file metadata to a specific receiver
function sendFileMetadataToReceiver(peerId, dc) {
  const meta = {
    type: 'METADATA',
    name: selectedFile.name,
    size: selectedFile.size,
    mimeType: selectedFile.type
  };
  dc.send(JSON.stringify(meta));
  Logger.log('Metadata sent to peerId', peerId);
}

// Send file chunks with adaptive chunk sizing per receiver
function sendFileChunksToReceiver(peerId, dc) {
  const prog = peerProgress.get(peerId);
  if (!prog) return;
  
  prog.total = selectedFile.size;
  let offset = 0;
  
  const sendChunk = () => {
    if (offset >= selectedFile.size) {
      dc.send(JSON.stringify({ type: 'END' }));
      prog.sent = prog.total;
      updateReceiverBadge();
      socket.emit('peer-complete', { code: generatedCodeRaw, peerId });
      return;
    }
    
    // Adaptive chunk sizing: default 64KB
    let chunkSize = 65536;
    const measuredSpeed = measuredSpeeds.get(peerId);
    if (measuredSpeed) {
      // Slow: 16KB, default: 64KB, fast: 256KB
      if (measuredSpeed < 100 * 1024) chunkSize = 16384;
      else if (measuredSpeed > 512 * 1024) chunkSize = 262144;
    }
    
    // Check buffered amount for backpressure (per receiver)
    if (dc.bufferedAmount > 16 * 1024 * 1024) {
      setTimeout(sendChunk, 50);
      return;
    }
    
    // Send from cache if available, otherwise read from file
    if (offset < chunkCache.length * CHUNK_SIZE && chunkCache[Math.floor(offset / CHUNK_SIZE)]) {
      const cacheIndex = Math.floor(offset / CHUNK_SIZE);
      const chunk = chunkCache[cacheIndex];
      dc.send(chunk);
      offset += chunk.byteLength;
      prog.sent += chunk.byteLength;
    } else {
      // Fall back to reading file directly if cache not available
      const reader = new FileReader();
      reader.onload = (e) => {
        const chunk = e.target.result;
        dc.send(chunk);
        offset += chunk.byteLength;
        prog.sent += chunk.byteLength;
        updateReceiverBadge();
        setTimeout(sendChunk, 0);
      };
      reader.readAsArrayBuffer(selectedFile.slice(offset, offset + chunkSize));
      return;
    }
    
    updateReceiverBadge();
    setTimeout(sendChunk, 0);
  };
  
  sendChunk();
}

function setupPeerConnectionListeners() {
  // Legacy function stub - real logic is in setupPeerConnectionListeners(peerId, pc)
  // This is kept for backward compatibility
}

function handleDataMessage(data) {
  try {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'METADATA') {
        receivedFileMetadata = msg;
        document.getElementById('transfer-filename').textContent = msg.name;
        transferStartTime = Date.now();
        lastBytesUpdate = 0; lastTimeUpdate = Date.now();
        showScreen('screen-transfer');
      } else if (msg.type === 'END') {
        completeReceive();
      }
    } else {
      receivedFileChunks.push(new Uint8Array(data));
      const received = receivedFileChunks.reduce((s, c) => s + c.length, 0);
      transferState.receivedBytes = received;
      updateRealProgress(received, receivedFileMetadata.size);
    }
  } catch(e) { Logger.error('Data message error:', e.message); }
}

function completeReceive() {
  const blob = new Blob(receivedFileChunks, { type: receivedFileMetadata.mimeType });
  receivedBlobUrl = URL.createObjectURL(blob);
  showComplete(receivedFileMetadata.name, receivedFileMetadata.size);
}

function downloadFile() {
  if (!receivedBlobUrl && receivedFileChunks.length === 0) return;
  if (!receivedBlobUrl) {
    const blob = new Blob(receivedFileChunks, { type: receivedFileMetadata.mimeType });
    receivedBlobUrl = URL.createObjectURL(blob);
  }
  const a = document.createElement('a');
  a.href = receivedBlobUrl;
  a.download = receivedFileMetadata?.name || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function updateRealProgress(current, total) {
  const progress = Math.min((current / total) * 100, 100);
  
  document.getElementById('transfer-percent').textContent = Math.floor(progress) + '%';
  document.getElementById('progress-fill').style.width = progress + '%';
  document.getElementById('transfer-bytes').textContent = formatBytes(current) + ' of ' + formatBytes(total);

  const now = Date.now();
  if (now - lastTimeUpdate > 500) {
    const elapsed = (now - lastTimeUpdate) / 1000;
    const bytesDiff = current - lastBytesUpdate;
    const speedBytes = bytesDiff / elapsed;
    document.getElementById('transfer-speed').textContent = formatBytes(speedBytes) + '/s';
    lastBytesUpdate = current;
    lastTimeUpdate = now;
  }
  
  const monkey = document.getElementById('transfer-monkey');
  if (monkey) {
    monkey.style.left = (15 + (progress / 100) * 55) + '%';
    monkey.style.bottom = (12 + Math.sin(progress * 0.3) * 15) + 'px';
  }
}

// ===== UI STATE UPDATES =====

function showComplete(fileName, fileSize) {
  clearInterval(timerInterval);
  document.getElementById('complete-filename').textContent = fileName;
  document.getElementById('complete-size').textContent = formatBytes(fileSize);
  showScreen('screen-complete');
  spawnConfetti();
  showToast('success', isSender ? 'File Sent!' : 'File Received!', 'Transfer completed successfully.');
}

function spawnConfetti() {
  const container = document.getElementById('confetti-container');
  if(!container) return;
  container.innerHTML = '';
  const colors = ['#6C5CE7', '#F9CA24', '#00B894', '#E17055', '#74B9FF', '#FD79A8'];
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement('div');
    piece.style.cssText = `
      position:absolute;
      width:${6+Math.random()*5}px;
      height:${6+Math.random()*5}px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      border-radius:${Math.random()>0.5?'50%':'3px'};
      left:${10+Math.random()*80}%;
      top:${10+Math.random()*30}%;
      animation: confettiFall ${1+Math.random()*0.8}s ease-out ${Math.random()*0.5}s forwards;
    `;
    container.appendChild(piece);
  }
}

// ===== SOCKET.IO =====
function initSocket() {
  Logger.log(`Connecting to ${SERVER_URL}`);
  try {
    socket = io(SERVER_URL, {
      reconnection: true,
      reconnectionDelay: 100,        // Reduced from 300ms for faster reconnection
      reconnectionDelayMax: 500,     // Reduced from 1000ms
      reconnectionAttempts: 10,      // Reduced from 15
      transports: ['websocket'],     // WebSocket only, disable polling for lower latency
      upgrade: false,                // Disable upgrade attempts
      path: '/socket.io/',
      extraHeaders: { 'X-Requested-With': 'XMLHttpRequest' }
    });
  } catch(e) { Logger.error('Socket init failed:', e.message); return; }

  socket.on('connect', () => { Logger.success('Connected', socket.id); document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--green)'); });
  socket.on('disconnect', r => { Logger.warn('Disconnected', r); document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--red)'); });
  socket.on('connect_error', e => { Logger.error('Connection error:', e.message); });
  socket.on('error', d => { Logger.error('Server error:', d); showToast('error', 'Error', d?.message||'Server error'); });
  socket.on('reconnect', () => { document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--green)'); });

  socket.on('sender-ready-ack', d => Logger.success('Sender ACK', d));
  
  // Multi-receiver: receiver joins and gets a peerId
  socket.on('receiver-joined', (data) => {
    const peerId = data.peerId;
    Logger.success('Receiver joined!', peerId);
    startPeerConnectionForReceiver(peerId);
  });
  
  // Receiver receives ready acknowledgment with peerId
  socket.on('receiver-ready-ack', (data) => {
    const peerId = data.peerId;
    const startTime = data.startTime;
    const elapsed = startTime ? Date.now() - startTime : 0;
    Logger.log('Receiver ready ACK with peerId', { peerId, elapsed: `${elapsed}ms` });
    myPeerId = peerId;
    startPeerConnectionForReceiver(peerId);
  });

  // WebRTC offer routed by peerId
  socket.on('offer', async data => {
    try {
      const peerId = data.peerId || (isSender ? null : myPeerId);
      const pc = isSender ? peerConnections.get(peerId) : peerConnection;
      
      if (!pc) {
        Logger.warn('No peer connection found for peerId', peerId);
        return;
      }
      
      const startTime = data.startTime;
      const elapsed = startTime ? Date.now() - startTime : 0;
      Logger.log('Received offer for peerId', { peerId, elapsed: `${elapsed}ms` });
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { code: generatedCodeRaw || document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, ''), answer, peerId, startTime });
    } catch(e) { Logger.error('Offer handling failed:', e.message); }
  });

  // WebRTC answer routed by peerId
  socket.on('answer', async data => {
    try {
      const peerId = data.peerId;
      const pc = peerConnections.get(peerId);
      if (!pc) {
        Logger.warn('No peer connection found for answer peerId', peerId);
        return;
      }
      const startTime = data.startTime;
      const elapsed = startTime ? Date.now() - startTime : 0;
      Logger.log('Received answer for peerId', { peerId, elapsed: `${elapsed}ms` });
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
    catch(e) { Logger.error('Answer handling failed:', e.message); }
  });

  // ICE candidate routed by peerId
  socket.on('ice-candidate', async data => {
    try {
      const peerId = data.peerId || (isSender ? null : myPeerId);
      const pc = isSender ? peerConnections.get(peerId) : peerConnection;
      if (!pc) return;
      if(data.candidate) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
    catch(e) { Logger.error('ICE candidate error:', e.message); }
  });

  // Peer completed transfer
  socket.on('peer-complete', (data) => {
    const peerId = data.peerId;
    Logger.success('Peer completed transfer', peerId);
    const prog = peerProgress.get(peerId);
    if (prog) {
      prog.sent = prog.total; // Mark as complete
      updateReceiverBadge();
    }
  });

  socket.on('peer-disconnected', (data) => {
    const peerId = data.peerId;
    Logger.warn('Peer disconnected', peerId);
    if (isSender) {
      peerConnections.delete(peerId);
      dataChannels.delete(peerId);
      peerProgress.delete(peerId);
      updateReceiverBadge();
    } else {
      showToast('warning', 'Disconnected', 'The sender disconnected');
      resetConnectionCore();
      showScreen('screen-send');
    }
  });
  
  socket.on('code-expired', () => { showToast('warning', 'Code expired', 'This code is no longer valid'); resetConnectionCore(); showScreen('screen-send'); });
}

function resetConnectionCore() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (dataChannel) { try { dataChannel.close(); } catch(e){} }
  if (peerConnection) { try { peerConnection.close(); } catch(e){} }
  peerConnection = null; dataChannel = null; peerConnectionPreCreated = false;
  receivedFileChunks = []; receivedFileMetadata = null;
  if (receivedBlobUrl) { URL.revokeObjectURL(receivedBlobUrl); receivedBlobUrl = null; }
  transferState = { isTransferring: false, totalSize: 0, sentBytes: 0, receivedBytes: 0 };
}

function resetAll() {
  resetConnectionCore();
  removeFile();
  document.getElementById('receive-code-input').value = '';
  document.getElementById('connect-btn').disabled = true;
  generatedCodeRaw = '';
  showScreen('screen-send');
  switchTab('send');
}

// UI Buttons actions
function copyCode() {
  const code = generatedCodeRaw;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).catch(() => {});
  }
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
  showToast('success', 'Share Code', `Use code: ${generatedCodeRaw}`);
}

function initTheme() {
  const saved = localStorage.getItem('droply-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('droply-theme', theme);
  // Update the settings label
  const themeLabel = document.querySelector('#theme-toggle-item .settings-item-value');
  if (themeLabel) {
    themeLabel.innerHTML = `${theme === 'dark' ? 'Dark' : 'Light'} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  showToast('success', 'Theme Changed', `Switched to ${next} mode`);
}

function clearHistory() {
  showToast('success', 'History Cleared', 'Transfer history has been cleared.');
}

function showToast(type, title, msg) {
  const container = document.getElementById('toast-container');
  if(!container) return;
  const icons = { success: '✅', warning: '⚠️', error: '📡', info: '💡' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || '📢'}</span><div class="toast-content"><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div></div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
