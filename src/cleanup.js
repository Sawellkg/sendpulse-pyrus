'use strict';

const db = require('./db');

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const RETENTION_INTERVAL = '3 months';

async function runCleanup() {
  console.log('[cleanup] Starting stale conversations cleanup...');
  try {
    const deleted = await db.deleteStaleConversations(RETENTION_INTERVAL);
    console.log(`[cleanup] Done. Deleted ${deleted} conversation(s) with no activity for ${RETENTION_INTERVAL}.`);
  } catch (err) {
    console.error('[cleanup] Error during cleanup:', err.message);
  }
}

function scheduleCleanup() {
  // Run once a week; first run happens one week after server start
  const timer = setInterval(runCleanup, INTERVAL_MS);
  // Allow Node.js to exit even if the timer is still pending
  timer.unref();
  console.log(`[cleanup] Scheduled: stale conversations will be purged every 7 days (retention=${RETENTION_INTERVAL}).`);
}

module.exports = { scheduleCleanup };
