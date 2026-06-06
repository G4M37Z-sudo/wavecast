import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomCode, receiverUrlForRoom, parseRoomFromUrl } from '../src/protocol.js';
import { createPairManager } from '../src/pairing.js';

test('createRoomCode returns uppercase URL-safe room codes of requested length', () => {
  const room = createRoomCode(8, () => 0);
  assert.equal(room, 'AAAAAAAA');
});

test('createRoomCode uses default six character length', () => {
  const room = createRoomCode(undefined, () => 0.9999);
  assert.equal(room.length, 6);
  assert.match(room, /^[A-Z0-9]+$/);
});

test('receiverUrlForRoom appends normalized room to receiver path', () => {
  assert.equal(
    receiverUrlForRoom('http://192.168.1.10:8080', ' ab-12 '),
    'http://192.168.1.10:8080/receiver?room=AB12'
  );
});

test('parseRoomFromUrl returns normalized room for a full receiver URL', () => {
  assert.equal(
    parseRoomFromUrl('http://192.168.1.10:8080/receiver?room=AB12CD'),
    'AB12CD'
  );
});

test('parseRoomFromUrl normalizes messy query values', () => {
  assert.equal(
    parseRoomFromUrl('http://192.168.1.10:8080/receiver?room=%20ab-12%20'),
    'AB12'
  );
});

test('parseRoomFromUrl falls back to DEMO when room is missing', () => {
  assert.equal(parseRoomFromUrl('http://localhost:8080/receiver'), 'DEMO');
});

function makeRegistry() {
  const peers = new Map();
  peers.set('S1', { peerId: 'S1', role: 'sender', name: 'My PC' });
  peers.set('R1', { peerId: 'R1', role: 'receiver', name: 'Living Room TV' });
  peers.set('R2', { peerId: 'R2', role: 'receiver', name: 'Bedroom TV' });
  return {
    peers,
    get(id) { return peers.get(id); }
  };
}

function makeSend() {
  const log = [];
  return {
    log,
    send(toPeerId, payload) { log.push({ to: toPeerId, payload }); }
  };
}

test('request returns null when receiver is unknown', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const out = mgr.request({ senderId: 'S1', receiverId: 'NOPE', senderName: 'My PC' });
  assert.equal(out, null);
  assert.equal(sender.log.length, 0);
  mgr._teardown();
});

test('request emits pair-offer to the receiver with a room code', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const out = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC' });
  assert.ok(out.requestId);
  assert.equal(out.room, 'AAAAAA');
  assert.deepEqual(sender.log[0], {
    to: 'R1',
    payload: { type: 'pair-offer', requestId: out.requestId, senderId: 'S1', senderName: 'My PC', room: 'AAAAAA' }
  });
  mgr._teardown();
});

test('request with explicit room reuses that room and emits it in the offer', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const out = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC', room: 'QR1234' });
  assert.equal(out.room, 'QR1234');
  assert.equal(sender.log[0].payload.room, 'QR1234');
  mgr._teardown();
});

test('findPendingByRoom returns the entry for a reserved room and ignores settled', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const { requestId } = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC', room: 'ROOMX' });
  const found = mgr.findPendingByRoom('ROOMX');
  assert.equal(found?.requestId, requestId);
  assert.equal(found?.entry.senderName, 'My PC');
  // settled entries ignored
  mgr.decide({ requestId, accept: true });
  assert.equal(mgr.findPendingByRoom('ROOMX'), null);
  mgr._teardown();
});

test('replayOffer updates receiverId and sends the offer to the real peer', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  // Synthetic __QR__ peer is allowed by request() without being in the registry.
  const { requestId } = mgr.request({ senderId: 'S1', receiverId: '__QR__', senderName: 'My PC', room: 'ROOMY' });
  sender.log.length = 0; // clear initial offer to synthetic peer
  const ok = mgr.replayOffer(requestId, 'R2');
  assert.equal(ok, true);
  assert.deepEqual(sender.log[0], {
    to: 'R2',
    payload: { type: 'pair-offer', requestId, senderId: 'S1', senderName: 'My PC', room: 'ROOMY' }
  });
  mgr._teardown();
});

test('decide(accept) emits pair-result true with the room to the sender', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const { requestId, room } = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC' });
  mgr.decide({ requestId, accept: true });
  assert.deepEqual(sender.log[1], {
    to: 'S1',
    payload: { type: 'pair-result', requestId, accepted: true, room, receiverId: 'R1' }
  });
  mgr._teardown();
});

test('decide(deny) emits pair-result false with reason denied', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const { requestId } = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC' });
  mgr.decide({ requestId, accept: false });
  assert.equal(sender.log[1].to, 'S1');
  assert.equal(sender.log[1].payload.type, 'pair-result');
  assert.equal(sender.log[1].payload.accepted, false);
  assert.equal(sender.log[1].payload.reason, 'denied');
  mgr._teardown();
});

test('expire emits pair-expired and cancel-after-expire is a no-op', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 5, random: () => 0 });
  const { requestId } = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC' });
  mgr.expire(requestId);
  assert.equal(sender.log.at(-1).payload.type, 'pair-expired');
  // Calling decide after expire is a no-op
  const before = sender.log.length;
  mgr.decide({ requestId, accept: true });
  assert.equal(sender.log.length, before);
  mgr._teardown();
});

test('double-decide is a no-op (only first call emits)', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const { requestId } = mgr.request({ senderId: 'S1', receiverId: 'R1', senderName: 'My PC' });
  mgr.decide({ requestId, accept: true });
  const before = sender.log.length;
  mgr.decide({ requestId, accept: false });
  mgr.decide({ requestId, accept: true });
  assert.equal(sender.log.length, before);
  mgr._teardown();
});

test('decide on unknown requestId returns false and emits nothing', () => {
  const reg = makeRegistry();
  const sender = makeSend();
  const mgr = createPairManager({ registry: reg, send: sender.send, ttlMs: 1000, random: () => 0 });
  const result = mgr.decide({ requestId: 'missing', accept: true });
  assert.equal(result, false);
  assert.equal(sender.log.length, 0);
  mgr._teardown();
});
