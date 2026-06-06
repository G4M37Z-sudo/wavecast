export function createPresenceRegistry({ clock = () => Date.now() } = {}) {
  const peers = new Map(); // peerId -> { peerId, name, role, lastSeen, connectedAt }

  function register(peerId, role, name) {
    const connectedAt = peers.size;
    peers.set(peerId, {
      peerId,
      name,
      role,
      lastSeen: clock(),
      connectedAt
    });
  }

  function unregister(peerId) {
    peers.delete(peerId);
  }

  function rename(peerId, name) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.name = name;
    peer.lastSeen = clock();
  }

  function touch(peerId) {
    const peer = peers.get(peerId);
    if (peer) peer.lastSeen = clock();
  }

  function get(peerId) {
    return peers.get(peerId);
  }

  function snapshot() {
    return Array.from(peers.values())
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((peer) => ({
        peerId: peer.peerId,
        name: peer.name,
        role: peer.role,
        lastSeen: peer.lastSeen
      }));
  }

  return { register, unregister, rename, touch, get, snapshot };
}
