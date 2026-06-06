import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoom,
  isValidRole,
  isSignalMessage,
  isPairControlMessage,
  buildPairRequestMessage,
  buildPairInviteMessage,
  isValidPeerId
} from '../src/protocol.js';

test('normalizeRoom trims, uppercases, and removes unsupported characters', () => {
  assert.equal(normalizeRoom(' ab-12 cd! '), 'AB12CD');
});

test('normalizeRoom falls back to DEMO when room becomes empty', () => {
  assert.equal(normalizeRoom(' !!! '), 'DEMO');
});

test('isValidRole accepts sender and receiver only', () => {
  assert.equal(isValidRole('sender'), true);
  assert.equal(isValidRole('receiver'), true);
  assert.equal(isValidRole('admin'), false);
});

test('isSignalMessage accepts WebRTC signaling message types', () => {
  assert.equal(isSignalMessage({ type: 'offer', sdp: 'x' }), true);
  assert.equal(isSignalMessage({ type: 'answer', sdp: 'x' }), true);
  assert.equal(isSignalMessage({ type: 'ice-candidate', candidate: { candidate: 'x' } }), true);
  assert.equal(isSignalMessage({ type: 'join' }), false);
});

test('isPairControlMessage accepts pair-invite and pair-invite-result', () => {
  assert.equal(isPairControlMessage({ type: 'pair-invite' }), true);
  assert.equal(isPairControlMessage({ type: 'pair-invite-result' }), true);
});

test('buildPairRequestMessage validates receiverId and accepts optional room', () => {
  assert.deepEqual(buildPairRequestMessage({ receiverId: 'ABC123' }), { type: 'pair-request', receiverId: 'ABC123' });
  assert.deepEqual(buildPairRequestMessage({ receiverId: 'ABC123', room: 'ROOMY1' }), { type: 'pair-request', receiverId: 'ABC123', room: 'ROOMY1' });
  assert.equal(buildPairRequestMessage({}), null);
  assert.equal(buildPairRequestMessage({ receiverId: 'bad' }), null);
});

test('buildPairInviteMessage validates senderId and includes optional requestId', () => {
  assert.deepEqual(buildPairInviteMessage({ senderId: 'ABC123' }), { type: 'pair-invite', senderId: 'ABC123' });
  assert.deepEqual(buildPairInviteMessage({ senderId: 'ABC123', requestId: 'rid-1' }), { type: 'pair-invite', senderId: 'ABC123', requestId: 'rid-1' });
  assert.equal(buildPairInviteMessage({ senderId: 'bad' }), null);
});

test('isValidPeerId accepts exactly 6 alphanumeric uppercase', () => {
  assert.equal(isValidPeerId('ABC123'), true);
  assert.equal(isValidPeerId('abc123'), false);
  assert.equal(isValidPeerId('ABC12'), false);
  assert.equal(isValidPeerId('ABC1234'), false);
  assert.equal(isValidPeerId(''), false);
  assert.equal(isValidPeerId(null), false);
});
