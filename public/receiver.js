import {
  connectPresence,
  connectRoom,
  createPeerConnection,
  apiBaseUrl,
  buildPairInviteMessage,
  detectLocalNetwork,
  isSameSubnet
} from './common.js';

// --- DOM refs ---
const ssidBanner = document.querySelector('#ssidBanner');
const receiverName = document.querySelector('#receiverName');
const stage = document.querySelector('#stage');
const stageEmpty = document.querySelector('#stageEmpty');
const stageOverlay = document.querySelector('#stageOverlay');
const stageOverlayText = document.querySelector('#stageOverlayText');
const remoteVideo = document.querySelector('#remoteVideo');
const fullscreenBtn = document.querySelector('#fullscreenBtn');
const disconnectBtn = document.querySelector('#disconnectBtn');
const modalMount = document.querySelector('#modalMount');
const toastStack = document.querySelector('#toastStack');
const presenceStatus = document.querySelector('#presenceStatus');
const codeJoinInput = document.querySelector('#codeJoinInput');
const codeJoinBtn = document.querySelector('#codeJoinBtn');
const codeJoinHint = document.querySelector('#codeJoinHint');
const codeConfirmCard = document.querySelector('#codeConfirmCard');
const codeConfirmName = document.querySelector('#codeConfirmName');
const codeConfirmSub = document.querySelector('#codeConfirmSub');
const codeConfirmCancel = document.querySelector('#codeConfirmCancel');
const codeConfirmConnect = document.querySelector('#codeConfirmConnect');
const sendersList = document.querySelector('#sendersList');
const senderCount = document.querySelector('#senderCount');
const myNetCard = document.querySelector('#myNetCard');
const myNetIcon = document.querySelector('#myNetIcon');
const myNetType = document.querySelector('#myNetType');
const myNetIp = document.querySelector('#myNetIp');
const myNetSubnet = document.querySelector('#myNetSubnet');
const myNetState = document.querySelector('#myNetState');

// --- App state ---
const state = {
  myPeerId: null,
  activePair: null,         // { requestId, room, pc, ws, senderName, kind }
  currentSsid: 'This network',
  knownSenders: new Map(),  // peerId -> { peerId, name, lastSeen, ip, subnet }
  inviteInFlight: false,    // true while a pair-invite is awaiting the sender's response
  lookedUpCode: null,       // { room, senderPeerId, senderName, senderIp, senderSubnet } after successful /api/pairing/lookup
  myNetwork: { type: 'unknown', ip: '', subnet: '', source: 'pending' }
};

// --- SSID ---
async function loadNetwork() {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/network`);
    const data = await res.json();
    const ssid = data.ssid || 'This network';
    const isFallback = data.source === 'fallback';
    state.currentSsid = ssid;
    ssidBanner.classList.toggle('fallback', isFallback);
    ssidBanner.innerHTML = `
      <span class="dot"></span>
      <span><strong style="color: var(--text);">${escapeHtml(ssid)}</strong>${isFallback ? ' (Wi-Fi not detected on this PC)' : ''}</span>
    `;
    if (presenceStatus) {
      presenceStatus.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 8px var(--success);"></span><span>Visible to senders on <strong style="color: var(--text);">${escapeHtml(ssid)}</strong></span>`;
    }
  } catch (error) {
    ssidBanner.innerHTML = `<span class="dot"></span><span>Network unavailable</span>`;
  }
}

// --- Presence / pairing ---
let presence = null;
function openPresence() {
  presence = connectPresence({
    onWelcome({ peerId }) {
      state.myPeerId = peerId;
      presence.send({ type: 'register', role: 'receiver', name: receiverName.value.trim() || 'Receiver' });
    },
    onSnapshot(peers) {
      syncSenders(peers);
    },
    onUpdate({ peer, gone }) {
      if (peer?.role === 'sender') {
        if (gone) {
          state.knownSenders.delete(peer.peerId);
        } else {
          const existing = state.knownSenders.get(peer.peerId);
          if (existing) {
            existing.name = peer.name;
            existing.lastSeen = peer.lastSeen;
          } else {
            state.knownSenders.set(peer.peerId, {
              peerId: peer.peerId,
              name: peer.name,
              lastSeen: peer.lastSeen,
              ip: peer.ip || '',
              subnet: peer.subnet || ''
            });
          }
        }
        renderSenders();
      }
      if (peer?.role === 'sender' && gone && state.inviteInFlight) {
        state.inviteInFlight = false;
        toast('That sender went away', 'warning');
      }
    },
    onPairResult({ accepted, room, reason }) {
      if (accepted && state.activePair) {
        openRoomConnection(room);
      } else if (!accepted) {
        toast(`Could not join: ${reason || 'denied'}`, 'danger');
        state.activePair = null;
        state.inviteInFlight = false;
        renderSenders();
        showStageOverlay('Could not connect');
      }
    },
    onError({ error }) { toast(`Signaling error: ${error}`, 'danger'); },
    onClose() { setTimeout(openPresence, 2000); }
  });

  // Direct handler for pair-offer
  presence.ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'pair-offer') {
      state.inviteInFlight = false;
      renderSenders();
      showConsentModal({
        requestId: message.requestId,
        senderId: message.senderId,
        senderName: message.senderName || 'A sender'
      });
    }
  });
}

receiverName.addEventListener('change', () => {
  if (presence && state.myPeerId) {
    presence.send({ type: 'register', role: 'receiver', name: receiverName.value.trim() || 'Receiver' });
  }
});

// --- Code/QR join flow: lookup → confirm → claim ---
async function lookupCode(room) {
  const normalized = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!normalized) return;
  if (!presence) { toast('Not connected to server', 'danger'); return; }
  if (state.activePair || state.inviteInFlight) { toast('Already connecting', 'info'); return; }

  if (codeJoinBtn) { codeJoinBtn.disabled = true; codeJoinBtn.textContent = 'Looking…'; }
  if (codeJoinHint) codeJoinHint.textContent = 'Checking code…';
  try {
    const res = await fetch(`${apiBaseUrl()}/api/pairing/lookup?room=${encodeURIComponent(normalized)}`);
    if (res.status === 404) {
      const data = await res.json().catch(() => ({}));
      if (codeJoinHint) codeJoinHint.textContent = data.error || 'Code not found or expired';
      toast(`Code ${normalized} not found`, 'warning');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (codeJoinHint) codeJoinHint.textContent = `Sender "${data.senderName}" found. Tap Connect to join.`;
    state.lookedUpCode = {
      room: data.room,
      senderPeerId: data.senderPeerId,
      senderName: data.senderName
    };
    showCodeConfirm(data.senderName, data.room);
  } catch (error) {
    if (codeJoinHint) codeJoinHint.textContent = `Lookup failed: ${error.message}`;
    toast(`Lookup failed: ${error.message}`, 'danger');
  } finally {
    refreshCodeJoinButton();
  }
}

function showCodeConfirm(senderName, room) {
  if (!codeConfirmCard) return;
  if (codeConfirmName) codeConfirmName.textContent = senderName;
  if (codeConfirmSub) codeConfirmSub.textContent = `Code: ${room}`;
  codeConfirmCard.style.display = 'flex';
  if (codeJoinInput) codeJoinInput.disabled = true;
}

function hideCodeConfirm() {
  if (codeConfirmCard) codeConfirmCard.style.display = 'none';
  state.lookedUpCode = null;
  if (codeJoinInput) codeJoinInput.disabled = false;
  if (codeJoinHint) codeJoinHint.textContent = '';
  refreshCodeJoinButton();
  if (codeJoinInput) codeJoinInput.focus();
}

function confirmAndClaim() {
  const looked = state.lookedUpCode;
  if (!looked) return;
  const { room, senderName } = looked;
  hideCodeConfirm();
  claimRoom(room, senderName);
}

// --- Claim a room (looked-up code or URL ?room=) ---
function claimRoom(room, senderName = 'sender') {
  if (!presence || !state.myPeerId) { toast('Not connected to server', 'danger'); return; }
  const normalized = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!normalized) return;
  state.activePair = { requestId: null, room: normalized, pc: null, ws: null, senderName, kind: 'room' };
  presence.send({ type: 'pair-request', room: normalized });
  showStageOverlay('Connecting…');
  toast(`Joining ${senderName} (${normalized})…`, 'info');
}

function refreshCodeJoinButton() {
  if (!codeJoinBtn || !codeJoinInput) return;
  const v = codeJoinInput.value;
  codeJoinBtn.disabled = !v;
  codeJoinBtn.textContent = 'Join';
}

codeJoinBtn?.addEventListener('click', () => {
  if (codeJoinInput?.value) lookupCode(codeJoinInput.value);
});
codeJoinInput?.addEventListener('input', () => {
  const v = codeJoinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (v !== codeJoinInput.value) codeJoinInput.value = v;
  hideCodeConfirm();
  refreshCodeJoinButton();
});
codeJoinInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && codeJoinInput.value) lookupCode(codeJoinInput.value);
});

codeConfirmCancel?.addEventListener('click', hideCodeConfirm);
codeConfirmConnect?.addEventListener('click', confirmAndClaim);

// --- Receiver-initiated invite: ask a sender to cast to us ---
function inviteSender(senderPeerId, senderName) {
  if (!presence || !state.myPeerId) { toast('Not connected to server', 'danger'); return; }
  if (state.inviteInFlight) { toast('Already asking…', 'info'); return; }
  if (state.activePair) { toast('Already connected', 'info'); return; }

  state.inviteInFlight = true;
  state.activePair = { requestId: null, room: null, pc: null, ws: null, senderName, kind: 'invite' };
  showStageOverlay('Asking sender to cast…');
  toast(`Asking ${senderName} to share their screen…`, 'info');

  const msg = buildPairInviteMessage({ senderId: senderPeerId });
  if (!msg) {
    state.inviteInFlight = false;
    state.activePair = null;
    toast('Invalid sender', 'danger');
    return;
  }
  presence.send(msg);
  renderSenders();
}

// --- Senders list rendering ---
function syncSenders(peers) {
  state.knownSenders.clear();
  for (const peer of peers) {
    if (peer.peerId === state.myPeerId) continue;
    if (peer.role !== 'sender') continue;
    state.knownSenders.set(peer.peerId, {
      peerId: peer.peerId,
      name: peer.name,
      lastSeen: peer.lastSeen,
      ip: peer.ip || '',
      subnet: peer.subnet || ''
    });
  }
  renderSenders();
}

function renderSenders() {
  if (!sendersList) return;
  const senders = [...state.knownSenders.values()].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  if (senderCount) senderCount.textContent = String(senders.length);
  const mySub = state.myNetwork.subnet;

  if (senders.length === 0) {
    sendersList.innerHTML = `
      <li class="empty-state">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="13" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <div>No senders found yet</div>
        <div class="hint">Open <code>/sender</code> on the device that will share its screen, then click "Start sharing".</div>
      </li>
    `;
    return;
  }

  sendersList.innerHTML = senders.map((s) => {
    const isInviting = state.inviteInFlight && state.activePair?.senderName === s.name;
    const sameNet = mySub && s.subnet && isSameSubnet(mySub, s.subnet);
    const hasIp = !!s.ip;
    const networkBadge = hasIp
      ? (sameNet
          ? `<span class="net-badge net-badge--ok" title="Same subnet (${s.subnet}.x)">● same network</span>`
          : `<span class="net-badge net-badge--warn" title="Different subnet (${s.subnet}.x vs ${mySub || '?'}.x)">● different network</span>`)
      : `<span class="net-badge net-badge--unknown" title="Sender's network not yet known">● network unknown</span>`;
    const subline = hasIp
      ? `${networkBadge} <span class="sender-ip">${escapeHtml(s.ip)}</span>`
      : 'Tap connect to ask for a cast';
    return `
      <li class="sender-item" data-peer-id="${s.peerId}">
        <div class="sender-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="18" height="13" rx="2"/>
            <path d="M8 21h8M12 17v4"/>
          </svg>
        </div>
        <div class="sender-info">
          <div class="sender-name">${escapeHtml(s.name)}</div>
          <div class="sender-sub">${state.inviteInFlight && isInviting ? 'Waiting for confirmation…' : subline}</div>
        </div>
        <button class="btn ${isInviting ? 'btn--ghost' : 'btn--primary'}" data-action="connect" ${state.inviteInFlight ? 'disabled' : ''}>
          ${isInviting ? 'Asking…' : 'Connect'}
        </button>
      </li>
    `;
  }).join('');

  for (const li of sendersList.querySelectorAll('.sender-item')) {
    const peerId = li.dataset.peerId;
    const sender = state.knownSenders.get(peerId);
    const btn = li.querySelector('[data-action="connect"]');
    btn?.addEventListener('click', () => inviteSender(peerId, sender?.name || 'A sender'));
  }
}

// --- Render this device's network detection result ---
function renderMyNetwork(net) {
  if (!myNetCard) return;
  const ICONS = {
    wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1.5" fill="currentColor"/></svg>',
    ethernet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    cellular: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1.5" fill="currentColor"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4.2 2.75c-.7.4-1.2 1-1.2 1.75V15"/><circle cx="12" cy="18" r="0.5" fill="currentColor"/></svg>'
  };
  const typeLabel = { wifi: 'Wi-Fi', ethernet: 'Ethernet', cellular: 'Cellular', unknown: 'Network' }[net.type] || 'Network';
  if (myNetIcon) myNetIcon.innerHTML = ICONS[net.type] || ICONS.unknown;
  if (myNetType) myNetType.textContent = typeLabel;
  if (myNetIp) myNetIp.textContent = net.ip || '—';
  if (myNetSubnet) myNetSubnet.textContent = net.subnet ? `${net.subnet}.x` : '—';

  let stateText = '';
  let stateKind = '';
  if (net.source === 'pending') {
    stateText = 'Detecting your network…';
  } else if (!net.ip) {
    stateText = 'Could not detect a private IP — you may not be on Wi-Fi. Senders on a different network won\'t reach you directly.';
    stateKind = 'warning';
  } else {
    stateText = `You're on subnet ${net.subnet}.x. Devices on the same subnet can cast to you directly.`;
    stateKind = 'success';
  }
  if (myNetState) {
    myNetState.textContent = stateText;
    myNetState.className = `my-net-state my-net-state--${stateKind || 'pending'}`;
  }
  myNetCard.classList.toggle('my-net--ready', !!net.ip);
  myNetCard.classList.toggle('my-net--warning', !net.ip && net.source !== 'pending');
  myNetCard.classList.toggle('my-net--pending', net.source === 'pending');
}

// --- Consent modal ---
let modalEl = null;
let countdownTimer = null;
let countdownSeconds = 30;
let currentRequestId = null;

function showConsentModal({ requestId, senderName }) {
  hideConsentModal();
  currentRequestId = requestId;
  countdownSeconds = 30;
  modalEl = document.createElement('div');
  modalEl.className = 'modal-backdrop';
  modalEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <h2 id="modalTitle">
        <svg class="icon-broadcast" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
          <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
          <circle cx="12" cy="20" r="1.5" fill="currentColor"/>
        </svg>
        Incoming cast
      </h2>
      <div class="modal-body">
        <strong>"${escapeHtml(senderName)}"</strong> wants to cast their screen to this device.
        You'll see whatever they choose to share, in real time.
      </div>
      <div class="modal-countdown">
        <div class="ring" data-s="${countdownSeconds}" style="--p: 1;"></div>
        <span>Auto-decline in <strong>${countdownSeconds}s</strong> if you don't respond.</span>
      </div>
      <div class="modal-actions">
        <button class="btn btn--ghost" data-action="deny">Deny</button>
        <button class="btn btn--primary" data-action="accept">Allow</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) deny(); });
  modalEl.querySelector('[data-action="accept"]').addEventListener('click', accept);
  modalEl.querySelector('[data-action="deny"]').addEventListener('click', deny);
  document.addEventListener('keydown', onModalKey);

  countdownTimer = setInterval(() => {
    countdownSeconds -= 1;
    if (countdownSeconds <= 0) { deny(); return; }
    const ring = modalEl?.querySelector('.ring');
    const strong = modalEl?.querySelector('.modal-countdown strong');
    if (ring) {
      ring.dataset.s = String(countdownSeconds);
      ring.style.setProperty('--p', String(countdownSeconds / 30));
    }
    if (strong) strong.textContent = `${countdownSeconds}s`;
  }, 1000);
}

function hideConsentModal() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  modalEl?.remove();
  modalEl = null;
  currentRequestId = null;
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(e) {
  if (e.key === 'Escape') deny();
  if (e.key === 'Enter') accept();
}

function accept() {
  const requestId = currentRequestId;
  hideConsentModal();
  if (!requestId) return;
  presence.send({ type: 'pair-accept', requestId });
  if (!state.activePair) state.activePair = { requestId, room: null, pc: null, ws: null, senderName: 'sender', kind: 'offer' };
  showStageOverlay('Connecting…');
}

function deny() {
  const requestId = currentRequestId;
  hideConsentModal();
  if (requestId) presence.send({ type: 'pair-deny', requestId });
}

// --- Stage ---
function showStage() {
  stageEmpty.style.display = 'none';
  remoteVideo.style.display = 'block';
  fullscreenBtn.style.display = 'inline-flex';
  disconnectBtn.style.display = 'inline-flex';
  stageOverlay.style.display = 'flex';
  stageOverlayText.textContent = 'Live';
}

function showStageOverlay(text) {
  stageOverlay.style.display = 'flex';
  stageOverlayText.textContent = text;
}

function hideStage() {
  stageEmpty.style.display = 'flex';
  stageEmpty.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="4" width="18" height="13" rx="2"/>
      <path d="M8 21h8M12 17v4"/>
    </svg>
    <h3>Disconnected</h3>
    <p>The sender stopped sharing, or the connection was lost.</p>
  `;
  remoteVideo.style.display = 'none';
  remoteVideo.srcObject = null;
  fullscreenBtn.style.display = 'none';
  disconnectBtn.style.display = 'none';
  stageOverlay.style.display = 'none';
}

function disconnect() {
  if (state.activePair?.ws) {
    state.activePair.ws.send(JSON.stringify({ type: 'hangup' }));
    state.activePair.ws.close();
  }
  if (state.activePair?.pc) state.activePair.pc.close();
  state.activePair = null;
  hideStage();
  toast('Disconnected', 'info');
}

function openRoomConnection(room) {
  if (!state.activePair) return;
  const pc = createPeerConnection((candidate) => state.activePair.ws?.send(JSON.stringify({ type: 'ice-candidate', candidate })));
  pc.ontrack = (event) => {
    // Use the associated stream if present, otherwise build one from the track.
    // Some browsers fire ontrack with empty event.streams when transceivers are
    // created without an explicit addTrack(stream).
    const stream = event.streams[0] || new MediaStream([event.track]);
    remoteVideo.srcObject = stream;
    remoteVideo.muted = false;
    remoteVideo.autoplay = true;
    const playPromise = remoteVideo.play();
    if (playPromise) {
      playPromise.catch((err) => {
        console.warn('remoteVideo.play() rejected:', err.message);
        toast('Tap the video to start playback', 'warning');
      });
    }
    showStage();
    toast(`Streaming from ${state.activePair?.senderName || 'sender'}`, 'success');
  };
  pc.addEventListener('connectionstatechange', () => {
    console.log('[webrtc] receiver connection state:', pc.connectionState);
    if (pc.connectionState === 'failed') {
      toast('WebRTC connection failed — both devices must be on the same network', 'danger');
    } else if (pc.connectionState === 'disconnected') {
      toast('Connection lost (will try to recover)', 'warning');
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log('[webrtc] receiver ICE state:', pc.iceConnectionState);
  });
  const ws = connectRoom({
    room,
    role: 'receiver',
    onSignal: async (message) => {
      try {
        if (message.type === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send({ type: 'answer', sdp: answer.sdp });
        } else if (message.type === 'ice-candidate') {
          if (message.candidate) await pc.addIceCandidate(message.candidate);
        }
      } catch (error) { toast(`WebRTC error: ${error.message}`, 'danger'); }
    },
    onPeerReady: () => { console.log('[ws] receiver peer-ready in room', room); },
    onPeerLeft: () => { disconnect(); toast('Sender disconnected', 'warning'); },
    onClose: () => { if (state.activePair) disconnect(); }
  });
  state.activePair.pc = pc;
  state.activePair.ws = ws;
  state.activePair.room = room;
}

fullscreenBtn.addEventListener('click', () => remoteVideo.requestFullscreen?.());
disconnectBtn.addEventListener('click', disconnect);

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = text;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- Boot ---
loadNetwork();
openPresence();
renderMyNetwork(state.myNetwork); // pending placeholder
// Detect this device's own network (Wi-Fi IP + subnet) for same-LAN matching.
detectLocalNetwork().then((net) => {
  state.myNetwork = net;
  renderMyNetwork(net);
  renderSenders(); // re-render now that we know our subnet
});

// Auto-claim from URL (?room=...). Wait for presence to be ready.
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  if (codeJoinInput) codeJoinInput.value = urlRoom.toUpperCase();
  const tryAutoClaim = () => {
    if (state.myPeerId) lookupCode(urlRoom);
    else setTimeout(tryAutoClaim, 100);
  };
  tryAutoClaim();
}
