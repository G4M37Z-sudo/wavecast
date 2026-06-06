import {
  connectPresence,
  connectRoom,
  createPeerConnection,
  addSenderTracks,
  formatElapsed,
  buildPairRequestMessage,
  buildCaptureConstraints,
  RESOLUTION_PRESETS,
  apiBaseUrl
} from './common.js';

// --- DOM refs ---
const ssidBanner = document.querySelector('#ssidBanner');
const senderName = document.querySelector('#senderName');
const resolutionSelect = document.querySelector('#resolutionSelect');
const includeAudio = document.querySelector('#includeAudio');
const startButton = document.querySelector('#startShare');
const stopButton = document.querySelector('#stopShare');
const previewWrap = document.querySelector('#previewWrap');
const previewPlaceholder = document.querySelector('#previewPlaceholder');
const localPreview = document.querySelector('#localPreview');
const previewMeta = document.querySelector('#previewMeta');
const devicesList = document.querySelector('#devicesList');
const deviceCount = document.querySelector('#deviceCount');
const devicesHint = document.querySelector('#devicesHint');
const castButton = document.querySelector('#castSelected');
const globalStatus = document.querySelector('#globalStatus');
const toastStack = document.querySelector('#toastStack');

// Code/QR panel
const generateCodeButton = document.querySelector('#generateCode');
const castWithCodeButton = document.querySelector('#castWithCode');
const codeInput = document.querySelector('#codeInput');
const codeValueEl = document.querySelector('#codeValue');
const codeDisplay = document.querySelector('#codeDisplay');
const qrImage = document.querySelector('#qrImage');
const qrWrap = document.querySelector('#qrWrap');
const codeStatus = document.querySelector('#codeStatus');

// Tabs
const tabs = document.querySelectorAll('.tab');
const tabPanels = document.querySelectorAll('.tab-panel');

// --- App state ---
const state = {
  myPeerId: null,
  senderStream: null,
  receivers: new Map(),
  pairings: new Map(),     // peerId -> { pc, ws, requestId, status, startedAt }
  selectedIds: new Set(),
  generatedCode: null,     // room code we generated (QR)
  generatedRequestId: null // requestId of the pending pair
};

// --- SSID ---
async function loadNetwork() {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/network`);
    const data = await res.json();
    const ssid = data.ssid || 'This network';
    const isFallback = data.source === 'fallback';
    ssidBanner.classList.toggle('fallback', isFallback);
    ssidBanner.innerHTML = `
      <span class="dot"></span>
      <span><strong style="color: var(--text);">${escapeHtml(ssid)}</strong>${isFallback ? ' (Wi-Fi not detected on this PC)' : ''}</span>
    `;
    return ssid;
  } catch (error) {
    ssidBanner.innerHTML = `<span class="dot"></span><span>Network unavailable</span>`;
    return 'This network';
  }
}

// --- Tabs ---
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => {
      const isActive = t === tab;
      t.classList.toggle('tab--active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    tabPanels.forEach((p) => {
      p.hidden = p.dataset.panel !== target;
    });
  });
});

// --- Presence ---
let presence = null;
function openPresence() {
  presence = connectPresence({
    onWelcome({ peerId }) {
      state.myPeerId = peerId;
      presence.send({ type: 'register', role: 'sender', name: senderName.value.trim() || 'Sender' });
    },
    onSnapshot(peers) { syncReceivers(peers); },
    onUpdate({ peer, gone }) {
      if (gone) {
        state.receivers.delete(peer.peerId);
        teardownPairing(peer.peerId);
      } else {
        const existing = state.receivers.get(peer.peerId);
        if (existing) {
          existing.name = peer.name;
          existing.lastSeen = peer.lastSeen;
        } else if (peer.role === 'receiver') {
          state.receivers.set(peer.peerId, {
            peerId: peer.peerId,
            name: peer.name,
            lastSeen: peer.lastSeen,
            status: 'idle',
            connectedAt: Date.now()
          });
        }
      }
      renderDevices();
    },
    onPairRequestSent({ requestId }) {
      const pending = [...state.pairings.values()].find((p) => p.status === 'pending' && p.kind !== 'room');
      if (pending) pending.requestId = requestId;
    },
    onPairInvite(handlerArgs) { /* handled via dedicated message listener below */ },
    onPairResult({ requestId, accepted, reason, room, receiverId }) {
      // 1. Try exact requestId match (tap-to-pair: we stored requestId)
      let entry;
      if (requestId) {
        entry = [...state.pairings.entries()].find(([, p]) => p.requestId === requestId);
      }
      // 2. Code/QR flow: match by room code (unique per pending pairing).
      //    When accepted, receiverId is the real peerId — re-key the entry under it
      //    so startWebRtcForPair gets the correct peerId for the RTCPeerConnection.
      if (!entry && room) {
        entry = [...state.pairings.entries()].find(([, p]) => p.room === room && p.status === 'pending');
      }
      if (!entry) return;
      const [oldKey, pairing] = entry;

      if (accepted) {
        // Re-key under the real receiverId so WebRTC uses the right peerId
        const finalPeerId = receiverId || oldKey;
        if (finalPeerId !== oldKey) {
          state.pairings.delete(oldKey);
          state.pairings.set(finalPeerId, pairing);
        }
        pairing.status = 'connected';
        pairing.startedAt = Date.now();
        pairing.room = room;
        const receiver = state.receivers.get(finalPeerId);
        if (receiver) receiver.status = 'connected';
        startWebRtcForPair(finalPeerId, room, pairing);
        renderDevices();
        toast(`Connected to ${receiver?.name || finalPeerId}`, 'success');
        setGlobalStatus(`Streaming to ${receiver?.name || finalPeerId}.`, 'success');
      } else {
        pairing.ws?.close();
        pairing.pc?.close();
        state.pairings.delete(oldKey);
        if (receiverId && state.receivers.has(receiverId)) {
          state.receivers.get(receiverId).status = reason === 'expired' ? 'expired' : 'denied';
        }
        renderDevices();
        toast(`Pairing ${reason || 'denied'}`, reason === 'expired' ? 'warning' : 'danger');
      }
    },
    onPairExpired() {
      const entry = [...state.pairings.entries()].find(([, p]) => p.status === 'pending');
      if (!entry) return;
      const [peerId] = entry;
      teardownPairing(peerId);
      if (state.receivers.has(peerId)) state.receivers.get(peerId).status = 'expired';
      renderDevices();
    },
    onError({ error }) { toast(`Signaling error: ${error}`, 'danger'); },
    onClose() {
      setGlobalStatus('Disconnected from signaling. Reconnecting…', 'warning');
      setTimeout(openPresence, 2000);
    }
  });

  // Receiver-initiated invite: a receiver picked us from the discovery list
  // and wants us to cast to them. Show a prompt; if they accept we initiate
  // a normal pair-request back to that receiver.
  presence.ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== 'pair-invite') return;

    const receiverId = message.receiverId;
    const receiverName = message.receiverName || 'A receiver';
    if (!state.senderStream) {
      toast(`${receiverName} wants to receive, but you're not sharing yet.`, 'warning');
      return;
    }
    showInviteModal({ receiverId, receiverName });
  });
}

function syncReceivers(peers) {
  state.receivers.clear();
  for (const peer of peers) {
    if (peer.peerId === state.myPeerId) continue;
    if (peer.role !== 'receiver') continue;
    state.receivers.set(peer.peerId, {
      peerId: peer.peerId,
      name: peer.name,
      lastSeen: peer.lastSeen,
      status: 'idle',
      connectedAt: Date.now()
    });
  }
  renderDevices();
}

async function renderDevices(ssid) {
  const receivers = [...state.receivers.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  deviceCount.textContent = String(receivers.length);
  if (ssid) devicesHint.innerHTML = `Devices on <strong style="color: var(--text);">${escapeHtml(ssid)}</strong>`;
  else if (receivers.length > 0) devicesHint.textContent = `${receivers.length} ${receivers.length === 1 ? 'device' : 'devices'} on this network`;

  if (receivers.length === 0) {
    devicesList.innerHTML = `
      <li class="empty-state">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="13" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <div>No receivers found yet</div>
        <div class="hint">Open <code>/receiver</code> on the device you want to cast to.</div>
      </li>
    `;
    castButton.disabled = true;
    return;
  }

  castButton.disabled = state.selectedIds.size === 0 || !state.senderStream;

  devicesList.innerHTML = receivers.map((r) => {
    const checked = state.selectedIds.has(r.peerId) ? 'checked' : '';
    const disabled = r.status === 'pending' || r.status === 'connected' ? 'disabled' : '';
    return `
      <li class="device-item" data-peer-id="${r.peerId}">
        <input type="checkbox" ${checked} ${disabled} aria-label="Select ${escapeHtml(r.name)}" />
        <div class="device-name">
          <span>${escapeHtml(r.name)}</span>
          <span class="sub">${statusSubText(r)}</span>
        </div>
        <span class="status status--${r.status}">
          <span class="glyph"></span>
          <span class="status-text">${statusText(r)}</span>
        </span>
      </li>
    `;
  }).join('');

  for (const li of devicesList.querySelectorAll('.device-item')) {
    const peerId = li.dataset.peerId;
    const cb = li.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedIds.add(peerId);
      else state.selectedIds.delete(peerId);
      castButton.disabled = state.selectedIds.size === 0 || !state.senderStream;
    });
  }
}

function statusText(r) {
  if (r.status === 'pending') return 'Waiting…';
  if (r.status === 'connected') {
    const pairing = state.pairings.get(r.peerId);
    const elapsed = pairing?.startedAt ? Math.floor((Date.now() - pairing.startedAt) / 1000) : 0;
    return `Connected ${formatElapsed(elapsed)}`;
  }
  if (r.status === 'denied') return 'Denied';
  if (r.status === 'expired') return 'Timed out';
  return 'Ready';
}

function statusSubText(r) {
  if (r.status === 'connected') return 'Streaming now';
  if (r.status === 'pending') return 'Awaiting their approval';
  if (r.status === 'denied') return 'They declined this pairing';
  if (r.status === 'expired') return 'No response in 30s';
  return 'Select to invite';
}

// --- Capture / share ---
async function startCapture() {
  if (state.senderStream) stopCapture();
  try {
    const constraints = buildCaptureConstraints({
      resolution: resolutionSelect.value,
      audio: includeAudio.checked
    });
    const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    state.senderStream = stream;
    localPreview.srcObject = stream;
    localPreview.style.display = 'block';
    previewPlaceholder.style.display = 'none';
    previewWrap.classList.add('live');

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    const preset = RESOLUTION_PRESETS[resolutionSelect.value];
    const meta = settings
      ? `${settings.width || preset.width || 'auto'}×${settings.height || preset.height || 'auto'} @ ${settings.frameRate || preset.fps}fps${includeAudio.checked ? ' · audio' : ''}`
      : `${preset.label}${includeAudio.checked ? ' · audio' : ''}`;
    previewMeta.textContent = meta;
    previewMeta.style.display = 'flex';

    startButton.textContent = 'Restart sharing';
    startButton.classList.remove('btn--primary');
    startButton.classList.add('btn--ghost');
    stopButton.disabled = false;

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      toast('Screen share ended by system', 'warning');
      stopCapture();
    });

    setGlobalStatus('Sharing active. Select receivers or use a code to cast.', 'info');
    renderDevices();
  } catch (error) {
    toast(`Could not start sharing: ${error.message}`, 'danger');
  }
}

function stopCapture() {
  for (const track of state.senderStream?.getTracks() ?? []) track.stop();
  state.senderStream = null;
  localPreview.srcObject = null;
  localPreview.style.display = 'none';
  previewPlaceholder.style.display = 'flex';
  previewWrap.classList.remove('live');
  previewMeta.style.display = 'none';
  startButton.textContent = 'Start sharing';
  startButton.classList.add('btn--primary');
  startButton.classList.remove('btn--ghost');
  stopButton.disabled = true;

  for (const peerId of [...state.pairings.keys()]) teardownPairing(peerId);
  for (const r of state.receivers.values()) {
    if (r.status === 'connected' || r.status === 'pending') r.status = 'idle';
  }
  setGlobalStatus('Stopped. Click Start sharing to cast again.', 'info');
  renderDevices();
}

// --- Tap-to-pair flow (devices list) ---
function castToSelected() {
  if (!state.senderStream) { toast('Start sharing first', 'warning'); return; }
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  state.selectedIds.clear();
  castButton.disabled = true;
  for (const peerId of ids) {
    const receiver = state.receivers.get(peerId);
    if (!receiver) continue;
    if (receiver.status === 'connected' || receiver.status === 'pending') continue;
    receiver.status = 'pending';
    state.pairings.set(peerId, { status: 'pending', startedAt: null, room: null, kind: 'tap' });
    presence.send(buildPairRequestMessage({ receiverId: peerId }));
  }
  renderDevices();
}

// --- Code/QR flow ---
function waitForPeerId(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (state.myPeerId) return resolve(state.myPeerId);
    const started = Date.now();
    const tick = () => {
      if (state.myPeerId) return resolve(state.myPeerId);
      if (Date.now() - started > timeoutMs) return reject(new Error('Not connected to server'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function generateCode() {
  if (!state.senderStream) { toast('Start sharing first', 'warning'); return; }
  let peerId;
  try {
    peerId = await waitForPeerId();
  } catch (error) {
    toast(error.message, 'danger');
    return;
  }
  try {
    const res = await fetch(`${apiBaseUrl()}/api/pairing/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: peerId, senderName: senderName.value.trim() || 'Sender' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const { room, requestId } = await res.json();
    state.generatedCode = room;
    state.generatedRequestId = requestId;

    // Generate QR for the receiver URL
    const qrRes = await fetch(`${apiBaseUrl()}/api/pairing?room=${encodeURIComponent(room)}`);
    const qrData = await qrRes.json();
    qrImage.src = qrData.qrDataUrl;
    qrWrap.style.display = 'grid';
    codeValueEl.textContent = room;
    codeDisplay.style.display = 'flex';
    castWithCodeButton.disabled = false;
    codeInput.value = room;

    setCodeStatus(`Code ${room} ready. Receiver can scan the QR or type the code. Awaiting them to connect.`, 'info');
    toast(`Code ${room} generated`, 'success');
  } catch (error) {
    toast(`Could not generate code: ${error.message}`, 'danger');
  }
}

function castWithCode() {
  const room = (codeInput.value || state.generatedCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!room) { toast('Enter or generate a code first', 'warning'); return; }
  if (!state.senderStream) { toast('Start sharing first', 'warning'); return; }
  if (!state.myPeerId) { toast('Not connected to server', 'danger'); return; }

  if (!state.generatedRequestId) {
    reserveForRoom(room).then(({ requestId }) => {
      state.pairings.set(`__room_${room}`, { status: 'pending', startedAt: null, room, requestId, kind: 'room' });
      enterWaitingMode(room);
    }).catch((error) => {
      toast(`Could not set up code pairing: ${error.message}`, 'danger');
    });
    return;
  }

  state.pairings.set(`__room_${room}`, { status: 'pending', startedAt: null, room, requestId: state.generatedRequestId, kind: 'room' });
  enterWaitingMode(room);
}

async function reserveForRoom(room) {
  const peerId = await waitForPeerId();
  const res = await fetch(`${apiBaseUrl()}/api/pairing/reserve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderId: peerId, senderName: senderName.value.trim() || 'Sender', room })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  state.generatedCode = data.room;
  state.generatedRequestId = data.requestId;
  return { room: data.room, requestId: data.requestId };
}

function enterWaitingMode(room) {
  setCodeStatus(`Awaiting receiver to join room ${room}…`, 'info');
  toast(`Waiting for someone to join ${room}`, 'info');
}

// --- WebRTC per-pairing lifecycle ---
function startWebRtcForPair(peerId, room, pairing) {
  const pc = createPeerConnection((candidate) => pairing.ws?.send(JSON.stringify({ type: 'ice-candidate', candidate })));
  // Use addTransceiver with explicit sendonly direction. This makes the SDP
  // unambiguous regardless of whether the browser respects offerToReceive
  // flags on createOffer. With addTrack + createOffer(offerToReceiveVideo:false)
  // some browsers leave the transceiver direction as 'sendrecv' which can
  // leave the receiver in a buffering state.
  const videoTracks = state.senderStream.getVideoTracks();
  const audioTracks = state.senderStream.getAudioTracks();
  if (videoTracks.length === 0) {
    toast('No video track in the capture stream — pick a screen/window/tab', 'danger');
    return;
  }
  for (const track of videoTracks) {
    pc.addTransceiver(track, { direction: 'sendonly', streams: [state.senderStream] });
  }
  for (const track of audioTracks) {
    pc.addTransceiver(track, { direction: 'sendonly', streams: [state.senderStream] });
  }
  pairing.room = room;

  const ws = connectRoom({
    room,
    role: 'sender',
    onPeerReady: async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('[webrtc] sender offer created, sending to receiver');
        ws.send({ type: 'offer', sdp: offer.sdp });
      } catch (error) {
        console.error('[webrtc] sender offer failed:', error);
        toast(`WebRTC error: ${error.message}`, 'danger');
      }
    },
    onSignal: async (message) => {
      try {
        if (message.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          console.log('[webrtc] sender applied answer');
        } else if (message.type === 'ice-candidate') {
          if (message.candidate) {
            await pc.addIceCandidate(message.candidate);
          } else {
            console.log('[webrtc] sender: end-of-candidates from receiver');
          }
        }
      } catch (error) { toast(`Signaling error: ${error.message}`, 'danger'); }
    },
    onPeerLeft: () => {
      teardownPairing(peerId);
      const r = state.receivers.get(peerId);
      if (r) r.status = 'idle';
      renderDevices();
      toast(`${r?.name || peerId} disconnected`, 'warning');
    },
    onClose: () => {
      teardownPairing(peerId);
      const r = state.receivers.get(peerId);
      if (r && r.status === 'connected') r.status = 'idle';
      renderDevices();
    }
  });

  pairing.pc = pc;
  pairing.ws = ws;

  pc.addEventListener('connectionstatechange', () => {
    console.log('[webrtc] sender connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      toast('Cast is live', 'success');
    } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      teardownPairing(peerId);
      const r = state.receivers.get(peerId);
      if (r) r.status = 'idle';
      renderDevices();
      if (pc.connectionState === 'failed') {
        toast('WebRTC failed — check both devices are on the same network', 'danger');
      }
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log('[webrtc] sender ICE state:', pc.iceConnectionState);
  });
}

function teardownPairing(peerId) {
  const pairing = state.pairings.get(peerId);
  if (!pairing) return;
  try { pairing.ws?.close(); } catch {}
  try { pairing.pc?.close(); } catch {}
  state.pairings.delete(peerId);
}

// --- Status helpers ---
function setGlobalStatus(text, kind = 'info') {
  globalStatus.textContent = text;
  globalStatus.className = `status-banner status-banner--${kind}`;
  globalStatus.style.display = 'flex';
}

function setCodeStatus(text, kind = 'info') {
  codeStatus.textContent = text;
  codeStatus.className = `status-banner status-banner--${kind}`;
  codeStatus.style.display = 'flex';
}

// --- Invite modal: receiver asked us to cast to them ---
let inviteModalEl = null;
let inviteCountdownTimer = null;
let inviteCountdownSeconds = 30;
let inviteReceiverId = null;

function showInviteModal({ receiverId, receiverName }) {
  hideInviteModal();
  inviteReceiverId = receiverId;
  inviteCountdownSeconds = 30;
  inviteModalEl = document.createElement('div');
  inviteModalEl.className = 'modal-backdrop';
  inviteModalEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="inviteTitle">
      <h2 id="inviteTitle">
        <svg class="icon-broadcast" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
          <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
          <circle cx="12" cy="20" r="1.5" fill="currentColor"/>
        </svg>
        Outgoing cast request
      </h2>
      <div class="modal-body">
        <strong>"${escapeHtml(receiverName)}"</strong> wants you to cast your screen to it.
        If you allow, your current sharing session will be sent to that device.
      </div>
      <div class="modal-countdown">
        <div class="ring" data-s="${inviteCountdownSeconds}" style="--p: 1;"></div>
        <span>Auto-decline in <strong>${inviteCountdownSeconds}s</strong> if you don't respond.</span>
      </div>
      <div class="modal-actions">
        <button class="btn btn--ghost" data-action="deny">Decline</button>
        <button class="btn btn--primary" data-action="accept">Allow & cast</button>
      </div>
    </div>
  `;
  document.body.appendChild(inviteModalEl);

  inviteModalEl.addEventListener('click', (e) => { if (e.target === inviteModalEl) denyInvite(); });
  inviteModalEl.querySelector('[data-action="accept"]').addEventListener('click', acceptInvite);
  inviteModalEl.querySelector('[data-action="deny"]').addEventListener('click', denyInvite);

  inviteCountdownTimer = setInterval(() => {
    inviteCountdownSeconds -= 1;
    if (inviteCountdownSeconds <= 0) { denyInvite(); return; }
    const ring = inviteModalEl?.querySelector('.ring');
    const strong = inviteModalEl?.querySelector('.modal-countdown strong');
    if (ring) {
      ring.dataset.s = String(inviteCountdownSeconds);
      ring.style.setProperty('--p', String(inviteCountdownSeconds / 30));
    }
    if (strong) strong.textContent = `${inviteCountdownSeconds}s`;
  }, 1000);
}

function hideInviteModal() {
  if (inviteCountdownTimer) clearInterval(inviteCountdownTimer);
  inviteCountdownTimer = null;
  inviteModalEl?.remove();
  inviteModalEl = null;
  inviteReceiverId = null;
}

function acceptInvite() {
  const receiverId = inviteReceiverId;
  hideInviteModal();
  if (!receiverId) return;

  // Initiate a normal pair-request to that receiver. They'll see a
  // pair-offer and the existing flow handles the rest (consent modal,
  // WebRTC setup).
  const receiver = state.receivers.get(receiverId) || { peerId: receiverId, name: 'Receiver' };
  receiver.status = 'pending';
  state.pairings.set(receiverId, { status: 'pending', startedAt: null, room: null, kind: 'tap' });
  presence.send(buildPairRequestMessage({ receiverId }));
  renderDevices();
  toast(`Casting to ${receiver.name}…`, 'success');
}

function denyInvite() {
  const receiverId = inviteReceiverId;
  hideInviteModal();
  if (receiverId) toast('Cast request declined', 'info');
}

let toastCounter = 0;
function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = text;
  toastStack.appendChild(el);
  const id = ++toastCounter;
  setTimeout(() => {
    el.style.transition = 'opacity 200ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- Elapsed-time refresh ---
setInterval(() => {
  if ([...state.pairings.values()].some((p) => p.status === 'connected')) renderDevices();
}, 1000);

// --- Wiring ---
senderName.addEventListener('change', () => {
  if (presence && state.myPeerId) {
    presence.send({ type: 'register', role: 'sender', name: senderName.value.trim() || 'Sender' });
  }
});
codeInput.addEventListener('input', () => {
  const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (v !== codeInput.value) codeInput.value = v;
  castWithCodeButton.disabled = !v;
});
startButton.addEventListener('click', startCapture);
stopButton.addEventListener('click', stopCapture);
castButton.addEventListener('click', castToSelected);
generateCodeButton.addEventListener('click', generateCode);
castWithCodeButton.addEventListener('click', castWithCode);

// --- Boot ---
(async () => {
  const ssid = await loadNetwork();
  openPresence();
  renderDevices(ssid);
  setGlobalStatus('Ready. Click Start sharing to begin.', 'info');
})();
