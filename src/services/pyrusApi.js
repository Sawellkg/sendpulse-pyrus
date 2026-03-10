'use strict';

const axios = require('axios');
const config = require('../config');

const BASE = config.pyrus.baseUrl;
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

let tokenCache = { token: null, fetchedAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS) {
    return tokenCache.token;
  }
  const res = await axios.post(`${BASE}/token`, {
    client_id: config.pyrus.clientId,
    secret: config.pyrus.secretKey,
  });
  tokenCache = { token: res.data.access_token, fetchedAt: Date.now() };
  return tokenCache.token;
}

function invalidateToken() {
  tokenCache = { token: null, fetchedAt: 0 };
}

async function call(method, path, data) {
  const token = await getToken();
  try {
    const res = await axios({
      method,
      url: `${BASE}${path}`,
      data,
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      invalidateToken();
      const newToken = await getToken();
      const res = await axios({
        method,
        url: `${BASE}${path}`,
        data,
        headers: { Authorization: `Bearer ${newToken}` },
      });
      return res.data;
    }
    throw err;
  }
}

/**
 * Send an incoming message to Pyrus via Extensions API /getmessage.
 * On first call with a dialog_id, Pyrus creates a task.
 * On subsequent calls with the same dialog_id, Pyrus adds a comment.
 * Returns { task_id }.
 */
async function sendIncomingMessage({ dialogId, messageId, title, text, userName }) {
  return call('post', '/getmessage', {
    dialog_id: dialogId,
    message_id: messageId || undefined,
    title,
    text,
    user: { name: userName },
  });
}

module.exports = { sendIncomingMessage };
