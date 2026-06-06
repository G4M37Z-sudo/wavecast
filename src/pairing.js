import { createRoomCode } from './protocol.js';

export function createPairManager({
  registry,
  send,
  ttlMs = 30_000,
  random = Math.random
} = {}) {
  const pending = new Map(); // requestId -> { senderId, receiverId, senderName, room, timer, settled }
  const timers = new Set();

  function settle(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return null;
    if (entry.timer) {
      clearTimeout(entry.timer);
      timers.delete(entry.timer);
      entry.timer = null;
    }
    entry.settled = true;
    return entry;
  }

  function request({ senderId, receiverId, senderName, room }) {
    if (!registry || !registry.get(receiverId)) {
      // Allow synthetic receivers (e.g. '__QR__' for code/QR flows where the
      // real receiver claims the room asynchronously). The presence registry
      // does not contain synthetic IDs.
      if (receiverId !== '__QR__') return null;
    }
    const finalRoom = room || createRoomCode(6, random);
    const requestId = createRoomCode(8, random);
    const entry = { senderId, receiverId, senderName, room: finalRoom, timer: null, settled: false };
    pending.set(requestId, entry);

    // TTL is only applied to tap-to-pair and invite flows. Room-claim
    // reservations (synthetic __QR__ receiver) are pinned — the user needs
    // as much time as it takes to scan/type the code, which can be minutes.
    if (receiverId !== '__QR__') {
      entry.timer = setTimeout(() => {
        timers.delete(entry.timer);
        if (entry.settled) return;
        entry.settled = true;
        pending.delete(requestId);
        send(senderId, { type: 'pair-expired', requestId });
      }, ttlMs);
      timers.add(entry.timer);
    }

    send(receiverId, { type: 'pair-offer', requestId, senderId, senderName, room: finalRoom });
    return { requestId, room: finalRoom };
  }

  /**
   * Find a pending pair whose `room` matches the given code. Used by the
   * QR-code / room-code flow: the receiver claims a pre-reserved room.
   * Returns the entry (so the caller can read senderId, senderName) or null.
   */
  function findPendingByRoom(room) {
    for (const [requestId, entry] of pending.entries()) {
      if (entry.settled) continue;
      if (entry.room === room) return { requestId, entry };
    }
    return null;
  }

  /** Send a fresh pair-offer for a known pending entry (e.g. when receiver claims via room). */
  function replayOffer(requestId, realReceiverId) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    if (realReceiverId) entry.receiverId = realReceiverId;
    send(entry.receiverId, { type: 'pair-offer', requestId, senderId: entry.senderId, senderName: entry.senderName, room: entry.room });
    return true;
  }

  function decide({ requestId, accept }) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return false;
    settle(requestId);
    pending.delete(requestId);
    if (accept) {
      // Tell the sender who the real receiver is so they can open a WebRTC channel
      send(entry.senderId, { type: 'pair-result', requestId, accepted: true, room: entry.room, receiverId: entry.receiverId });
      send(entry.receiverId, { type: 'pair-result', requestId, accepted: true, room: entry.room });
    } else {
      send(entry.senderId, { type: 'pair-result', requestId, accepted: false, reason: 'denied' });
    }
    return true;
  }

  function expire(requestId) {
    const entry = pending.get(requestId);
    if (!entry || entry.settled) return false;
    settle(requestId);
    pending.delete(requestId);
    send(entry.senderId, { type: 'pair-expired', requestId });
    return true;
  }

  /**
   * Cancel all pending pair requests for a given sender. Called when the
   * sender's presence connection drops, so room-claim reservations don't
   * leak forever.
   */
  function cancelBySender(senderId) {
    let cancelled = 0;
    for (const [requestId, entry] of pending.entries()) {
      if (entry.senderId === senderId && !entry.settled) {
        settle(requestId);
        pending.delete(requestId);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  function _teardown() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    pending.clear();
  }

  return { request, findPendingByRoom, replayOffer, decide, expire, cancelBySender, _teardown };
}
