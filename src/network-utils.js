// Pure network helpers that work in both browser and Node.
// Browser uses these for WebRTC ICE parsing and subnet matching.
// Node tests import them via this module.

/**
 * Parse a single ICE candidate string and return any local IPv4
 * address found. Skips loopback, IPv6, and malformed candidates.
 *
 * Format: "candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ ..."
 */
export function parseLocalIpsFromCandidate(candidateString) {
  if (typeof candidateString !== 'string') return [];
  const parts = candidateString.split(/\s+/);
  if (parts.length < 6) return [];
  const ip = parts[4];
  if (!ip || ip.includes(':')) return [];
  const octets = ip.split('.');
  if (octets.length !== 4) return [];
  if (ip.startsWith('127.') || ip.startsWith('0.')) return [];
  return [ip];
}

/**
 * Two subnets are "the same network" if their first three octets match.
 * Both arguments should be like "192.168.1" (no trailing dot). Anything
 * that doesn't look like a valid /24 prefix is treated as "unknown"
 * and the comparison returns false.
 */
export function isSameSubnet(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return false;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b)) return false;
  return a === b;
}

/**
 * Rank an IPv4 by how "private" (LAN-ish) it is. Lower is better.
 *   0 = 192.168.x.x
 *   1 = 10.x.x.x
 *   2 = 172.16-31.x.x
 *   3 = everything else (public, link-local, etc.)
 */
export function privateAddressRank(ip) {
  if (typeof ip !== 'string') return 3;
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 3;
}
