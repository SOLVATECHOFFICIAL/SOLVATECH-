import {
  generateWAMessageContent,
  downloadContentFromMessage,
  downloadMediaMessage,
  proto,
} from "@whiskeysockets/baileys";
import { isGroup, getMessageContent, unwrapMediaMessage, streamToBuffer } from "../lib/helpers.js";
import { downloadViewOnceRobust } from "../lib/media.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";
import { generateRichLinkPreview } from "../lib/link-preview.js";
import { logger } from "../lib/logger.js";

/**
 * Robustly extract and decrypt media buffer from candidate message structures.
 */
async function retrieveMediaBuffer(sock, candidates = [], mediaType = "image") {
  const streamType = mediaType === "audio" ? "audio" : mediaType === "video" ? "video" : "image";

  for (const candidate of candidates) {
    if (!candidate) continue;
    const content = unwrapMediaMessage(candidate);
    const media =
      content?.imageMessage ||
      content?.videoMessage ||
      content?.audioMessage ||
      content?.documentMessage ||
      content?.ptvMessage ||
      content?.stickerMessage;

    if (media && media.mediaKey) {
      try {
        const stream = await downloadContentFromMessage(media, streamType);
        const buf = await streamToBuffer(stream);
        if (buf && buf.length > 0) {
          return { buffer: buf, media };
        }
      } catch (err) {
        logger.debug(`[GROUP_STATUS] Direct stream decryption note for ${mediaType}:`, err.message);
      }
    }
  }

  // Fallback 1: downloadViewOnceRobust
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const target = candidate.message ? candidate : { message: candidate };
      const buf = await downloadViewOnceRobust(sock, target, null);
      if (buf && buf.length > 0) {
        const content = unwrapMediaMessage(candidate);
        const media =
          content?.imageMessage ||
          content?.videoMessage ||
          content?.audioMessage ||
          content?.documentMessage;
        return { buffer: buf, media };
      }
    } catch {}
  }

  // Fallback 2: Baileys downloadMediaMessage
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const target = candidate.message ? candidate : { message: candidate };
      const ctx = sock
        ? {
            logger: sock.logger,
            reuploadRequest: sock.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : undefined,
          }
        : undefined;
      const buf = await downloadMediaMessage(target, "buffer", {}, ctx);
      if (buf && buf.length > 0) {
        const content = unwrapMediaMessage(candidate);
        const media =
          content?.imageMessage ||
          content?.videoMessage ||
          content?.audioMessage ||
          content?.documentMessage;
        return { buffer: buf, media };
      }
    } catch {}
  }

  return null;
}

/**
 * .status command:
 * Reply to any photo, video, audio/music, link, or text in a group with `.status [optional caption]`.
 * Posts the content directly as that group's Group Status update (group story).
 *
 * Requirements:
 * - Only works in groups.
 * - Only the linked owner can trigger it.
 * - NEVER posts to personal status (never uses status@broadcast).
 * - Full Link Previews: When replying to a link (web link or WhatsApp group invite link),
 *   it relaxes and thoroughly resolves rich preview cards (title, description, and high-quality thumbnail)
 *   so the status story displays the complete card with picture.
 * - Strict verification: If link preview or picture cannot be loaded, it ABORTS and does not upload to status!
 * - Silent & stealth: no confirmation messages, no pinning, no text announcements.
 * - Instantly deletes the owner's `.status` message after posting so no one notices.
 */
export default async function status({
  sock,
  message,
  chatId,
  senderIsLinkedAccount,
  args = [],
  userId = "default",
}) {
  // 1. Group-only & Owner-only restriction
  if (!isGroup(chatId) || !senderIsLinkedAccount) {
    return;
  }

  // 2. Extract replied message
  const msgKey = message?.key || {};
  const content = getMessageContent(message);
  const contextInfo = Object.values(content).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  if (!quotedMsg) {
    return;
  }

  try {
    const unwrapQuoted = unwrapMediaMessage(quotedMsg);
    const cachedEntry = quotedStanzaId ? getCachedIncomingMessage(userId, quotedStanzaId) : null;
    const customCaption = args.join(" ").trim();

    // Candidates in order of rich media data availability
    const candidates = [
      cachedEntry?.rawMessage,
      cachedEntry?.content,
      quotedMsg,
    ].filter(Boolean);

    let mediaPayload = null;

    // ----------------------------------------------------
    // CASE 1: IMAGE
    // ----------------------------------------------------
    const hasImage = Boolean(
      unwrapQuoted.imageMessage ||
      unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
      cachedEntry?.mediaType === "image" ||
      cachedEntry?.content?.imageMessage
    );

    if (hasImage) {
      const res = await retrieveMediaBuffer(sock, candidates, "image");
      if (res && res.buffer) {
        const origCaption =
          res.media?.caption ||
          unwrapQuoted.imageMessage?.caption ||
          unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
          "";
        const finalCaption = customCaption || origCaption;

        mediaPayload = {
          image: res.buffer,
          caption: finalCaption || undefined,
        };
      }
    }

    // ----------------------------------------------------
    // CASE 2: VIDEO
    // ----------------------------------------------------
    const hasVideo = !mediaPayload && Boolean(
      unwrapQuoted.videoMessage ||
      unwrapQuoted.ptvMessage ||
      unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
      cachedEntry?.mediaType === "video" ||
      cachedEntry?.content?.videoMessage
    );

    if (hasVideo) {
      const res = await retrieveMediaBuffer(sock, candidates, "video");
      if (res && res.buffer) {
        const origCaption =
          res.media?.caption ||
          unwrapQuoted.videoMessage?.caption ||
          unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
          "";
        const finalCaption = customCaption || origCaption;
        const mimetype = res.media?.mimetype || unwrapQuoted.videoMessage?.mimetype || "video/mp4";

        mediaPayload = {
          video: res.buffer,
          caption: finalCaption || undefined,
          mimetype,
        };
      }
    }

    // ----------------------------------------------------
    // CASE 3: AUDIO / MUSIC
    // ----------------------------------------------------
    const hasAudio = !mediaPayload && Boolean(
      unwrapQuoted.audioMessage ||
      unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
      cachedEntry?.mediaType === "audio" ||
      cachedEntry?.content?.audioMessage
    );

    if (hasAudio) {
      const res = await retrieveMediaBuffer(sock, candidates, "audio");
      if (res && res.buffer) {
        const mimetype = res.media?.mimetype || unwrapQuoted.audioMessage?.mimetype || "audio/mp4";
        const ptt = Boolean(res.media?.ptt || unwrapQuoted.audioMessage?.ptt);

        mediaPayload = {
          audio: res.buffer,
          mimetype,
          ptt,
        };
      }
    }

    // ----------------------------------------------------
    // CASE 4: DOCUMENT / FILE
    // ----------------------------------------------------
    const hasDocument = !mediaPayload && Boolean(
      unwrapQuoted.documentMessage ||
      unwrapQuoted.viewOnceMessage?.message?.documentMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.documentMessage ||
      cachedEntry?.mediaType === "document" ||
      cachedEntry?.content?.documentMessage
    );

    if (hasDocument) {
      const res = await retrieveMediaBuffer(sock, candidates, "document");
      if (res && res.buffer) {
        const origCaption = res.media?.caption || unwrapQuoted.documentMessage?.caption || "";
        const finalCaption = customCaption || origCaption;
        const mimetype = res.media?.mimetype || unwrapQuoted.documentMessage?.mimetype || "application/octet-stream";
        const fileName = res.media?.fileName || unwrapQuoted.documentMessage?.fileName || "attachment";

        mediaPayload = {
          document: res.buffer,
          caption: finalCaption || undefined,
          mimetype,
          fileName,
        };
      }
    }

    // Strict validation: if the replied message was media (image, video, audio, doc) but failed to download, abort!
    const isOriginalMedia = hasImage || hasVideo || hasAudio || hasDocument;
    if (isOriginalMedia && !mediaPayload) {
      logger.warn("[GROUP_STATUS] Media download failed — aborting status upload as required.");
      return;
    }

    // ----------------------------------------------------
    // CASE 5: LINK OR TEXT STATUS
    // ----------------------------------------------------
    if (!mediaPayload) {
      const origText = (
        unwrapQuoted.conversation ||
        unwrapQuoted.extendedTextMessage?.text ||
        unwrapQuoted.groupInviteMessage?.caption ||
        cachedEntry?.text ||
        ""
      ).trim();

      const urlInOrig = (origText || "").match(/(?:https?:\/\/|www\.)[^\s]+/i)?.[0];
      let textToPost = origText;

      if (!urlInOrig && unwrapQuoted.groupInviteMessage?.inviteCode) {
        const inviteUrl = `https://chat.whatsapp.com/${unwrapQuoted.groupInviteMessage.inviteCode}`;
        textToPost = customCaption ? `${customCaption}\n\n${inviteUrl}` : inviteUrl;
      } else if (customCaption) {
        if (urlInOrig && !customCaption.includes(urlInOrig)) {
          textToPost = `${customCaption}\n\n${urlInOrig}`;
        } else {
          textToPost = customCaption;
        }
      }

      if (!textToPost) {
        return;
      }

      // Check if text contains a URL (web link or WhatsApp group invite)
      const hasUrl = Boolean(
        /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/)[^\s]+/i.test(textToPost) ||
        urlInOrig ||
        unwrapQuoted.groupInviteMessage
      );

      if (hasUrl) {
        // STRICT REQUIREMENT: Link must have rich preview with title & picture thumbnail, or do not post!
        const richPreview = await generateRichLinkPreview(
          textToPost,
          unwrapQuoted.extendedTextMessage || cachedEntry?.content?.extendedTextMessage,
          sock
        );

        if (!richPreview || !richPreview.title || !richPreview.jpegThumbnail || richPreview.jpegThumbnail.length === 0) {
          logger.warn("[GROUP_STATUS] Link preview validation failed (missing title or picture) — aborting status upload as requested.");
          return;
        }

        const innerMsg = proto.Message.fromObject({
          extendedTextMessage: richPreview,
        });

        const statusV2Message = proto.Message.fromObject({
          groupStatusMessageV2: {
            message: innerMsg,
          },
        });

        const statusV1Message = proto.Message.fromObject({
          groupStatusMessage: {
            message: innerMsg,
          },
        });

        logger.info("[GROUP_STATUS] Relaying group status with verified link preview and picture", {
          chatId,
          title: richPreview.title,
          hasThumb: Boolean(richPreview.jpegThumbnail),
          thumbBytes: richPreview.jpegThumbnail.length,
        });

        try {
          await sock.relayMessage(chatId, statusV2Message, {});
        } catch {
          await sock.relayMessage(chatId, statusV1Message, {});
        }

        // Stealth cleanup: immediately delete the owner's .status message
        await sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});
        return;
      }

      mediaPayload = {
        text: textToPost,
      };
    }

    if (!mediaPayload) {
      return;
    }

    // 3. Generate inner message structure with media uploaded to WhatsApp servers
    const innerMsg = await generateWAMessageContent(mediaPayload, {
      upload: sock.waUploadToServer,
    });

    // 4. Construct Group Status message wrappers (V2 and standard V1)
    const statusV2Message = proto.Message.fromObject({
      groupStatusMessageV2: {
        message: innerMsg,
      },
    });

    const statusV1Message = proto.Message.fromObject({
      groupStatusMessage: {
        message: innerMsg,
      },
    });

    logger.info("[GROUP_STATUS] Relaying group status directly to group", {
      chatId,
      mediaType: mediaPayload.image ? "image" : mediaPayload.video ? "video" : mediaPayload.audio ? "audio" : "text",
    });

    // 5. Send strictly to chatId (the group) — NEVER to personal status@broadcast
    try {
      await sock.relayMessage(chatId, statusV2Message, {});
    } catch {
      await sock.relayMessage(chatId, statusV1Message, {});
    }

    // 6. Stealth cleanup: immediately delete the owner's .status message so no one notices
    await sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});

  } catch (err) {
    logger.error("[GROUP_STATUS] Execution error", err.message);
  }
}
