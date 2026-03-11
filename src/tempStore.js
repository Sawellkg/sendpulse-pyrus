'use strict';

const crypto = require('crypto');

// In-memory store for temporary files: { uuid -> { buffer, contentType, fileName, timer } }
const store = new Map();

const TTL_MS = 5 * 60 * 1000; // 5 minutes

function put(buffer, contentType, fileName) {
  const uuid = crypto.randomBytes(16).toString('hex');
  const timer = setTimeout(() => store.delete(uuid), TTL_MS);
  store.set(uuid, { buffer, contentType, fileName, timer });
  return uuid;
}

function get(uuid) {
  return store.get(uuid) || null;
}

function remove(uuid) {
  const entry = store.get(uuid);
  if (entry) {
    clearTimeout(entry.timer);
    store.delete(uuid);
  }
}

module.exports = { put, get, remove };
