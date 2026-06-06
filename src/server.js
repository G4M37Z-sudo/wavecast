import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import {
  normalizeRoom,
  createRoomCode,
  receiverUrlForRoom,
  createPeerId,
  buildRegister,
  isPairControlMessage,
  isValidPeerId,
  isValidRoomCode,
  safeJsonParse
} from './protocol.js';
import { getLocalNetworkUrls, getLocalNetworks } from './server-info.js';
import { createPresenceRegistry } from './presence.js';
import { createPairManager } from './pairing.js';
import { createSsidDetector } from './network.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT || 8080);

const app = express();
app.use(express.json({ limit: '8kb' }));
app.use(express.static(publicDir));
app.get('/sender', (_req, res) => res.sendFile(path.join(publicDir, 'sender.html')));
app.get('/receiver', (_req, res) => res.sendFile(path.join(publicDir, 'receiver.html')));
app.get('/api/pairing', async (req, res) => {
  const room = normalizeRoom(req.query.room || createRoomCode());
  const origin = `${req.protocol}://${req.get('host')}`;
  const receiverUrl = receiverUrlForRoom(origin, room);
  const qrDataUrl = await QRCode.toDataURL(receiverUrl, { margin: 1, width: 280 });
  res.json({ room, receiverUrl, qrDataUrl });
});

// List all senders currently on the network. Used by the receiver to pick one
// to connect to (avoids typing codes).
app.get('/api/senders', (_req, res) => {
  const senders = presenceRegistry
    .snapshot()
    .filter((peer) => peer.role === 'sender')
    .map((peer) => {
      const remote = presenceRemote.get(peer.peerId) || { ip: '', subnet: '' };
      return {
        peerId: peer.peerId,
        name: peer.name,
        lastSeen: peer.lastSeen,
        ip: remote.ip,
        subnet: remote.subnet
      };
    });
  res.json({ senders, networkUrls: getLocalNetworkUrls(port) });
});

// Resolve a room code to the sender who reserved it. Used by the receiver
// to show the sender's name + network info before confirming a join.
app.get('/api/pairing/lookup', (req, res) => {
  const room = normalizeRoom(req.query.room || '');
  if (!room) return res.status(400).json({ error: 'Missing room' });
  const claim = pairManager.findPendingByRoom(room);
  if (!claim) return res.status(404).json({ error: 'Code not found or expired', room });
  const sender = presenceRegistry.get(claim.entry.senderId);
  const remote = presenceRemote.get(claim.entry.senderId) || { ip: '', subnet: '' };
  res.json({
    room,
    requestId: claim.requestId,
    senderPeerId: claim.entry.senderId,
    senderName: sender ? sender.name : 'Unknown sender',
    senderIp: remote.ip,
    senderSubnet: remote.subnet,
    networkUrls: getLocalNetworkUrls(port)
  });
});

const detectSsid = createSsidDetector();
app.get('/api/network', async (_req, res) => {
  const result = await detectSsid();
  res.json(result);
});

// QR-code + room-code reservation.
// Creates a pending pair with a reserved room and a synthetic "qr" receiver.
// When a real receiver joins that room (via /receiver?room=... or by typing the
// code), the server redirects the pair-offer to that real receiver.
app.post('/api/pairing/reserve', async (req, res) => {
  const { senderId, senderName, room } = req.body || {};
  if (!isValidPeerId(senderId)) return res.status(400).json({ error: 'Invalid senderId' });
  if (!presenceRegistry.get(senderId) || presenceRegistry.get(senderId).role !== 'sender') {
    return res.status(403).json({ error: 'Sender not registered on presence layer' });
  }
  const reservedRoom = (typeof room === 'string' && isValidRoomCode(room)) ? room.toUpperCase() : createRoomCode();
  const result = pairManager.request({
    senderId,
    receiverId: '__QR__',  // synthetic; never sent because we use room-claim instead
    senderName: senderName || 'Sender',
    room: reservedRoom
  });
  if (!result) return res.status(500).json({ error: 'Failed to reserve' });
  // Override the synthetic receiver: when the room is claimed, the server
  // will re-broadcast to whoever claims it (see pair-request handler).
  res.json({ requestId: result.requestId, room: result.room });
});

const server = app.listen(port, '0.0.0.0', async () => {
  console.log('WaveCast MVP running:');
  for (const url of getLocalNetworkUrls(port)) {
    console.log(`  ${url}`);
  }
  const ssid = await detectSsid();
  console.log(`\nDetected Wi-Fi: ${ssid.ssid} (${ssid.source})`);
  console.log('\nOpen /receiver on the target device, then /sender on the source device.');
});

// --- Legacy room signaling on /ws (used by the QR code flow). ---
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

function getRoom(roomName) {
  const room = normalizeRoom(roomName);
  if (!rooms.has(room)) rooms.set(room, new Map());
  return { name: room, peers: rooms.get(room) };
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  let joinedRoom = null;
  let role = null;

  ws.on('message', (data) => {
    const message = safeJsonParse(data.toString());
    if (!message) return send(ws, { type: 'error', error: 'Invalid JSON' });

    if (message.type === 'join') {
      if (!isValidRole(message.role)) return send(ws, { type: 'error', error: 'Invalid role' });
      const room = getRoom(message.room);
      joinedRoom = room.name;
      role = message.role;

      const oldPeer = room.peers.get(role);
      if (oldPeer && oldPeer !== ws) oldPeer.close(1000, 'Replaced by new peer');
      room.peers.set(role, ws);

      send(ws, { type: 'joined', room: joinedRoom, role });
      const otherRole = role === 'sender' ? 'receiver' : 'sender';
      const otherPeer = room.peers.get(otherRole);
      if (otherPeer) {
        send(ws, { type: 'peer-ready', role: otherRole });
        send(otherPeer, { type: 'peer-ready', role });
      }
      return;
    }

    if (!joinedRoom || !role) return send(ws, { type: 'error', error: 'Join a room first' });
    if (!isSignalMessage(message)) return send(ws, { type: 'error', error: `Unsupported message: ${message.type}` });

    const room = rooms.get(joinedRoom);
    const otherRole = role === 'sender' ? 'receiver' : 'sender';
    const target = room?.get(otherRole);
    if (!target) return send(ws, { type: 'waiting', message: `${otherRole} not connected yet` });

    send(target, { ...message, from: role });
  });

  ws.on('close', () => {
    if (!joinedRoom || !role) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    if (room.get(role) === ws) room.delete(role);
    const otherRole = role === 'sender' ? 'receiver' : 'sender';
    const otherPeer = room.get(otherRole);
    if (otherPeer) send(otherPeer, { type: 'peer-left', role });
    if (room.size === 0) rooms.delete(joinedRoom);
  });
});

function isValidRole(role) {
  return role === 'sender' || role === 'receiver';
}

function isSignalMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'offer' && typeof message.sdp === 'string') return true;
  if (message.type === 'answer' && typeof message.sdp === 'string') return true;
  if (message.type === 'ice-candidate' && message.candidate) return true;
  if (message.type === 'hangup') return true;
  return false;
}

// --- Presence + pairing layer on /ws/presence. ---
const presenceRegistry = createPresenceRegistry();
const presencePeers = new Map(); // peerId -> ws (for sending to a specific peer)

function sendToPeer(peerId, payload) {
  const ws = presencePeers.get(peerId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

const pairManager = createPairManager({
  registry: presenceRegistry,
  send: sendToPeer
});

function broadcastPresenceUpdate(peer, gone = false) {
  const payload = { type: 'presence-update', peer, gone };
  for (const [otherId, ws] of presencePeers.entries()) {
    if (otherId === peer.peerId) continue;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }
}

const wssPresence = new WebSocketServer({ noServer: true });

// Per-connection metadata: remote address (for network-awareness). We
// keep this in a Map keyed by peerId so the sender list can show the
// sender's own LAN IP and let the receiver decide same-network.
const presenceRemote = new Map(); // peerId -> { ip, subnet }

function ipFromReq(req) {
  // Prefer the rightmost X-Forwarded-For (closest hop), else socket.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || '';
}

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/presence') {
    wssPresence.handleUpgrade(req, socket, head, (ws) => {
      wssPresence.emit('connection', ws, req);
    });
  } else if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wssPresence.on('connection', (ws, req) => {
  const peerId = createPeerId();
  presencePeers.set(peerId, ws);

  // Capture the sender/receiver's own IP from the upgrade request so
  // /api/senders and /api/pairing/lookup can tell clients which IP
  // is reachable on the LAN for each peer.
  const ip = ipFromReq(req).replace(/^::ffff:/, ''); // strip IPv6-mapped prefix
  const parts = ip.split('.');
  const subnet = parts.length === 4 ? parts.slice(0, 3).join('.') : '';
  presenceRemote.set(peerId, { ip, subnet });

  send(ws, { type: 'welcome', peerId, ip, subnet });

  ws.on('message', (data) => {
    const message = safeJsonParse(data.toString());
    if (!message) return send(ws, { type: 'error', error: 'Invalid JSON' });
    if (!isPairControlMessage(message)) return send(ws, { type: 'error', error: `Unsupported message: ${message.type}` });

    if (message.type === 'register') {
      const built = buildRegister({ role: message.role, name: message.name });
      if (!built) return send(ws, { type: 'error', error: 'Invalid role' });
      presenceRegistry.register(peerId, built.role, built.name);
      send(ws, { type: 'presence-snapshot', peers: presenceRegistry.snapshot() });
      broadcastPresenceUpdate({ peerId, name: built.name, role: built.role, lastSeen: Date.now() });
      return;
    }

    if (message.type === 'pair-request') {
      // Two flows:
      //  1. Sender-initiated tap-to-pair: pair-request has `receiverId`, no `room`.
      //  2. Receiver claims a reserved room (QR / room code): pair-request has `room`, no `receiverId` (or `receiverId` is sender).
      const senderPeer = presenceRegistry.get(peerId);
      if (!senderPeer) return send(ws, { type: 'error', error: 'Not registered' });

      if (senderPeer.role === 'receiver' && message.room) {
        // Receiver claiming a pre-reserved room
        const claim = pairManager.findPendingByRoom(message.room);
        if (!claim) {
          return send(ws, { type: 'pair-result', requestId: null, accepted: false, reason: 'code-not-found' });
        }
        // Re-send the offer to this receiver now that they're online
        pairManager.replayOffer(claim.requestId, peerId);
        return;
      }

      if (senderPeer.role !== 'sender') {
        return send(ws, { type: 'error', error: 'Only senders may initiate pair requests' });
      }
      const result = pairManager.request({
        senderId: peerId,
        receiverId: message.receiverId,
        senderName: senderPeer.name,
        room: message.room
      });
      if (!result) return send(ws, { type: 'pair-result', requestId: null, accepted: false, reason: 'receiver-unavailable' });
      send(ws, { type: 'pair-request-sent', requestId: result.requestId, room: result.room });
      return;
    }

    // Receiver-initiated invitation: the receiver picked a sender from the
    // discovery list and wants to receive a cast. Server sends the sender a
    // `pair-invite` with the receiver's info. The sender then either accepts
    // (creating a reserved room the receiver can claim) or denies.
    if (message.type === 'pair-invite') {
      const inviter = presenceRegistry.get(peerId);
      if (!inviter) return send(ws, { type: 'error', error: 'Not registered' });
      if (inviter.role !== 'receiver') {
        return send(ws, { type: 'error', error: 'Only receivers may send invites' });
      }
      if (!isValidPeerId(message.senderId)) {
        return send(ws, { type: 'error', error: 'Invalid senderId' });
      }
      const target = presenceRegistry.get(message.senderId);
      if (!target || target.role !== 'sender') {
        return send(ws, { type: 'pair-invite-result', accepted: false, reason: 'sender-unavailable' });
      }
      // Forward the invite to the sender. They'll respond with pair-accept/deny.
      sendToPeer(message.senderId, {
        type: 'pair-invite',
        requestId: message.requestId,  // receiver-generated correlation id (optional)
        receiverId: peerId,
        receiverName: inviter.name
      });
      return;
    }

    if (message.type === 'pair-accept' || message.type === 'pair-deny') {
      const accept = message.type === 'pair-accept';
      pairManager.decide({ requestId: message.requestId, accept });
      return;
    }
  });

  ws.on('close', () => {
    const peer = presenceRegistry.get(peerId);
    presenceRegistry.unregister(peerId);
    presencePeers.delete(peerId);
    presenceRemote.delete(peerId);
    // Clean up any pending pair requests owned by this peer (esp. room
    // reservations from /api/pairing/reserve, which have no TTL).
    if (peer) {
      pairManager.cancelBySender(peerId);
    }
    if (peer) {
      broadcastPresenceUpdate({ peerId, name: peer.name, role: peer.role, lastSeen: Date.now() }, true);
    }
  });
});
