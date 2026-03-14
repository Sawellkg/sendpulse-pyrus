'use strict';

// Per-contact Promise chain queue.
// Ensures all processing for a given contactId runs sequentially,
// in the order enqueue() was called — no artificial delays needed.
const queues = new Map();

function enqueue(contactId, fn) {
  const prev = queues.get(contactId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch(err => console.error(`[queue] contact=${contactId}`, err.message));
  queues.set(contactId, next);
  next.finally(() => {
    if (queues.get(contactId) === next) queues.delete(contactId);
  });
}

module.exports = { enqueue };
