'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const sendpulseApi = require('../services/sendpulseApi');
const pyrusApi = require('../services/pyrusApi');
const tempStore = require('../tempStore');
const sentCache = require('../sentCache');

const router = express.Router();

// HMAC-SHA1 signature verification middleware
function verifySignature(req, res, next) {
  const sig = req.headers['x-pyrus-sig'];
  if (!sig || !config.pyrus.webhookSecret) {
    return next();
  }
  const expected = crypto
    .createHmac('sha1', config.pyrus.webhookSecret)
    .update(req.rawBody || '')
    .digest('hex');
  if (sig !== expected) {
    return res.status(403).json({ error: 'invalid_signature' });
  }
  next();
}

// GET /pyrus/pulse — heartbeat
router.get('/pulse', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /pyrus/authorize — store per-account SendPulse credentials
router.post('/authorize', async (req, res) => {
  try {
    const body = req.body;
    console.log('[pyrus/authorize] body:', JSON.stringify(body));
    const credentials = body.credentials || [];

    const get = (code) => {
      const found = credentials.find((c) => c.code === code);
      return found ? found.value : null;
    };

    const spClientId = get('sp_client_id');
    const spClientSecret = get('sp_client_secret');
    const spBotId = get('sp_bot_id');

    console.log('[pyrus/authorize] parsed:', { spClientId: !!spClientId, spClientSecret: !!spClientSecret, spBotId: !!spBotId });

    if (!spClientId || !spClientSecret || !spBotId) {
      console.warn('[pyrus/authorize] missing required params');
      return res.status(200).json({ error: 'bad_credentials' });
    }

    await db.upsertAccount({ accountId: spBotId, spClientId, spClientSecret, spBotId });
    console.log('[pyrus/authorize] account saved, id:', spBotId);

    // Pyrus messenger extension expects: account_name + account_id
    res.json({ account_name: 'SendPulse', account_id: spBotId });
  } catch (err) {
    console.error('[pyrus/authorize]', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /pyrus/toggle — enable/disable notifications
router.post('/toggle', verifySignature, (req, res) => {
  res.json({ status: 'ok' });
});

// POST /pyrus/event — task events (log only)
router.post('/event', verifySignature, (req, res) => {
  res.json({ status: 'ok' });
});

// POST /pyrus/createdialog — Pyrus initiates dialog
router.post('/createdialog', verifySignature, (req, res) => {
  res.json({ status: 'ok' });
});

// POST /pyrus/sendmessage — agent replied in Pyrus → forward to SendPulse
// Pyrus sends: { account_id, channel_id, message_text, attachment_ids, credentials }
router.post('/sendmessage', verifySignature, async (req, res) => {
  try {
    console.log('[pyrus/sendmessage] body:', JSON.stringify(req.body));
    const { account_id, channel_id, message_text, attachment_ids } = req.body;
    const hasText = message_text && message_text.trim();
    const hasAttachments = Array.isArray(attachment_ids) && attachment_ids.length > 0;

    if (!account_id || !channel_id || (!hasText && !hasAttachments)) {
      return res.json({ status: 'ok' });
    }

    const account = await db.getAccountByBotId(account_id);
    if (!account) {
      console.warn(`[pyrus/sendmessage] No account for account_id=${account_id}`);
      return res.json({ status: 'ok' });
    }

    const conversation = await db.getConversation(account.account_id, channel_id);
    if (!conversation) {
      console.warn(`[pyrus/sendmessage] No conversation for channel_id=${channel_id}`);
      return res.json({ status: 'ok' });
    }

    const spParams = {
      spClientId: account.sp_client_id,
      spClientSecret: account.sp_client_secret,
      botId: conversation.sendpulse_bot_id,
      contactId: channel_id,
      channel: conversation.channel,
    };

    // Send text message
    if (hasText) {
      await sendpulseApi.sendMessage({ ...spParams, text: message_text });
    }

    // Send attachments
    if (hasAttachments) {
      const { serviceUrl } = require('../config');
      for (const fileId of attachment_ids) {
        try {
          const { buffer, contentType, fileName } = await pyrusApi.downloadFile(fileId);
          const uuid = tempStore.put(buffer, contentType, fileName);
          const publicUrl = `${serviceUrl}/temp/${uuid}`;
          console.log(`[pyrus/sendmessage] serving attachment ${fileId} as ${publicUrl}`);
          await sendpulseApi.sendMedia({ ...spParams, url: publicUrl, contentType });
        } catch (attErr) {
          console.error(`[pyrus/sendmessage] attachment ${fileId} failed:`, attErr.message);
        }
      }
    }

    // Save outgoing message to DB
    if (hasText) {
      const mid = `pyrus_${Date.now()}_${channel_id}`;
      await db.saveMessage(mid, message_text, 'outgoing', conversation.id);
    }

    sentCache.mark(channel_id);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[pyrus/sendmessage]', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
