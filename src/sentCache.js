'use strict';

// Temporary in-memory cache to track contacts we recently sent messages to
// via /sendmessage (from Pyrus). Used to suppress echo in outgoing webhooks.

const cache = new Map();

function mark(contactId, ttlMs = 30_000) {
  cache.set(contactId, Date.now() + ttlMs);
}

function has(contactId) {
  const exp = cache.get(contactId);
  if (!exp) return false;
  if (Date.now() > exp) { cache.delete(contactId); return false; }
  return true;
}

module.exports = { mark, has };
