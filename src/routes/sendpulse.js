'use strict';

const express = require('express');
const db = require('../db');
const pyrusApi = require('../services/pyrusApi');
const sentCache = require('../sentCache');

const router = express.Router();

/**
 * Extract text and links from a SendPulse incoming message.
 * Returns a string ready to be sent as a Pyrus comment.
 */
function extractMessageText(channelData) {
  const msg = channelData.message || {};
  const media = channelData.media || null;
  const attachments = msg.attachments || [];
  const referral = msg.referral || null;

  // Ad referral
  if (referral && referral.source === 'ADS') {
    const adTitle = referral.ads_context_data?.ad_title || '';
    const videoUrl = referral.ads_context_data?.video_url || '';
    const text = msg.text || '';
    return [`[Реклама: ${adTitle}]`, videoUrl, text].filter(Boolean).join('\n');
  }

  // Comment on a post
  if (media && media.permalink) {
    const text = msg.text || '';
    return [`[Комментарий к посту: ${media.permalink}]`, text].filter(Boolean).join('\n');
  }

  // Reel or media attachment
  if (attachments.length > 0) {
    const att = attachments[0];
    if (att.type === 'ig_reel' && att.payload) {
      const title = (att.payload.title || '').slice(0, 300);
      const url = att.payload.url || '';
      return [`[Reel]`, title, url].filter(Boolean).join('\n');
    }
    // Generic attachment with URL
    const url = att.payload?.url || '';
    return [`[Медиа]`, url].filter(Boolean).join('\n');
  }

  // Plain text
  return msg.text || '';
}

/**
 * Format a reply message: quote the original, then the reply text.
 */
function formatReply(originalText, replyText) {
  return `${originalText}\n\n${replyText}`;
}

/**
 * Extract text from an outgoing bot/operator message.
 */
function extractOutgoingText(channelData) {
  const wrapper = channelData.message || {};
  const inner = wrapper.message || {};
  const type = wrapper.type || 'text';

  if (type === 'text') {
    return inner.text || '';
  }

  if (type === 'text_template') {
    const elements = inner.attachment?.payload?.elements || [];
    return elements.map(el => el.title || '').filter(Boolean).join('\n');
  }

  return '';
}

// POST /sendpulse/webhook
router.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so SendPulse doesn't retry
  res.json({ status: 'ok' });

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      if (event.title === 'outgoing_message') {
        await handleOutgoing(event);
        continue;
      }
      if (event.title !== 'incoming_message') continue;

      const contact = event.contact || {};
      const bot = event.bot || {};
      const channelData = event.info?.message?.channel_data || {};
      const msg = channelData.message || {};
      const mid = channelData.message_id || msg.mid || msg.message_id || null;
      const channel = (bot.channel || event.service || '').toUpperCase();

      // We need an account to find where to create tasks.
      // Since SendPulse webhooks are not per-account, find account by bot_id.
      const account = await findAccountByBotId(bot.id);
      if (!account) {
        console.warn(`[sp/webhook] No account found for bot_id=${bot.id}`);
        continue;
      }

      // Extract message text
      let messageText = extractMessageText(channelData);

      // Handle reply_to: prepend quoted original message
      if (msg.reply_to && msg.reply_to.mid) {
        const original = await db.getMessage(msg.reply_to.mid);
        if (original) {
          messageText = formatReply(original.text, messageText);
        }
      }

      if (!messageText) continue;

      // Save current message to messages table
      if (mid) {
        await db.saveMessage(mid, messageText);
      }

      // Find or create conversation record
      let conversation = await db.getConversation(account.account_id, contact.id);
      const isFirstMessage = !conversation || !conversation.pyrus_task_id;
      if (!conversation) {
        conversation = await db.createConversation({
          accountId: account.account_id,
          sendpulseContactId: contact.id,
          sendpulseBotId: bot.id,
          channel,
        });
      }

      // Detect message type
      const isPostComment = !!(channelData.media && channelData.media.permalink);

      // Build mappings only for first message (task creation)
      const mappings = isFirstMessage ? [
        { code: 'SenderName', value: (contact.name || '').slice(0, 300) },
        { code: 'Subject', value: messageText.slice(0, 300) },
        { code: 'accauntName', value: (contact.username || '').slice(0, 300) },
        { code: 'SenderAccountUrl', value: contact.username ? `https://instagram.com/${contact.username}` : '' },
        { code: 'MessageType', value: isPostComment ? 'Comment' : 'Direct' },
        //{ code: 'CallStatus', value: { choice_id: isPostComment ? 2 : 1 } },
        { code: 'PostUrl', value: isPostComment ? (channelData.media.permalink || '') : '' },
      ].filter(m => m.value) : undefined;

      // Send to Pyrus via Extensions API — same channel_id creates task on first call, adds comment on subsequent
      const msgRes = await pyrusApi.sendIncomingMessage({
        accountId: account.sp_bot_id,
        channelId: contact.id,
        senderName: contact.username || contact.name || 'Неизвестный',
        messageText,
        messageId: mid || undefined,
        messageType: isPostComment ? 'post_comment' : 'direct',
        mappings,
      });

      const taskId = msgRes?.task_id;
      if (taskId && !conversation.pyrus_task_id) {
        await db.updateConversationTaskId(conversation.id, taskId);
      }
    }
  } catch (err) {
    console.error('[sp/webhook]', err.message);
  }
});

async function handleOutgoing(event) {
  const contact = event.contact || {};
  const bot = event.bot || {};
  const channelData = event.info?.message?.channel_data || {};
  const mid = channelData.message_id || null;
  const sentBy = event.info?.message?.sent_by || null;

  // Skip echo: messages we sent via /sendmessage are marked in sentCache
  if (!sentBy && sentCache.has(contact.id)) return;

  const messageText = extractOutgoingText(channelData);
  if (!messageText) return;

  const account = await findAccountByBotId(bot.id);
  if (!account) { console.warn('[sp/outgoing] no account for bot_id:', bot.id); return; }

  const conversation = await db.getConversation(account.account_id, contact.id);
  if (!conversation) {
    console.warn('[sp/outgoing] no conversation for contact:', contact.id);
    return;
  }

  const senderName = sentBy
    ? `${sentBy.firstname || ''} ${sentBy.lastname || ''}`.trim() || sentBy.email || 'Оператор'
    : 'Бот';

  await pyrusApi.sendIncomingMessage({
    accountId: account.sp_bot_id,
    channelId: contact.id,
    senderName,
    messageText: `[→ ${senderName}]: ${messageText}`,
    messageId: mid || undefined,
  });
}

async function findAccountByBotId(botId) {
  return db.getAccountByBotId(botId);
}



module.exports = router;
