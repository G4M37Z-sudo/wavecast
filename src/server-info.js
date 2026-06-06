import os from 'node:os';

export function getLocalNetworkUrls(port, networkInterfaces = os.networkInterfaces()) {
  const urls = [`http://localhost:${port}`];

  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return [...new Set(urls)];
}

/**
 * Get this host's local IPv4 addresses paired with their /24 subnet.
 * Each entry: { address, subnet (first three octets), url }
 *
 * A client on the same /24 subnet (e.g. 192.168.1.x) is treated as
 * "same network" for WaveCast purposes — that's the typical home/office
 * Wi-Fi range. Mobile hotspots and most corporate networks also use /24.
 */
export function getLocalNetworks(port, networkInterfaces = os.networkInterfaces()) {
  const seen = new Set();
  const out = [];
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      const parts = entry.address.split('.');
      if (parts.length !== 4) continue;
      const subnet = parts.slice(0, 3).join('.');
      out.push({ address: entry.address, subnet, url: `http://${entry.address}:${port}` });
    }
  }
  return out;
}

/**
 * Pure: is a given IP on the same /24 subnet as this host's first
 * non-internal IPv4 address? Returns false if we can't determine.
 */
export function isSameSubnet(ip, networkInterfaces = os.networkInterfaces()) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const targetSubnet = parts.slice(0, 3).join('.');
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ep = entry.address.split('.');
      if (ep.length !== 4) continue;
      if (ep.slice(0, 3).join('.') === targetSubnet) return true;
    }
  }
  return false;
}
