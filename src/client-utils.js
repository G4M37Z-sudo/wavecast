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

export function isValidPeerId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value);
}

export function isValidRoomCode(value) {
  return typeof value === 'string' && /^[A-Z0-9]{1,16}$/.test(value);
}

export function buildPairRequestMessage({ receiverId, room } = {}) {
  if (!isValidPeerId(receiverId)) return null;
  const msg = { type: 'pair-request', receiverId };
  if (isValidRoomCode(room)) {
    msg.room = String(room).toUpperCase();
  }
  return msg;
}

export function generateRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: 16 random hex chars
  let id = '';
  const alphabet = '0123456789abcdef';
  for (let i = 0; i < 32; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

export function signalingBaseUrl() {
  if (typeof location === 'undefined') return '';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}`;
}

export function apiBaseUrl() {
  if (typeof location === 'undefined') return '';
  return `${location.protocol}//${location.host}`;
}

/** Resolution presets. Width/height/fps are the constraints sent to getDisplayMedia. */
export const RESOLUTION_PRESETS = {
  auto:    { label: 'Auto (let receiver pick)', width: null, height: null, fps: 30 },
  original:{ label: 'Original (sender screen)', width: null, height: null, fps: 60 },
  '1080p': { label: '1080p (1920×1080)',       width: 1920, height: 1080, fps: 30 },
  '720p':  { label: '720p (1280×720)',          width: 1280, height: 720,  fps: 30 },
  '480p':  { label: '480p (854×480)',           width: 854,  height: 480,  fps: 24 }
};

/**
 * Build the constraints object passed to navigator.mediaDevices.getDisplayMedia.
 * Returns a deep-cloned object so callers can mutate without affecting the preset.
 */
export function buildCaptureConstraints({ resolution = 'auto', audio = false } = {}) {
  const preset = RESOLUTION_PRESETS[resolution] || RESOLUTION_PRESETS.auto;
  const video = { frameRate: { ideal: preset.fps, max: preset.fps } };
  if (preset.width && preset.height) {
    video.width = { ideal: preset.width };
    video.height = { ideal: preset.height };
  }
  return { video, audio: !!audio };
}
