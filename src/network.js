import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SSID_LINE = /^[ \t]*SSID[ \t]*:[ \t]*(.*?)[ \t]*$/gm;

export function parseNetshSsid(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  SSID_LINE.lastIndex = 0;
  let match;
  while ((match = SSID_LINE.exec(stdout)) !== null) {
    const value = match[1].trim();
    if (value.length > 0) return value;
  }
  return null;
}

export function createSsidDetector({
  exec = (cmd, args, opts) => execFileAsync(cmd, args, opts).then(({ stdout }) => ({ stdout: stdout ?? '' })),
  platform = process.platform
} = {}) {
  return async function detectSsid(timeoutMs = 1500) {
    if (platform !== 'win32') {
      return { ssid: 'This network', source: 'fallback' };
    }
    try {
      const { stdout } = await exec('netsh', ['wlan', 'show', 'interfaces'], { timeout: timeoutMs, windowsHide: true });
      const ssid = parseNetshSsid(stdout);
      if (ssid) return { ssid, source: 'wlan' };
      return { ssid: 'This network', source: 'fallback' };
    } catch {
      return { ssid: 'This network', source: 'fallback' };
    }
  };
}
