export function normalizeRoom(input) {
  const normalized = String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);

  return normalized || 'DEMO';
}

export function createRoomCode(length = 6, random = Math.random) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const size = Number.isInteger(length) && length > 0 ? length : 6;
  let room = '';
  for (let index = 0; index < size; index += 1) {
    const alphabetIndex = Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length));
    room += alphabet[alphabetIndex];
  }
  return room;
}

export const createPeerId = (length, random = Math.random) => createRoomCode(length ?? 6, random);

export function buildRegister({ role, name } = {}) {
  if (role !== 'sender' && role !== 'receiver') return null;
  const cleaned = String(name ?? '').trim().slice(0, 24) || 'Peer';
  return { type: 'register', role, name: cleaned };
}

export function parsePresenceSnapshot(message) {
  if (!message || !Array.isArray(message.peers)) return [];
  return message.peers.filter((peer) => peer && typeof peer.peerId === 'string');
}

export function isValidPeerId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value);
}

export function isValidRoomCode(value) {
  return typeof value === 'string' && /^[A-Z0-9]{1,16}$/.test(value);
}

const PAIR_CONTROL_TYPES = new Set([
  'register',
  'pair-request',
  'pair-invite',
  'pair-invite-result',
  'pair-offer',
  'pair-accept',
  'pair-deny',
  'pair-result',
  'pair-expired'
]);

export function isPairControlMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return PAIR_CONTROL_TYPES.has(message.type);
}

/**
 * Build a pair-request message. If `room` is provided, the receiver must
 * be claiming a pre-reserved room (e.g. via QR code). Otherwise it's a
 * direct pair with a fresh room assigned by the server.
 */
export function buildPairRequestMessage({ receiverId, room } = {}) {
  if (!isValidPeerId(receiverId)) return null;
  const msg = { type: 'pair-request', receiverId };
  if (typeof room === 'string' && /^[A-Z0-9]{6}$/.test(room)) {
    msg.room = room;
  }
  return msg;
}

/**
 * Build a receiver-initiated pair-invite. The receiver asks a specific
 * sender to cast to them. Sender responds with allow/deny.
 */
export function buildPairInviteMessage({ senderId, requestId } = {}) {
  if (!isValidPeerId(senderId)) return null;
  const msg = { type: 'pair-invite', senderId };
  if (typeof requestId === 'string') msg.requestId = requestId;
  return msg;
}

export function receiverUrlForRoom(origin, room) {
  const url = new URL('/receiver', origin);
  url.searchParams.set('room', normalizeRoom(room));
  return url.toString();
}

export function parseRoomFromUrl(url) {
  try {
    const parsed = new URL(url);
    return normalizeRoom(parsed.searchParams.get('room'));
  } catch {
    return 'DEMO';
  }
}

export function isValidRole(role) {
  return role === 'sender' || role === 'receiver';
}

export function isSignalMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'offer' && typeof message.sdp === 'string') return true;
  if (message.type === 'answer' && typeof message.sdp === 'string') return true;
  if (message.type === 'ice-candidate' && message.candidate) return true;
  if (message.type === 'hangup') return true;
  return false;
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
