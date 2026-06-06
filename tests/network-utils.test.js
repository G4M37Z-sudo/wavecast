import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocalIpsFromCandidate,
  isSameSubnet,
  privateAddressRank
} from '../src/network-utils.js';

test('parseLocalIpsFromCandidate extracts IPv4 from a host candidate', () => {
  const c = 'candidate:1 1 udp 2122260223 192.168.1.10 12345 typ host generation 0';
  assert.deepEqual(parseLocalIpsFromCandidate(c), ['192.168.1.10']);
});

test('parseLocalIpsFromCandidate extracts IPv4 from an srflx candidate', () => {
  const c = 'candidate:2 1 udp 1677729535 10.0.0.5 54321 typ srflx raddr 192.168.1.10 rport 12345';
  assert.deepEqual(parseLocalIpsFromCandidate(c), ['10.0.0.5']);
});

test('parseLocalIpsFromCandidate skips loopback', () => {
  const c = 'candidate:1 1 udp 2122260223 127.0.0.1 12345 typ host';
  assert.deepEqual(parseLocalIpsFromCandidate(c), []);
});

test('parseLocalIpsFromCandidate skips 0.0.0.0', () => {
  const c = 'candidate:1 1 udp 2122260223 0.0.0.0 12345 typ host';
  assert.deepEqual(parseLocalIpsFromCandidate(c), []);
});

test('parseLocalIpsFromCandidate skips IPv6', () => {
  const c = 'candidate:1 1 udp 2122260223 fe80::1 12345 typ host';
  assert.deepEqual(parseLocalIpsFromCandidate(c), []);
});

test('parseLocalIpsFromCandidate returns [] for malformed input', () => {
  assert.deepEqual(parseLocalIpsFromCandidate(''), []);
  assert.deepEqual(parseLocalIpsFromCandidate('candidate:1 1 udp'), []);
  assert.deepEqual(parseLocalIpsFromCandidate(null), []);
  assert.deepEqual(parseLocalIpsFromCandidate(undefined), []);
  assert.deepEqual(parseLocalIpsFromCandidate(42), []);
});

test('isSameSubnet is true for identical /24 prefixes', () => {
  assert.equal(isSameSubnet('192.168.1', '192.168.1'), true);
  assert.equal(isSameSubnet('10.0.0', '10.0.0'), true);
});

test('isSameSubnet is false for different subnets', () => {
  assert.equal(isSameSubnet('192.168.1', '192.168.2'), false);
  assert.equal(isSameSubnet('10.0.0', '192.168.1'), false);
});

test('isSameSubnet returns false for empty / invalid input', () => {
  assert.equal(isSameSubnet('', ''), false);
  assert.equal(isSameSubnet('192.168.1', ''), false);
  assert.equal(isSameSubnet(null, '192.168.1'), false);
  assert.equal(isSameSubnet('a', 'b'), false);
  assert.equal(isSameSubnet('192.168', '192.168'), false); // not enough octets
  assert.equal(isSameSubnet('192.168.1.0', '192.168.1.0'), false); // four octets — caller should pre-trim
});

test('privateAddressRank ranks 192.168. first', () => {
  assert.equal(privateAddressRank('192.168.1.1'), 0);
  assert.equal(privateAddressRank('10.0.0.1'), 1);
  assert.equal(privateAddressRank('172.16.0.1'), 2);
  assert.equal(privateAddressRank('172.31.255.1'), 2);
  assert.equal(privateAddressRank('172.32.0.1'), 3); // outside private range
  assert.equal(privateAddressRank('8.8.8.8'), 3);
  assert.equal(privateAddressRank('not-an-ip'), 3);
  assert.equal(privateAddressRank(null), 3);
});
