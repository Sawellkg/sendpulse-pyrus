'use strict';

const axios = require('axios');
const fs = require('fs');
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
    console.error(`[pyrusApi] ${method.toUpperCase()} ${path} error:`, err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send an incoming message to Pyrus via Extensions API /getmessage.
 * On first call with a dialog_id, Pyrus creates a task.
 * On subsequent calls with the same dialog_id, Pyrus adds a comment.
 * Returns { task_id }.
 */
async function sendIncomingMessage({ accountId, channelId, senderName, messageText, messageId, messageType, mappings, attachments }) {
  const body = {
    account_id: accountId,
    channel_id: channelId,
    sender_name: senderName,
    message_text: messageText,
  };
  if (messageId)                    body.message_id = messageId;
  if (messageType)                  body.message_type = messageType;
  if (mappings)                     body.mappings = mappings;
  if (attachments?.length)          body.attachments = attachments;
  return call('post', '/getmessage', body);
}

/**
 * Upload a file to Pyrus and return its guid.
 * Uses Node 20+ native FormData and Blob.
 */
async function uploadFile(filePath, fileName) {
  const token = await getToken();
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);
  const form = new FormData();
  form.append('file', blob, fileName);
  try {
    const res = await axios.post(`${BASE}/files/upload`, form, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data.guid;
  } catch (err) {
    console.error('[pyrusApi] uploadFile error:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Download a file from Pyrus by its numeric attachment ID.
 * Returns { buffer, contentType, fileName }.
 */
async function downloadFile(fileId) {
  const token = await getToken();
  const res = await axios.get(`${BASE}/files/download/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 60_000,
  });
  const contentType = res.headers['content-type'] || 'application/octet-stream';
  const disposition = res.headers['content-disposition'] || '';
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
  const fileName = nameMatch ? decodeURIComponent(nameMatch[1].trim()) : `file_${fileId}.${ext}`;
  return { buffer: Buffer.from(res.data), contentType, fileName };
}

module.exports = { sendIncomingMessage, uploadFile, downloadFile };
