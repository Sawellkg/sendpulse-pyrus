'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const sendpulseApi = require('../services/sendpulseApi');

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
    const accountId = body.account_id;
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

    // Use spBotId as account_id if Pyrus didn't send one
    const resolvedAccountId = accountId || spBotId;

    // Validate SendPulse credentials
    try {
      await sendpulseApi.validateCredentials(spClientId, spClientSecret);
      console.log('[pyrus/authorize] SP credentials valid');
    } catch (spErr) {
      console.error('[pyrus/authorize] SP validation failed:', spErr.message);
      return res.status(200).json({ error: 'bad_credentials' });
    }

    try {
      await db.upsertAccount({ accountId: resolvedAccountId, spClientId, spClientSecret, spBotId });
      console.log('[pyrus/authorize] account saved, id:', resolvedAccountId);
    } catch (dbErr) {
      console.error('[pyrus/authorize] DB error:', dbErr.message);
      return res.status(500).json({ error: 'internal_error' });
    }

    res.json({ status: 'ok' });
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
router.post('/sendmessage', verifySignature, async (req, res) => {
  try {
    const { task_id, text } = req.body;

    if (!task_id || !text) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const conversation = await db.getConversationByTaskId(task_id);
    if (!conversation) {
      console.warn(`[pyrus/sendmessage] No conversation for task_id=${task_id}`);
      return res.json({ status: 'ok' });
    }

    const account = await db.getAccount(conversation.account_id);
    if (!account) {
      console.warn(`[pyrus/sendmessage] No account for account_id=${conversation.account_id}`);
      return res.json({ status: 'ok' });
    }

    await sendpulseApi.sendMessage({
      spClientId: account.sp_client_id,
      spClientSecret: account.sp_client_secret,
      botId: conversation.sendpulse_bot_id,
      contactId: conversation.sendpulse_contact_id,
      channel: conversation.channel,
      text,
    });

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[pyrus/sendmessage]', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
