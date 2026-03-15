'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const axios = require('axios');
const express = require('express');
const db = require('../db');
const pyrusApi = require('../services/pyrusApi');
const sentCache = require('../sentCache');

const sendpulseApi = require('../services/sendpulseApi');

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

  // Comment on a post — returns object with html and postMedia
  if (media && media.permalink) {
    const permalink = media.permalink;
    const caption = media.caption || '';
    const commentText = msg.text || '';
    const mediaUrl = media.media_url || null;
    const mediaType = (media.media_type || 'IMAGE').toUpperCase() === 'VIDEO' ? 'video' : 'image';

    const text = [`Комментарий к посту: ${permalink}`, caption, commentText].filter(Boolean).join('\n\n');
    const htmlParts = [`<b>Комментарий к посту: ${permalink}</b>`];
    if (caption) htmlParts.push(`<q>${caption}</q>`);
    if (commentText) htmlParts.push(`<b>${commentText}</b>`);
    const html = htmlParts.join('<br>');

    return {
      text,
      html,
      postMedia: mediaUrl ? { type: mediaType, payload: { url: mediaUrl } } : null,
    };
  }


  // Reel or media attachments — files uploaded separately, URLs omitted here
  if (attachments.length > 0) {
    const labels = attachments
      .filter(att => att.type === 'ig_reel' && att.payload?.title)
      .map(att => `[Reel] ${att.payload.title.slice(0, 300)}`);
    return [msg.text, ...labels].filter(Boolean).join('\n') || '[Медиа]';
  }

  // Plain text
  return msg.text || '';
}

/**
 * Format a reply message: quote the original, then the reply text.
 */
function formatReply(originalText, replyText) {
  const quoted = originalText.split('\n').map(l => `> ${l}`).join('\n');
  return replyText ? `${quoted}\n\n${replyText}` : quoted;
}

/**
 * Extract text and raw attachments from a SendPulse chat history item.
 * Returns { text, attachments } where attachments is in webhook format [{ type, payload: { url } }].
 */
function extractChatItemContent(item) {
  const type = item.type;
  const data = item.data || {};

  if (type === 'text') {
    // Outgoing: data.message.text; Incoming in history: data.text
    return { text: data.message?.text || data.text || '', attachments: [] };
  }

  // 'attachments' — incoming message with only attachments (no text)
  // 'reply_to_message' — reply with optional text and attachments
  // Both have: data.text + data.attachments[]
  if (type === 'attachments' || type === 'reply_to_message') {
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    return { text: data.text || '', attachments };
  }

  if (type === 'image' || type === 'video') {
    const url = data.message?.attachment?.payload?.url || '';
    const atts = url ? [{ type, payload: { url } }] : [];
    return { text: '', attachments: atts };
  }

  if (type === 'ig_reel') {
    const title = data.message?.attachment?.payload?.title || '';
    const url = data.message?.attachment?.payload?.url || '';
    const atts = url ? [{ type, payload: { url } }] : [];
    return { text: title ? `[Reel] ${title}` : '[Reel]', attachments: atts };
  }

  return { text: `[${type}]`, attachments: [] };
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

const { serviceUrl } = require('../config');
const tempStore = require('../tempStore');
const contactQueue = require('../contactQueue');

/**
 * Resolve an attachment URL to { buffer, contentType, fileName }.
 * If the URL points to our own /temp endpoint, re-downloads from Pyrus using stored file_ref.
 */
async function resolveAttachmentBuffer(att) {
  const url = att.payload?.url || '';
  const tempPrefix = `${serviceUrl}/temp/`;

  if (url.startsWith(tempPrefix)) {
    const uuid = url.slice(tempPrefix.length);
    // Try in-memory store first
    const stored = tempStore.get ? tempStore.get(uuid) : null;
    if (stored) return stored;
    // Look up DB and re-download from Pyrus
    const ref = await db.getFileRef(uuid);
    if (ref) {
      console.log(`[sp/attachments] re-downloading pyrus file ${ref.pyrus_file_id} for uuid ${uuid}`);
      return await pyrusApi.downloadFile(ref.pyrus_file_id);
    }
    throw new Error(`temp file ${uuid} expired and no file_ref found`);
  }

  // Regular external URL
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
  const contentType = res.headers['content-type'] || 'application/octet-stream';
  const ext = contentType.includes('video') ? 'mp4'
    : contentType.includes('png') ? 'png'
      : contentType.includes('gif') ? 'gif'
        : 'jpg';
  return { buffer: Buffer.from(res.data), contentType, fileName: `${att.type || 'file'}.${ext}` };
}

/**
 * Download attachments, upload to Pyrus, return guids.
/**
 * Convert an audio file to OGA (Ogg Vorbis) using ffmpeg.
 * Returns the path to the converted file.
 */
async function convertToOga(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '.oga');
  await execFileAsync('ffmpeg', ['-i', inputPath, '-c:a', 'libvorbis', '-q:a', '4', '-y', outputPath]);
  return outputPath;
}

/**
 * Temp files are deleted after upload regardless of outcome.
 */
async function downloadAndUploadAttachments(attachments) {
  const guids = [];
  const tempFiles = [];

  for (const att of attachments) {
    if (!att.payload?.url) continue;
    let filePath;
    try {
      const { buffer, contentType, fileName } = await resolveAttachmentBuffer(att);
      const ext = fileName.split('.').pop() || 'bin';
      const tmpName = `${att.type}_${Date.now()}_${guids.length}.${ext}`;
      filePath = path.join(os.tmpdir(), tmpName);
      fs.writeFileSync(filePath, buffer);
      tempFiles.push(filePath);

      let uploadPath = filePath;
      let uploadName = fileName || tmpName;
      if (att.type === 'audio') {
        const ogaPath = await convertToOga(filePath);
        tempFiles.push(ogaPath);
        uploadPath = ogaPath;
        uploadName = uploadName.replace(/\.[^.]+$/, '.oga');
        console.log(`[sp/attachments] converted audio → ${ogaPath}`);
      }

      const guid = await pyrusApi.uploadFile(uploadPath, uploadName);
      guids.push(guid);
      console.log(`[sp/attachments] uploaded ${att.type} → guid ${guid}`);
    } catch (err) {
      console.error('[sp/attachments] error:', err.message);
    }
  }

  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { }
  }

  return guids;
}

async function handleIncoming(event) {
  const contact = event.contact || {};
  const bot = event.bot || {};
  const channelData = event.info?.message?.channel_data || {};
  const msg = channelData.message || {};
  const mid = channelData.message_id || msg.mid || msg.message_id || null;
  const channel = (bot.channel || event.service || '').toUpperCase();

  const account = await findAccountByBotId(bot.id);
  if (!account) {
    console.warn(`[sp/incoming] No account found for bot_id=${bot.id}`);
    return;
  }
  if (account.deleted || account.enabled === false) {
    console.log(`[sp/incoming] account=${account.account_id} is disabled/deleted, skipping`);
    return;
  }

  // Extract message text (may include post comment HTML and post media)
  const extracted = extractMessageText(channelData);
  let messageText = typeof extracted === 'object' ? extracted.text : extracted;
  let messageHtml = typeof extracted === 'object' ? (extracted.html || null) : null;
  const postMedia = typeof extracted === 'object' ? (extracted.postMedia || null) : null;

  // Upload attachments to Pyrus and collect guids
  // Post media (if any) goes first so it appears before the comment text
  const rawAttachments = [
    ...(postMedia ? [postMedia] : []),
    ...(msg.attachments || []),
  ];
  const attachmentGuids = rawAttachments.length > 0
    ? await downloadAndUploadAttachments(rawAttachments)
    : [];

  if (msg.reply_to) {
    try {
      if (msg.reply_to.mid) {
        // Reply to a regular message — look up in chat history
        const history = await sendpulseApi.getChatMessages({
          spClientId: account.sp_client_id,
          spClientSecret: account.sp_client_secret,
          contactId: contact.id,
          size: 50,
        });
        const original = history.find(m => m.data?.message_id === msg.reply_to.mid);
        console.log('[sp/reply_to] looking for mid:', msg.reply_to.mid, '→', original ? `found type=${original.type}` : 'not found');
        if (original) {
          const { text: origText, attachments: origAtts } = extractChatItemContent(original);
          if (origAtts.length > 0) {
            const origGuids = await downloadAndUploadAttachments(origAtts);
            attachmentGuids.unshift(...origGuids);
          }
          const quoted = origText || '[Медиа]';
          messageText = formatReply(quoted, messageText);
          messageHtml = `<q>${quoted}</q><br>${messageText.split('\n\n').slice(1).join('\n\n') || messageText}`;
        }
      } else if (msg.reply_to.story) {
        // Reply to a story — download story media and attach
        const storyUrl = msg.reply_to.story.url;
        if (storyUrl) {
          try {
            const storyGuids = await downloadAndUploadAttachments([{ type: 'image', payload: { url: storyUrl } }]);
            attachmentGuids.unshift(...storyGuids);
          } catch (storyErr) {
            console.warn('[sp/incoming] story download failed:', storyErr.message);
          }
        }
        messageText = formatReply('[История]', messageText);
        messageHtml = `<q>[История]</q><br>${messageText.split('\n\n').slice(1).join('\n\n') || messageText}`;
      }
    } catch (replyErr) {
      console.warn('[sp/incoming] reply_to lookup failed:', replyErr.message);
    }
  }

  if (!messageText && !attachmentGuids.length) return;

  // Find or create conversation record
  let conversation = await db.getConversation(account.account_id, contact.id);
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

  // Send to Pyrus — no mappings yet, check response first
  const msgRes = await pyrusApi.sendIncomingMessage({
    accountId: account.sp_bot_id,
    channelId: contact.id,
    senderName: contact.username || contact.name || 'Неизвестный',
    messageText: messageText || ' ',
    messageTextHtml: messageHtml || undefined,
    messageId: mid || undefined,
    messageType: isPostComment ? 'post_comment' : 'direct',
    attachments: attachmentGuids.length ? attachmentGuids : undefined,
  });

  const taskId = msgRes?.tasks?.[0]?.task_id;
  if (taskId && taskId !== conversation.pyrus_task_id) {
    // New task created (or recreated after deletion) — update stored id and fill form fields
    await db.updateConversationTaskId(conversation.id, taskId);
    const mappings = [
      { code: 'SenderName', value: (contact.name || '').slice(0, 300) },
      { code: 'Subject', value: messageText.slice(0, 300) },
      { code: 'accauntName', value: (contact.username || '').slice(0, 300) },
      { code: 'SenderAccountUrl', value: contact.username ? `https://instagram.com/${contact.username}` : '' },
      { code: 'MessageType', value: isPostComment ? 'Comment' : 'Direct' },
      { code: 'PostUrl', value: isPostComment ? (channelData.media.permalink || '') : '' },
    ].filter(m => m.value);
    await pyrusApi.sendIncomingMessage({
      accountId: account.sp_bot_id,
      channelId: contact.id,
      senderName: contact.username || contact.name || 'Неизвестный',
      messageText: ' ',
      messageType: isPostComment ? 'post_comment' : 'direct',
      mappings,
    });
  }
}

// POST /sendpulse/webhook
router.post('/webhook', (req, res) => {
  // Always respond 200 immediately so SendPulse doesn't retry
  res.json({ status: 'ok' });

  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) {
    console.log('[sp/webhook] event:', JSON.stringify(event));
    const contactId = event.contact?.id;
    if (!contactId) continue;

    if (event.title === 'incoming_message') {
      contactQueue.enqueue(contactId, () => handleIncoming(event));
    } else if (event.title === 'outgoing_message') {
      contactQueue.enqueue(contactId, () => handleOutgoing(event));
    }
  }
});

async function handleOutgoing(event) {
  const contact = event.contact || {};
  const bot = event.bot || {};
  const channelData = event.info?.message?.channel_data || {};
  const mid = channelData.message_id || null;
  const sentBy = event.info?.message?.sent_by || null;

  const isEcho = !sentBy && sentCache.has(contact.id);
  if (isEcho) console.log('[sp/outgoing] echo for', contact.id);

  const messageText = extractOutgoingText(channelData);
  console.log('[sp/outgoing] sentBy:', !!sentBy, 'echo:', isEcho, 'text:', messageText?.slice(0, 50));
  if (!messageText) return;

  const account = await findAccountByBotId(bot.id);
  if (!account) { console.warn('[sp/outgoing] no account for bot_id:', bot.id); return; }
  if (account.deleted || account.enabled === false) {
    console.log(`[sp/outgoing] account=${account.account_id} is disabled/deleted, skipping`);
    return;
  }

  const conversation = await db.getConversation(account.account_id, contact.id);
  if (!conversation) {
    console.warn('[sp/outgoing] no conversation for contact:', contact.id);
    return;
  }

  // TODO: save message
  // if (mid) {
  //   const outAttachments = channelData.message?.attachments?.length > 0 ? channelData.message.attachments : null;
  //   await db.saveMessage(mid, messageText, 'outgoing', conversation.id, event, outAttachments);
  // }

  // Don't forward echo back to Pyrus
  if (isEcho) return;

  const authorLabel = sentBy
    ? `${sentBy.firstname || ''} ${sentBy.lastname || ''}`.trim() || sentBy.email || 'Оператор SP'
    : 'Бот';

  await pyrusApi.sendIncomingMessage({
    accountId: account.sp_bot_id,
    channelId: contact.id,
    senderName: authorLabel || contact.username || contact.name || 'Неизвестный',
    messageText: `[→ ${authorLabel}]: ${messageText}`,
    messageId: mid || undefined,
  });
}

async function findAccountByBotId(botId) {
  return db.getAccountByBotId(botId);
}



module.exports = router;
