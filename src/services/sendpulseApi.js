'use strict';

const axios = require('axios');

const BASE = 'https://api.sendpulse.com';
const TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutes (SP tokens live 1 hour)

// Per-account token cache: { [spClientId]: { token, fetchedAt } }
const tokenCaches = {};

async function getToken(spClientId, spClientSecret) {
  const cache = tokenCaches[spClientId];
  if (cache && cache.token && Date.now() - cache.fetchedAt < TOKEN_TTL_MS) {
    return cache.token;
  }
  const res = await axios.post(`${BASE}/oauth/access_token`, {
    grant_type: 'client_credentials',
    client_id: spClientId,
    client_secret: spClientSecret,
  });
  tokenCaches[spClientId] = { token: res.data.access_token, fetchedAt: Date.now() };
  return res.data.access_token;
}

/**
 * Validate SendPulse credentials by attempting to obtain a token.
 * Throws if credentials are invalid.
 */
async function validateCredentials(spClientId, spClientSecret) {
  await getToken(spClientId, spClientSecret);
}

/**
 * Send a text message to a SendPulse contact.
 * @param {object} params
 * @param {string} params.spClientId
 * @param {string} params.spClientSecret
 * @param {string} params.botId      - SendPulse bot ID
 * @param {string} params.contactId  - SendPulse contact ID
 * @param {string} params.channel    - 'INSTAGRAM' | 'TELEGRAM'
 * @param {string} params.text
 */
async function sendMessage({ spClientId, spClientSecret, botId, contactId, channel, text }) {
  const token = await getToken(spClientId, spClientSecret);
  const service = channel.toLowerCase(); // 'instagram' or 'telegram'
  const url = `${BASE}/${service}/contacts/send`;
  const body = {
    bot_id: botId,
    contact_id: contactId,
    messages: [{ type: 'text', message: { text } }],
  };
  console.log(`[sp/sendMessage] POST ${url}`, JSON.stringify(body));

  try {
    const res = await axios.post(url, body, { headers: { Authorization: `Bearer ${token}` } });
    console.log('[sp/sendMessage] response:', res.status, JSON.stringify(res.data));
  } catch (err) {
    console.error('[sp/sendMessage] error:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Resolve the SendPulse message type for a given MIME contentType and channel.
 * Returns null if the type is not supported on that channel (caller should skip).
 */
function resolveMediaType(contentType, channel) {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  // Instagram does not support file/document messages
  if (channel.toUpperCase() === 'INSTAGRAM') return null;
  // Telegram supports arbitrary files
  return 'file';
}

/**
 * Send a media message (image/video/file) to a SendPulse contact via a public URL.
 * Returns false if the media type is not supported on the channel (caller may skip gracefully).
 */
async function sendMedia({ spClientId, spClientSecret, botId, contactId, channel, url, contentType }) {
  const msgType = resolveMediaType(contentType, channel);
  if (!msgType) {
    console.warn(`[sp/sendMedia] skipping unsupported contentType="${contentType}" for channel=${channel}`);
    return false;
  }

  const token = await getToken(spClientId, spClientSecret);
  const service = channel.toLowerCase();

  const body = {
    bot_id: botId,
    contact_id: contactId,
    messages: [{
      type: msgType,
      message: {
        attachment: {
          type: msgType,
          payload: { is_external_attachment: true, url },
        },
      },
    }],
  };

  console.log(`[sp/sendMedia] POST ${BASE}/${service}/contacts/send`, JSON.stringify({ ...body, messages: `[${msgType}]` }));
  try {
    const res = await axios.post(`${BASE}/${service}/contacts/send`, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('[sp/sendMedia] response:', res.status, JSON.stringify(res.data));
    return true;
  } catch (err) {
    console.error('[sp/sendMedia] error:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Pause bot automation for a contact so the bot doesn't reply while an operator is handling it.
 * @param {number} [minutes=1440] - Duration in minutes (default 24 hours)
 */
async function setPauseAutomation({ spClientId, spClientSecret, botId, contactId, channel, minutes = 120 }) {
  const token = await getToken(spClientId, spClientSecret);
  const service = channel.toLowerCase();
  const body = { bot_id: botId, contact_id: contactId, minutes };
  console.log(`[sp/setPauseAutomation] POST ${BASE}/${service}/contacts/setPauseAutomation`, JSON.stringify(body));
  try {
    const res = await axios.post(`${BASE}/${service}/contacts/setPauseAutomation`, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('[sp/setPauseAutomation] response:', res.status, JSON.stringify(res.data));
  } catch (err) {
    console.error('[sp/setPauseAutomation] error:', err.response?.status, JSON.stringify(err.response?.data));
    // Non-fatal — don't rethrow, operator message was already delivered
  }
}

/**
 * Fetch recent chat messages for a contact.
 * Used to look up the original message when handling reply_to.
 * Returns the raw data[] array from SP.
 */
async function getChatMessages({ spClientId, spClientSecret, contactId, size = 50 }) {
  const token = await getToken(spClientId, spClientSecret);
  const res = await axios.get(`${BASE}/instagram/chats/messages`, {
    params: { contact_id: contactId, size },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  return res.data?.data || [];
}

module.exports = { validateCredentials, sendMessage, sendMedia, setPauseAutomation, getChatMessages };
