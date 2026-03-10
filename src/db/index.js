'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.databaseUrl });

async function initSchema() {
  // Migrations
  await pool.query(`ALTER TABLE accounts DROP COLUMN IF EXISTS pyrus_form_id;`).catch(() => {});
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS access_token TEXT;`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id       TEXT PRIMARY KEY,
      sp_client_id     TEXT NOT NULL,
      sp_client_secret TEXT NOT NULL,
      sp_bot_id        TEXT NOT NULL,
      access_token     TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id                   SERIAL PRIMARY KEY,
      account_id           TEXT NOT NULL REFERENCES accounts(account_id),
      sendpulse_contact_id TEXT NOT NULL,
      sendpulse_bot_id     TEXT NOT NULL,
      channel              TEXT NOT NULL,
      pyrus_task_id        INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(account_id, sendpulse_contact_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      mid              TEXT PRIMARY KEY,
      text             TEXT NOT NULL,
      pyrus_comment_id INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// accounts

async function upsertAccount({ accountId, spClientId, spClientSecret, spBotId, accessToken }) {
  await pool.query(
    `INSERT INTO accounts (account_id, sp_client_id, sp_client_secret, sp_bot_id, access_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id) DO UPDATE SET
       sp_client_id = EXCLUDED.sp_client_id,
       sp_client_secret = EXCLUDED.sp_client_secret,
       sp_bot_id = EXCLUDED.sp_bot_id,
       access_token = EXCLUDED.access_token`,
    [accountId, spClientId, spClientSecret, spBotId, accessToken]
  );
}

async function getAccount(accountId) {
  const { rows } = await pool.query('SELECT * FROM accounts WHERE account_id = $1', [accountId]);
  return rows[0] || null;
}

async function getAccountByBotId(spBotId) {
  const { rows } = await pool.query('SELECT * FROM accounts WHERE sp_bot_id = $1 LIMIT 1', [spBotId]);
  return rows[0] || null;
}

// conversations

async function getConversation(accountId, sendpulseContactId) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE account_id = $1 AND sendpulse_contact_id = $2',
    [accountId, sendpulseContactId]
  );
  return rows[0] || null;
}

async function getConversationByTaskId(pyrusTaskId) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE pyrus_task_id = $1',
    [pyrusTaskId]
  );
  return rows[0] || null;
}

async function createConversation({ accountId, sendpulseContactId, sendpulseBotId, channel }) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (account_id, sendpulse_contact_id, sendpulse_bot_id, channel)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [accountId, sendpulseContactId, sendpulseBotId, channel]
  );
  return rows[0];
}

async function updateConversationTaskId(id, pyrusTaskId) {
  await pool.query('UPDATE conversations SET pyrus_task_id = $1 WHERE id = $2', [pyrusTaskId, id]);
}

// messages

async function saveMessage(mid, text) {
  await pool.query(
    `INSERT INTO messages (mid, text) VALUES ($1, $2) ON CONFLICT (mid) DO NOTHING`,
    [mid, text]
  );
}

async function getMessage(mid) {
  const { rows } = await pool.query('SELECT * FROM messages WHERE mid = $1', [mid]);
  return rows[0] || null;
}

async function updateMessageCommentId(mid, pyrusCommentId) {
  await pool.query('UPDATE messages SET pyrus_comment_id = $1 WHERE mid = $2', [pyrusCommentId, mid]);
}

module.exports = {
  initSchema,
  upsertAccount,
  getAccount,
  getAccountByBotId,
  getConversation,
  getConversationByTaskId,
  createConversation,
  updateConversationTaskId,
  saveMessage,
  getMessage,
  updateMessageCommentId,
};
