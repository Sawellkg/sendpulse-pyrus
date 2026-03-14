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
router.post('/toggle', verifySignature, async (req, res) => {
  try {
    const { account_id, enabled, deleted } = req.body;
    console.log('[pyrus/toggle] body:', JSON.stringify(req.body));
    if (account_id) {
      await db.updateAccountToggle(account_id, {
        enabled: enabled !== false,
        deleted: deleted === true,
      });
      console.log(`[pyrus/toggle] account=${account_id} enabled=${enabled} deleted=${deleted}`);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[pyrus/toggle]', err.message);
    res.json({ status: 'ok' }); // always 200 to Pyrus
  }
});

// POST /pyrus/event — task events (log only)
router.post('/event', verifySignature, (req, res) => {
  res.json({ status: 'ok' });
});

// POST /pyrus/createdialog — Pyrus initiates dialog
router.post('/createdialog', verifySignature, (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Map a SendPulse API error to a Pyrus sendmessage error response.
 */
function spErrorToPayrus(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  if (status === 401 || status === 403) {
    return { code: 400, body: { error_code: 'bad_credentials', error: 'SendPulse credentials are invalid or expired' } };
  }
  const msg = (typeof data === 'object' ? JSON.stringify(data) : String(data || err.message));
  if (msg.toLowerCase().includes('block')) {
    return { code: 400, body: { error_code: 'account_blocked_by_user', error: msg } };
  }
  return { code: 400, body: { error_code: 'external_error', error: msg } };
}

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

    // Mark before sending so the outgoing_message echo webhook is ignored
    sentCache.mark(channel_id);

    // Send text message
    if (hasText) {
      try {
        await sendpulseApi.sendMessage({ ...spParams, text: message_text });
        // Pause bot automation so the bot doesn't override the operator's reply
        await sendpulseApi.setPauseAutomation({ ...spParams });
      } catch (err) {
        const { code, body } = spErrorToPayrus(err);
        console.error('[pyrus/sendmessage] text send failed:', body);
        return res.status(code).json(body);
      }
    }

    // Send attachments
    if (hasAttachments) {
      const { serviceUrl } = require('../config');
      for (const fileId of attachment_ids) {
        try {
          const { buffer, contentType, fileName } = await pyrusApi.downloadFile(fileId);
          const uuid = tempStore.put(buffer, contentType, fileName);
          await db.saveFileRef(uuid, fileId, contentType, fileName);
          const publicUrl = `${serviceUrl}/temp/${uuid}`;
          console.log(`[pyrus/sendmessage] serving attachment ${fileId} as ${publicUrl}`);
          const sent = await sendpulseApi.sendMedia({ ...spParams, url: publicUrl, contentType });
          if (sent === false) {
            // Unsupported file type for this channel — notify operator in Pyrus task
            const notice = `⚠️ Файл "${fileName}" не был отправлен клиенту: ${conversation.channel} не поддерживает этот тип файлов (${contentType}).`;
            try {
              await pyrusApi.sendIncomingMessage({
                accountId: account_id,
                channelId: channel_id,
                senderName: 'Система',
                messageText: notice,
              });
            } catch (noticeErr) {
              console.warn(`[pyrus/sendmessage] could not send unsupported-type notice to Pyrus:`, noticeErr.message);
            }
          }
        } catch (attErr) {
          const spStatus = attErr.response?.status;
          // Only propagate auth errors to Pyrus — other errors (e.g. 422 unsupported type)
          // are logged and skipped so Pyrus does not disconnect the extension.
          if (spStatus === 401 || spStatus === 403) {
            const { code, body } = spErrorToPayrus(attErr);
            console.error(`[pyrus/sendmessage] attachment ${fileId} auth error:`, body);
            return res.status(code).json(body);
          }
          console.error(`[pyrus/sendmessage] attachment ${fileId} skipped (${spStatus}):`, attErr.response?.data ?? attErr.message);
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[pyrus/sendmessage]', err.message);
    res.status(500).json({ error_code: 'internal_error', error: err.message });
  }
});

module.exports = router;
