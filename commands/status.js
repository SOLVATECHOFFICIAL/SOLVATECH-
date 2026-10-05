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

const ANY_LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|whatsapp\.com\/channel\/|wa\.me\/)[^\s]+/i;

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
 * Post photos, videos, audio, group links, channel links, or web links to WhatsApp Group Status (story).
 *
 * SPECIFICATION:
 * - Ultra-deliberate processing strictly for .status (5 to 15 seconds, max 30 seconds)
 *   to ensure WhatsApp servers and CDN fully cache the group/channel thumbnail picture
 *   before relaying the status story.
 * - Only works in groups.
 * - Only the linked owner can trigger it.
 * - Supports replying to a message or typing `.status <link or caption>` directly.
 * - Full Link Previews: When posting group invite links, WhatsApp channel links, or any web URLs,
 *   resolves rich preview cards (title, description, and high-quality picture thumbnail).
 */
export default async function status({
  sock,
  message,
  chatId,
  senderIsLinkedAccount,
  args = [],
  userId = "default",
}) {
  const statusStartTime = Date.now();

  // 1. Group-only & Owner-only restriction
  if (!isGroup(chatId) || !senderIsLinkedAccount) {
    return;
  }

  const msgKey = message?.key || {};
  const content = getMessageContent(message);
  const contextInfo = Object.values(content).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;
  const customCaption = args.join(" ").trim();

  // If no quoted message and no direct text/link provided, nothing to post
  if (!quotedMsg && !customCaption) {
    return;
  }

  // React with ⏳ to indicate careful preview generation
  if (msgKey?.id) {
    sock.sendMessage(chatId, { react: { text: "⏳", key: msgKey } }).catch(() => {});
  }

  try {
    const unwrapQuoted = quotedMsg ? unwrapMediaMessage(quotedMsg) : {};
    const cachedEntry = quotedStanzaId ? getCachedIncomingMessage(userId, quotedStanzaId) : null;

    let mediaPayload = null;

    if (quotedMsg) {
      const candidates = [
        cachedEntry?.rawMessage,
        cachedEntry?.content,
        quotedMsg,
      ].filter(Boolean);

      // CASE 1: IMAGE
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

      // CASE 2: VIDEO
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

      // CASE 3: AUDIO / MUSIC
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

      // CASE 4: DOCUMENT / FILE
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

      const isOriginalMedia = hasImage || hasVideo || hasAudio || hasDocument;
      if (isOriginalMedia && !mediaPayload) {
        logger.warn("[GROUP_STATUS] Media download failed — aborting status upload.");
        return;
      }
    }

    // CASE 5: LINK OR TEXT STATUS (Group Invite, Channel, or Web Link)
    if (!mediaPayload) {
      let textToPost = "";

      if (quotedMsg) {
        const origText = (
          unwrapQuoted.conversation ||
          unwrapQuoted.extendedTextMessage?.text ||
          unwrapQuoted.groupInviteMessage?.caption ||
          cachedEntry?.text ||
          ""
        ).trim();

        const urlInOrig = (origText || "").match(ANY_LINK_REGEX)?.[0];

        if (!urlInOrig && unwrapQuoted.groupInviteMessage?.inviteCode) {
          const inviteUrl = `https://chat.whatsapp.com/${unwrapQuoted.groupInviteMessage.inviteCode}`;
          textToPost = customCaption ? `${customCaption}\n\n${inviteUrl}` : inviteUrl;
        } else if (customCaption) {
          if (urlInOrig && !customCaption.includes(urlInOrig)) {
            textToPost = `${customCaption}\n\n${urlInOrig}`;
          } else {
            textToPost = customCaption;
          }
        } else {
          textToPost = origText;
        }
      } else {
        textToPost = customCaption;
      }

      if (!textToPost) {
        return;
      }

      const hasUrl = Boolean(
        ANY_LINK_REGEX.test(textToPost) ||
        unwrapQuoted.groupInviteMessage
      );

      if (hasUrl) {
        logger.info("[GROUP_STATUS] Resolving high-fidelity link preview for group/channel/web link...");
        const richPreview = await generateRichLinkPreview(
          textToPost,
          unwrapQuoted.extendedTextMessage || cachedEntry?.content?.extendedTextMessage,
          sock
        );

        if (!richPreview || !richPreview.title || !richPreview.jpegThumbnail || richPreview.jpegThumbnail.length === 0) {
          logger.warn("[GROUP_STATUS] Link preview validation failed — aborting status upload.");
          return;
        }

        // MANDATORY REQUIREMENT: Slower deliberate processing (5 to 15 seconds, max 30s)
        // Give WhatsApp CDN and client caches 8-12 seconds to fully register the group/channel picture
        const elapsedSoFar = Date.now() - statusStartTime;
        const TARGET_DELAY_MS = 9000; // 9 seconds: right in the 5-15s sweet spot
        const MAX_DELAY_MS = 30000;   // 30 seconds safety ceiling

        if (elapsedSoFar < TARGET_DELAY_MS) {
          const remainingWait = Math.min(TARGET_DELAY_MS - elapsedSoFar, MAX_DELAY_MS);
          logger.info(`[GROUP_STATUS] Preview ready. Pausing for ${remainingWait}ms (total 5-15s) to guarantee thumbnail propagation...`);
          await new Promise((resolve) => setTimeout(resolve, remainingWait));
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

        logger.info("[GROUP_STATUS] Relaying group status with verified link preview card and thumbnail", {
          chatId,
          title: richPreview.title,
          hasThumb: Boolean(richPreview.jpegThumbnail),
          thumbBytes: richPreview.jpegThumbnail.length,
          totalElapsedMs: Date.now() - statusStartTime,
        });

        try {
          await sock.relayMessage(chatId, statusV2Message, {});
        } catch {
          await sock.relayMessage(chatId, statusV1Message, {});
        }

        // Clean up command message
        if (msgKey?.id) {
          await sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});
        }
        return;
      }

      mediaPayload = {
        text: textToPost,
      };
    }

    if (!mediaPayload) {
      return;
    }

    // Media upload and generation
    const innerMsg = await generateWAMessageContent(mediaPayload, {
      upload: sock.waUploadToServer,
    });

    // Ensure 5-10s deliberate propagation for media status as well
    const elapsedMedia = Date.now() - statusStartTime;
    if (elapsedMedia < 6000) {
      const waitTime = Math.min(6500 - elapsedMedia, 30000);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

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
      totalElapsedMs: Date.now() - statusStartTime,
    });

    try {
      await sock.relayMessage(chatId, statusV2Message, {});
    } catch {
      await sock.relayMessage(chatId, statusV1Message, {});
    }

    if (msgKey?.id) {
      await sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});
    }
  } catch (err) {
    logger.error("[GROUP_STATUS] Execution error", err.message);
  }
}
