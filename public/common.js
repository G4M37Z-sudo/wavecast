// Shared client utilities. ESM, loaded by sender.js and receiver.js.
import {
  buildCaptureConstraints,
  RESOLUTION_PRESETS,
  buildPairRequestMessage,
  buildPairInviteMessage
} from './client-utils.js';
import { parseLocalIpsFromCandidate, isSameSubnet as isSameSubnetRaw, privateAddressRank } from './network-utils.js';

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export { buildCaptureConstraints, RESOLUTION_PRESETS, buildPairRequestMessage, buildPairInviteMessage };
export { parseLocalIpsFromCandidate, privateAddressRank };
export const isSameSubnet = isSameSubnetRaw;

export function signalingBaseUrl() {
  if (typeof location === 'undefined') return '';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}`;
}

export function apiBaseUrl() {
  if (typeof location === 'undefined') return '';
  return `${location.protocol}//${location.host}`;
}

export function formatElapsed(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(remSec).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}:${String(remMin).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

export function createPeerConnection(onIceCandidate) {
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) onIceCandidate(event.candidate);
  });
  return pc;
}

export function addSenderTracks(pc, stream) {
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
}

/**
 * Detect the device's own network. Combines:
 *   - Network Information API (navigator.connection) for connection type
 *   - WebRTC ICE gathering to surface the device's *local* IPv4 address
 *
 * Resolves with { type, ip, subnet, source }. type is 'wifi' | 'cellular'
 * | 'ethernet' | 'unknown'. ip/subnet are empty if detection fails.
 *
 * This is the web's closest analog to "ask the OS for the network" —
 * browsers do not expose SSID for privacy. The local IP + subnet uniquely
 * identifies the LAN.
 */
export function detectLocalNetwork({ timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const result = { type: 'unknown', ip: '', subnet: '', source: 'unknown' };

    // 1. Connection type (Chrome/Edge/Android only)
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        if (conn.type === 'wifi') result.type = 'wifi';
        else if (conn.type === 'cellular') result.type = 'cellular';
        else if (conn.type === 'ethernet') result.type = 'ethernet';
        else if (typeof conn.effectiveType === 'string') {
          // Heuristic: 4g+ usually wifi/ethernet
          if (conn.effectiveType === '4g') result.type = 'wifi';
        }
      }
    } catch {}

    // 2. Local IP via WebRTC ICE
    if (typeof RTCPeerConnection === 'undefined') {
      resolve(result);
      return;
    }
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    } catch {
      resolve(result);
      return;
    }

    const ips = new Set();
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      const found = parseLocalIpsFromCandidate(event.candidate.candidate);
      for (const ip of found) ips.add(ip);
    });

    // Need a data channel to trigger ICE gathering in some browsers
    try { pc.createDataChannel('probe'); } catch {}
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {});

    setTimeout(() => {
      try { pc.close(); } catch {}
      const sorted = [...ips].sort((a, b) => privateAddressRank(a) - privateAddressRank(b));
      const ip = sorted[0] || '';
      const parts = ip.split('.');
      const subnet = parts.length === 4 ? parts.slice(0, 3).join('.') : '';
      resolve({ ...result, ip, subnet, source: ip ? 'webrtc' : 'unknown' });
    }, timeoutMs);
  });
}

/**
 * Connect to /ws/presence. Returns a controller with send/close.
 * The returned promise `ready` resolves with `{ peerId }` once the server
 * has assigned an id. Calls to `send` made before ready are queued and
 * flushed in order.
 */
export function connectPresence(handlers = {}) {
  const ws = new WebSocket(`${signalingBaseUrl()}/ws/presence`);
  const sendQueue = [];
  let peerId = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const flush = () => {
    while (sendQueue.length && peerId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(sendQueue.shift()));
    }
  };

  const controller = {
    ws: null,
    ready,
    send(message) {
      if (peerId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        sendQueue.push(message);
      }
    },
    close() { try { ws.close(); } catch {} }
  };

  ws.addEventListener('open', () => flush());

  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome' && !peerId) {
      peerId = message.peerId;
      resolveReady({ peerId });
      handlers.onWelcome?.(message);
      flush();
      return;
    }
    switch (message.type) {
      case 'presence-snapshot': handlers.onSnapshot?.(message.peers ?? []); break;
      case 'presence-update': handlers.onUpdate?.({ peer: message.peer, gone: !!message.gone }); break;
      case 'pair-request-sent': handlers.onPairRequestSent?.(message); break;
      case 'pair-result': handlers.onPairResult?.(message); break;
      case 'pair-expired': handlers.onPairExpired?.(message); break;
      case 'error': handlers.onError?.(message); break;
    }
  });

  ws.addEventListener('close', () => handlers.onClose?.());
  ws.addEventListener('error', () => handlers.onError?.({ error: 'WebSocket error' }));

  controller.ws = ws;
  return controller;
}

/**
 * Connect to /ws (the legacy room-signaling endpoint) and join a room.
 * Used for the actual WebRTC peer connection once a pair is accepted.
 */
export function connectRoom({ room, role, onPeerReady, onSignal, onPeerLeft, onClose, onError }) {
  const ws = new WebSocket(`${signalingBaseUrl()}/ws`);
  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  ws.addEventListener('open', () => send({ type: 'join', room, role }));

  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'peer-ready') onPeerReady?.(message);
    else if (message.type === 'peer-left') onPeerLeft?.(message);
    else if (message.type === 'joined' || message.type === 'waiting') {
      // Informational only
    } else if (['offer', 'answer', 'ice-candidate', 'hangup'].includes(message.type)) {
      onSignal?.(message);
    } else if (message.type === 'error') {
      onError?.(message);
    }
  });

  ws.addEventListener('close', () => onClose?.());
  ws.addEventListener('error', () => onError?.({ error: 'WebSocket error' }));

  return {
    ws,
    send,
    close() { try { ws.close(); } catch {} }
  };
}
