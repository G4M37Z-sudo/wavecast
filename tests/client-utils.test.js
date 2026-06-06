import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatElapsed,
  isValidPeerId,
  isValidRoomCode,
  buildPairRequestMessage,
  buildCaptureConstraints,
  RESOLUTION_PRESETS
} from '../src/client-utils.js';

test('formatElapsed returns "0s" for sub-second values', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(0.4), '0s');
});

test('formatElapsed returns seconds under a minute', () => {
  assert.equal(formatElapsed(1), '1s');
  assert.equal(formatElapsed(45), '45s');
  assert.equal(formatElapsed(59), '59s');
});

test('formatElapsed returns minutes:seconds at 60s and beyond', () => {
  assert.equal(formatElapsed(60), '1:00');
  assert.equal(formatElapsed(75), '1:15');
  assert.equal(formatElapsed(600), '10:00');
  assert.equal(formatElapsed(3599), '59:59');
});

test('formatElapsed returns hours:minutes:seconds at 3600s and beyond', () => {
  assert.equal(formatElapsed(3600), '1:00:00');
  assert.equal(formatElapsed(3661), '1:01:01');
});

test('isValidPeerId accepts 6-char A-Z0-9 codes', () => {
  assert.equal(isValidPeerId('ABC123'), true);
  assert.equal(isValidPeerId('AAAAAA'), true);
  assert.equal(isValidPeerId('0Z9Y8X'), true);
});

test('isValidPeerId rejects wrong format', () => {
  assert.equal(isValidPeerId(''), false);
  assert.equal(isValidPeerId('AB'), false);
  assert.equal(isValidPeerId('ABCDEFG'), false);
  assert.equal(isValidPeerId('abc123'), false);
  assert.equal(isValidPeerId('AB-123'), false);
  assert.equal(isValidPeerId(null), false);
});

test('buildPairRequestMessage includes type and receiverId', () => {
  const msg = buildPairRequestMessage({ receiverId: 'ABC123' });
  assert.equal(msg.type, 'pair-request');
  assert.equal(msg.receiverId, 'ABC123');
});

test('buildPairRequestMessage returns null on invalid receiverId', () => {
  assert.equal(buildPairRequestMessage({ receiverId: 'xx' }), null);
  assert.equal(buildPairRequestMessage({}), null);
});

test('isValidRoomCode accepts 1-16 char A-Z0-9 codes', () => {
  assert.equal(isValidRoomCode('A'), true);
  assert.equal(isValidRoomCode('AB'), true);
  assert.equal(isValidRoomCode('ABC123'), true);
  assert.equal(isValidRoomCode('ABCDEFGHIJKLMNOP'), true);
  assert.equal(isValidRoomCode(''), false);
  assert.equal(isValidRoomCode('ABCDEFGHIJKLMNOPQ'), false);
  assert.equal(isValidRoomCode('ab-12'), false);
  assert.equal(isValidRoomCode(null), false);
});

test('buildPairRequestMessage includes room when valid', () => {
  const msg = buildPairRequestMessage({ receiverId: 'ABC123', room: 'XYZ789' });
  assert.equal(msg.type, 'pair-request');
  assert.equal(msg.receiverId, 'ABC123');
  assert.equal(msg.room, 'XYZ789');
});

test('buildPairRequestMessage omits room when invalid', () => {
  const msg = buildPairRequestMessage({ receiverId: 'ABC123', room: 'xx' });
  assert.equal(msg.room, undefined);
});

test('buildCaptureConstraints returns auto shape by default', () => {
  const c = buildCaptureConstraints();
  assert.equal(c.audio, false);
  assert.equal(c.video.width, undefined);
  assert.equal(c.video.height, undefined);
  assert.equal(c.video.frameRate.ideal, 30);
  assert.equal(c.video.frameRate.max, 30);
});

test('buildCaptureConstraints returns explicit resolution for 1080p', () => {
  const c = buildCaptureConstraints({ resolution: '1080p' });
  assert.equal(c.video.width.ideal, 1920);
  assert.equal(c.video.height.ideal, 1080);
  assert.equal(c.video.frameRate.ideal, 30);
  assert.equal(c.audio, false);
});

test('buildCaptureConstraints honors audio toggle', () => {
  const c = buildCaptureConstraints({ resolution: '720p', audio: true });
  assert.equal(c.audio, true);
  assert.equal(c.video.width.ideal, 1280);
  assert.equal(c.video.height.ideal, 720);
});

test('buildCaptureConstraints falls back to auto on unknown resolution', () => {
  const c = buildCaptureConstraints({ resolution: '8k-mythic' });
  assert.equal(c.video.frameRate.ideal, RESOLUTION_PRESETS.auto.fps);
});

test('buildCaptureConstraints returns a new object each call (no shared mutation)', () => {
  const a = buildCaptureConstraints({ resolution: '720p' });
  const b = buildCaptureConstraints({ resolution: '720p' });
  assert.notEqual(a, b);
  assert.notEqual(a.video, b.video);
});
