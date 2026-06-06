import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetshSsid, createSsidDetector } from '../src/network.js';

const SINGLE_INTERFACE = `There is no wireless interface on the system.

Interface name: Wi-Fi
    State                         : connected
    SSID                          : MyHomeWifi
    BSSID                         : aa:bb:cc:dd:ee:ff
`;

const MULTI_INTERFACE = `Interface name: Wi-Fi
    State                         : connected
    SSID                          : FirstNetwork
    BSSID                         : aa:bb:cc:dd:ee:ff

Interface name: Wi-Fi 2
    State                         : disconnected
    SSID                          :
    BSSID                         : 00:00:00:00:00:00
`;

const NO_SSID_LINE = `Interface name: Ethernet
    State                         : connected
`;

const REDACTED = `Interface name: Wi-Fi
    State                         : connected
    SSID                          :
    BSSID                         : aa:bb:cc:dd:ee:ff
`;

const MALFORMED = `garbage lines
with no structured content
at all really`;

test('parseNetshSsid returns SSID from a single-interface output', () => {
  assert.equal(parseNetshSsid(SINGLE_INTERFACE), 'MyHomeWifi');
});

test('parseNetshSsid returns the first non-empty SSID across multiple interfaces', () => {
  assert.equal(parseNetshSsid(MULTI_INTERFACE), 'FirstNetwork');
});

test('parseNetshSsid returns null when there is no SSID line at all', () => {
  assert.equal(parseNetshSsid(NO_SSID_LINE), null);
});

test('parseNetshSsid returns null when the SSID is empty/redacted', () => {
  assert.equal(parseNetshSsid(REDACTED), null);
});

test('parseNetshSsid returns null for malformed input', () => {
  assert.equal(parseNetshSsid(MALFORMED), null);
  assert.equal(parseNetshSsid(''), null);
});

test('createSsidDetector returns wlan source on Windows when netsh succeeds', async () => {
  const exec = async (cmd, args) => ({ stdout: SINGLE_INTERFACE, stderr: '' });
  const detect = createSsidDetector({ exec, platform: 'win32' });
  const out = await detect();
  assert.deepEqual(out, { ssid: 'MyHomeWifi', source: 'wlan' });
});

test('createSsidDetector returns fallback when netsh has no SSID', async () => {
  const exec = async () => ({ stdout: REDACTED, stderr: '' });
  const detect = createSsidDetector({ exec, platform: 'win32' });
  const out = await detect();
  assert.deepEqual(out, { ssid: 'This network', source: 'fallback' });
});

test('createSsidDetector returns fallback when exec throws', async () => {
  const exec = async () => { throw new Error('not found'); };
  const detect = createSsidDetector({ exec, platform: 'win32' });
  const out = await detect();
  assert.deepEqual(out, { ssid: 'This network', source: 'fallback' });
});

test('createSsidDetector returns fallback on non-Windows platforms without invoking exec', async () => {
  let called = false;
  const exec = async () => { called = true; return { stdout: '' }; };
  const detect = createSsidDetector({ exec, platform: 'linux' });
  const out = await detect();
  assert.equal(called, false);
  assert.deepEqual(out, { ssid: 'This network', source: 'fallback' });
});
