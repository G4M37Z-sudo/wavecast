import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalNetworkUrls, getLocalNetworks, isSameSubnet } from '../src/server-info.js';

test('getLocalNetworkUrls always includes localhost URL for chosen port', () => {
  const urls = getLocalNetworkUrls(9090, {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  });

  assert.ok(urls.includes('http://localhost:9090'));
});

test('getLocalNetworkUrls includes non-internal IPv4 interfaces', () => {
  const urls = getLocalNetworkUrls(8080, {
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    IPv6: [{ family: 'IPv6', internal: false, address: 'fe80::1' }]
  });

  assert.deepEqual(urls, ['http://localhost:8080', 'http://192.168.1.10:8080']);
});

test('getLocalNetworks returns address, subnet and URL per non-internal IPv4', () => {
  const nets = getLocalNetworks(8080, {
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  });
  assert.deepEqual(nets, [
    { address: '192.168.1.42', subnet: '192.168.1', url: 'http://192.168.1.42:8080' }
  ]);
});

test('getLocalNetworks deduplicates multiple addresses on the same interface', () => {
  const nets = getLocalNetworks(8080, {
    Ethernet: [
      { family: 'IPv4', internal: false, address: '10.0.0.5' },
      { family: 'IPv4', internal: false, address: '10.0.0.5' }
    ]
  });
  assert.equal(nets.length, 1);
});

test('isSameSubnet is true for IPs sharing first three octets', () => {
  const nics = { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }] };
  assert.equal(isSameSubnet('192.168.1.55', nics), true);
  assert.equal(isSameSubnet('192.168.2.55', nics), false);
  assert.equal(isSameSubnet('10.0.0.1', nics), false);
});

test('isSameSubnet returns false for invalid input', () => {
  assert.equal(isSameSubnet('not-an-ip', {}), false);
  assert.equal(isSameSubnet('', {}), false);
  assert.equal(isSameSubnet(null, {}), false);
});
