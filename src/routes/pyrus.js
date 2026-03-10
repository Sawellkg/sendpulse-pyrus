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
router.post('/authorize', verifySignature, async (req, res) => {
  try {
    const body = req.body;
    const accountId = body.account_id;
    const credentials = body.credentials || [];

    const get = (code) => {
      const found = credentials.find((c) => c.code === code);
      return found ? found.value : null;
    };

    const spClientId = get('sp_client_id');
    const spClientSecret = get('sp_client_secret');
    const spBotId = get('sp_bot_id');
    const pyrusFormId = parseInt(get('form_id'), 10);

    if (!spClientId || !spClientSecret || !spBotId || !pyrusFormId) {
      return res.status(400).json({
        error: 'bad_credentials',
        message: 'Required parameters: sp_client_id, sp_client_secret, sp_bot_id, form_id',
      });
    }

    // Validate SendPulse credentials
    try {
      await sendpulseApi.validateCredentials(spClientId, spClientSecret);
    } catch {
      return res.status(400).json({
        error: 'bad_credentials',
        message: 'Invalid SendPulse credentials',
      });
    }

    await db.upsertAccount({ accountId, spClientId, spClientSecret, spBotId, pyrusFormId });
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
