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

  await axios.post(
    `${BASE}/${service}/contacts/sendText`,
    {
      bot_id: botId,
      contact_id: contactId,
      message: { text },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

module.exports = { validateCredentials, sendMessage };
