'use strict';

const express = require('express');
const db = require('../db');
const pyrusApi = require('../services/pyrusApi');

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

// POST /sendpulse/webhook
router.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so SendPulse doesn't retry
  res.json({ status: 'ok' });

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
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

      // Find or create conversation
      let conversation = await db.getConversation(account.account_id, contact.id);

      if (!conversation) {
        // New contact — create Pyrus task
        conversation = await db.createConversation({
          accountId: account.account_id,
          sendpulseContactId: contact.id,
          sendpulseBotId: bot.id,
          channel,
        });

        const subject = buildTaskSubject(contact, channel);
        const fields = buildTaskFields(contact, channel);

        const taskRes = await pyrusApi.createTask({
          formId: account.pyrus_form_id,
          subject,
          fields,
        });

        const taskId = taskRes?.task?.id || taskRes?.id;
        if (taskId) {
          await db.updateConversationTaskId(conversation.id, taskId);
          conversation.pyrus_task_id = taskId;
        }

        // First message as a comment
        if (conversation.pyrus_task_id) {
          const commentRes = await pyrusApi.addComment({
            taskId: conversation.pyrus_task_id,
            text: messageText,
          });
          const commentId = commentRes?.comment?.id || commentRes?.id;
          if (mid && commentId) {
            await db.updateMessageCommentId(mid, commentId);
          }
        }
      } else {
        // Existing conversation — add comment
        if (conversation.pyrus_task_id) {
          const commentRes = await pyrusApi.addComment({
            taskId: conversation.pyrus_task_id,
            text: messageText,
          });
          const commentId = commentRes?.comment?.id || commentRes?.id;
          if (mid && commentId) {
            await db.updateMessageCommentId(mid, commentId);
          }
        }
      }
    }
  } catch (err) {
    console.error('[sp/webhook]', err.message);
  }
});

async function findAccountByBotId(botId) {
  return db.getAccountByBotId(botId);
}

function buildTaskSubject(contact, channel) {
  const name = contact.name || contact.username || 'Неизвестный';
  const handle = contact.username ? ` (@${contact.username})` : '';
  const ch = channel === 'INSTAGRAM' ? 'Instagram' : channel === 'TELEGRAM' ? 'Telegram' : channel;
  return `[${ch}] ${name}${handle}`;
}

function buildTaskFields(contact, channel) {
  const fields = [];

  if (contact.name) {
    fields.push({ code: 'LeadName', value: contact.name });
  }

  if (contact.username) {
    fields.push({ code: 'Username', value: `@${contact.username}` });
  }

  if (channel) {
    fields.push({ code: 'Channel', value: channel });
  }

  const phone = contact.variables?.Phone;
  if (phone) {
    fields.push({ code: 'PhoneNumber', value: String(phone) });
  }

  return fields;
}

module.exports = router;
