import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPeerId,
  buildRegister,
  parsePresenceSnapshot,
  isPairControlMessage
} from '../src/protocol.js';
import { createPresenceRegistry } from '../src/presence.js';

test('createPeerId returns uppercase URL-safe codes of length 6 by default', () => {
  const id = createPeerId(undefined, () => 0.5);
  assert.equal(id.length, 6);
  assert.match(id, /^[A-Z0-9]+$/);
});

test('createPeerId honors length argument', () => {
  assert.equal(createPeerId(10, () => 0).length, 10);
});

test('buildRegister trims and clips name to 24 characters', () => {
  const long = 'a'.repeat(40);
  const msg = buildRegister({ role: 'sender', name: `  ${long}  ` });
  assert.equal(msg.type, 'register');
  assert.equal(msg.role, 'sender');
  assert.equal(msg.name.length, 24);
  assert.equal(msg.name, 'a'.repeat(24));
});

test('buildRegister returns null on invalid role', () => {
  assert.equal(buildRegister({ role: 'admin', name: 'X' }), null);
  assert.equal(buildRegister({ role: undefined, name: 'X' }), null);
});

test('parsePresenceSnapshot returns peer list from snapshot message', () => {
  const peers = [{ peerId: 'A', name: 'TV', role: 'receiver', lastSeen: 1 }];
  assert.deepEqual(parsePresenceSnapshot({ type: 'presence-snapshot', peers }), peers);
});

test('parsePresenceSnapshot returns empty array for missing peers', () => {
  assert.deepEqual(parsePresenceSnapshot({ type: 'presence-snapshot' }), []);
});

test('isPairControlMessage accepts the 9 control types', () => {
  for (const type of ['register', 'pair-request', 'pair-invite', 'pair-invite-result', 'pair-offer', 'pair-accept', 'pair-deny', 'pair-result', 'pair-expired']) {
    assert.equal(isPairControlMessage({ type }), true, `expected ${type} to be a pair control message`);
  }
});

test('isPairControlMessage rejects WebRTC signaling and other types', () => {
  for (const type of ['offer', 'answer', 'ice-candidate', 'join', 'peer-ready', 'peer-left', 'presence-update', 'welcome', 'unknown']) {
    assert.equal(isPairControlMessage({ type }), false, `expected ${type} NOT to be a pair control message`);
  }
});

test('isPairControlMessage rejects non-objects', () => {
  assert.equal(isPairControlMessage(null), false);
  assert.equal(isPairControlMessage('pair-request'), false);
});

test('register adds a peer and snapshot returns it', () => {
  const reg = createPresenceRegistry();
  reg.register('AAA', 'sender', 'My PC');
  assert.deepEqual(reg.snapshot(), [
    { peerId: 'AAA', name: 'My PC', role: 'sender', lastSeen: reg.snapshot()[0].lastSeen }
  ]);
});

test('register includes a numeric lastSeen timestamp', () => {
  const reg = createPresenceRegistry({ clock: () => 1234 });
  reg.register('AAA', 'sender', 'My PC');
  assert.equal(reg.snapshot()[0].lastSeen, 1234);
});

test('snapshot returns peers sorted by connectedAt', () => {
  const reg = createPresenceRegistry();
  reg.register('A', 'sender', 'A'); // connectedAt 0
  reg.register('B', 'sender', 'B'); // connectedAt 1
  reg.register('C', 'sender', 'C'); // connectedAt 2
  assert.deepEqual(reg.snapshot().map((p) => p.peerId), ['A', 'B', 'C']);
});

test('unregister removes a peer and is a no-op for missing peer', () => {
  const reg = createPresenceRegistry();
  reg.register('A', 'sender', 'A');
  reg.unregister('A');
  reg.unregister('does-not-exist');
  assert.equal(reg.snapshot().length, 0);
});

test('rename updates name and is a no-op for missing peer', () => {
  const reg = createPresenceRegistry();
  reg.register('A', 'receiver', 'old');
  reg.rename('A', 'new');
  reg.rename('missing', 'whatever');
  assert.equal(reg.snapshot()[0].name, 'new');
});

test('get returns the live peer entry or undefined', () => {
  const reg = createPresenceRegistry();
  reg.register('A', 'sender', 'A');
  assert.equal(reg.get('A').name, 'A');
  assert.equal(reg.get('missing'), undefined);
});
