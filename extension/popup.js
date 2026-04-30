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
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun2.l.google.com:19302'] },
    { urls: ['stun:stun3.l.google.com:19302'] },
    { urls: ['stun:stun4.l.google.com:19302'] }
  ],
  iceCandidatePoolSize: 15
};
const RTC_OFFER_OPTIONS = { offerToReceiveAudio: false, offerToReceiveVideo: false, voiceActivityDetection: false, iceRestart: false };
const CHUNK_SIZE = 65536;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const EXPIRY_TIME = 300;
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
let socket = null, peerConnection = null, dataChannel = null, selectedFile = null;
let isSender = false, peerConnectionPreCreated = false;
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
}

function removeFile() {
  selectedFile = null;
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

// ===== GENERATE CODE =====
function generateCode() {
  if (!selectedFile) return;
  
  // Real implementation
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let part1 = '', part2 = '';
  for (let i = 0; i < 3; i++) part1 += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 3; i++) part2 += chars[Math.floor(Math.random() * chars.length)];
  generatedCodeRaw = part1 + part2;

  document.getElementById('display-code').textContent = part1 + ' • ' + part2;
  document.getElementById('code-chip-name').textContent = selectedFile.name;
  document.getElementById('code-chip-size').textContent = formatBytes(selectedFile.size);

  showScreen('screen-code');
  
  // Connect to signaling server
  isSender = true;
  
  // Pre-create peer connection
  if (!peerConnection && !peerConnectionPreCreated) {
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionPreCreated = true;
    setupPeerConnectionListeners();
  }
  
  socket.emit('sender-ready', { code: generatedCodeRaw });
  
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
  showScreen('screen-connecting');
  
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    setupPeerConnectionListeners();
    peerConnection.ondatachannel = e => { dataChannel = e.channel; setupDataChannel(); };
  }
  
  socket.emit('receiver-ready', { code });
  
  setTimeout(() => {
    if (peerConnection?.connectionState !== 'connected') {
      showToast('error', 'Timeout', 'Could not connect. Check the code and try again.');
      resetAll();
      showScreen('screen-send');
      switchTab('receive');
    }
  }, CONNECTION_TIMEOUT);
}

// ===== CORE TRANSFER LOGIC =====

function setupPeerConnectionListeners() {
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    Logger.log('Connection state:', state);
    if (state === 'connected') {
      if (!isSender) showScreen('screen-transfer'); // receiver goes to transfer when connected
    } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      if (state === 'failed' || state === 'disconnected') showToast('error', 'Connection lost', 'The other device disconnected.');
      resetConnectionCore();
    }
  };
  
  peerConnection.onicecandidate = e => {
    if (e.candidate) {
      const code = isSender ? generatedCodeRaw : document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, '');
      socket.emit('ice-candidate', { code, candidate: e.candidate });
    }
  };
}

async function startPeerConnection() {
  try {
    dataChannel = peerConnection.createDataChannel('file-transfer', { ordered: true, maxRetransmits: 3 });
    setupDataChannel();
    const offer = await peerConnection.createOffer(RTC_OFFER_OPTIONS);
    await peerConnection.setLocalDescription(offer);
    const code = generatedCodeRaw;
    socket.emit('offer', { code, offer });
  } catch(e) { Logger.error('Peer connection failed:', e.message); }
}

function setupDataChannel() {
  if (!dataChannel) return;
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.onopen = () => {
    Logger.success('Data channel open');
    if (isSender && selectedFile) {
      showScreen('screen-transfer');
      document.getElementById('transfer-filename').textContent = selectedFile.name;
      transferStartTime = Date.now();
      sendFileMetadata();
      setTimeout(() => sendFileChunks(), 100);
    }
  };
  dataChannel.onclose = () => Logger.warn('Data channel closed');
  dataChannel.onerror = e => Logger.error('Data channel error:', e);
  dataChannel.onmessage = e => {
    handleDataMessage(e.data);
  };
}

function sendFileMetadata() {
  const meta = { type: 'METADATA', name: selectedFile.name, size: selectedFile.size, mimeType: selectedFile.type };
  dataChannel.send(JSON.stringify(meta));
}

function sendFileChunks() {
  transferState = { isTransferring: true, totalSize: selectedFile.size, sentBytes: 0, receivedBytes: 0 };
  lastBytesUpdate = 0; lastTimeUpdate = Date.now();
  const reader = new FileReader();
  let offset = 0;

  const readNext = () => {
    if (offset >= selectedFile.size) {
      dataChannel.send(JSON.stringify({ type: 'END' }));
      transferState.isTransferring = false;
      showComplete(selectedFile.name, selectedFile.size);
      return;
    }
    reader.readAsArrayBuffer(selectedFile.slice(offset, offset + CHUNK_SIZE));
  };

  reader.onload = e => {
    const chunk = e.target.result;
    if (dataChannel.bufferedAmount > 16 * 1024 * 1024) { setTimeout(readNext, 50); return; }
    dataChannel.send(chunk);
    offset += CHUNK_SIZE;
    transferState.sentBytes += chunk.byteLength;
    updateRealProgress(transferState.sentBytes, transferState.totalSize);
    setTimeout(readNext, 0);
  };
  readNext();
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
      reconnection: true, reconnectionDelay: 300, reconnectionDelayMax: 1000,
      reconnectionAttempts: 15, transports: ['websocket','polling'], upgrade: true,
      path: '/socket.io/', extraHeaders: { 'X-Requested-With': 'XMLHttpRequest' }
    });
  } catch(e) { Logger.error('Socket init failed:', e.message); return; }

  socket.on('connect', () => { Logger.success('Connected', socket.id); document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--green)'); });
  socket.on('disconnect', r => { Logger.warn('Disconnected', r); document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--red)'); });
  socket.on('connect_error', e => { Logger.error('Connection error:', e.message); });
  socket.on('error', d => { Logger.error('Server error:', d); showToast('error', 'Error', d?.message||'Server error'); });
  socket.on('reconnect', () => { document.querySelectorAll('.status-dot').forEach(el => el.style.background = 'var(--green)'); });

  socket.on('sender-ready-ack', d => Logger.success('Sender ACK', d));
  socket.on('receiver-ready', () => { Logger.success('Receiver joined!'); startPeerConnection(); });

  socket.on('offer', async data => {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { code: document.getElementById('receive-code-input').value.replace(/[^A-Z0-9]/gi, ''), answer });
    } catch(e) { Logger.error('Offer handling failed:', e.message); }
  });

  socket.on('answer', async data => {
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer)); }
    catch(e) { Logger.error('Answer handling failed:', e.message); }
  });

  socket.on('ice-candidate', async data => {
    try { if(data.candidate) await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch(e) { Logger.error('ICE candidate error:', e.message); }
  });

  socket.on('peer-disconnected', () => { showToast('warning', 'Disconnected', 'The other device disconnected'); resetConnectionCore(); showScreen('screen-send'); });
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
