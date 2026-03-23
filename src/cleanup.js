'use strict';

const db = require('./db');

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const RETENTION_INTERVAL = '3 months';

async function runCleanup() {
  console.log('[cleanup] Starting scheduled cleanup...');
  try {
    const deletedConvs = await db.deleteStaleConversations(RETENTION_INTERVAL);
    console.log(`[cleanup] Deleted ${deletedConvs} conversation(s) with no activity for ${RETENTION_INTERVAL}.`);
  } catch (err) {
    console.error('[cleanup] Error cleaning conversations:', err.message);
  }
  try {
    const deletedRefs = await db.deleteStaleFileRefs(RETENTION_INTERVAL);
    console.log(`[cleanup] Deleted ${deletedRefs} file_ref(s) older than ${RETENTION_INTERVAL}.`);
  } catch (err) {
    console.error('[cleanup] Error cleaning file_refs:', err.message);
  }
  console.log('[cleanup] Done.');
}

function scheduleCleanup() {
  // Run once a week; first run happens one week after server start
  const timer = setInterval(runCleanup, INTERVAL_MS);
  // Allow Node.js to exit even if the timer is still pending
  timer.unref();
  console.log(`[cleanup] Scheduled: stale conversations will be purged every 7 days (retention=${RETENTION_INTERVAL}).`);
}

module.exports = { scheduleCleanup };
