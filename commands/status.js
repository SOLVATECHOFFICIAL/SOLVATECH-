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
 * Strips the .status command trigger cleanly from text/caption.
 * e.g. ".status https://chat.whatsapp.com/..." -> "https://chat.whatsapp.com/..."
 * e.g. ".Status check out this video" -> "check out this video"
 */
function cleanStatusCaption(rawText = "") {
  if (!rawText) return "";
  let cleaned = String(rawText).trim();
  // Strip leading command prefixes like .status, .Status, !status, /status, etc.
  cleaned = cleaned.replace(/^[.!\/#$]?status\s*/i, "").trim();
  return cleaned;
}

/**
 * .status command:
 * Post photos, videos, audio, group links, channel links, or web links to WhatsApp Group Status (story).
 *
 * SPECIFICATION:
 * - Patient processing: allows full time needed (1-2+ mins) for heavy videos and media to upload completely.
 * - Supports direct media with caption (e.g. user sends video with .status <description/link>).
 * - Supports replying to media with .status <caption/link>.
 * - Clean caption stripping: removes the command word (.status) so only the clean under-text/link is uploaded.
 * - Video under-text (caption) is preserved directly on the status payload.
 * - Only works in groups.
 * - Only the linked owner can trigger it.
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
  const currentContent = getMessageContent(message);
  const contextInfo = Object.values(currentContent).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  // React with ⏳ to indicate that the upload process has started
  if (msgKey?.id) {
    sock.sendMessage(chatId, { react: { text: "⏳", key: msgKey } }).catch(() => {});
  }

  // Clean the caption provided via command arguments
  const userTypedArgs = args.join(" ").trim();
  const cleanedTypedText = cleanStatusCaption(userTypedArgs);

  // Check if the current incoming message ITSELF contains media (direct media upload with .status caption)
  const currentUnwrapped = unwrapMediaMessage(message);
  const currentHasDirectMedia = Boolean(
    currentUnwrapped?.videoMessage ||
    currentUnwrapped?.imageMessage ||
    currentUnwrapped?.audioMessage ||
    currentUnwrapped?.documentMessage ||
    currentUnwrapped?.ptvMessage
  );

  const unwrapQuoted = quotedMsg ? unwrapMediaMessage(quotedMsg) : {};
  const cachedEntry = quotedStanzaId ? getCachedIncomingMessage(userId, quotedStanzaId) : null;

  // If no media (direct or quoted) and no text/link, nothing to post
  if (!currentHasDirectMedia && !quotedMsg && !cleanedTypedText) {
    if (msgKey?.id) {
      sock.sendMessage(chatId, { react: { text: "❓", key: msgKey } }).catch(() => {});
    }
    return;
  }

  try {
    let mediaPayload = null;

    // PRIORITY 1: Check media attached DIRECTLY to the current message (direct send with .status in caption)
    if (currentHasDirectMedia) {
      const directCandidates = [message, currentContent, currentUnwrapped].filter(Boolean);

      // Direct Video
      if (currentUnwrapped.videoMessage || currentUnwrapped.ptvMessage) {
        logger.info("[GROUP_STATUS] Processing direct video upload for group status (allowing full upload time)...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "video");
        if (res && res.buffer) {
          const rawCaption = res.media?.caption || currentUnwrapped.videoMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;
          const mimetype = res.media?.mimetype || currentUnwrapped.videoMessage?.mimetype || "video/mp4";

          mediaPayload = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
          };
        }
      }
      // Direct Image
      else if (currentUnwrapped.imageMessage) {
        logger.info("[GROUP_STATUS] Processing direct image upload for group status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "image");
        if (res && res.buffer) {
          const rawCaption = res.media?.caption || currentUnwrapped.imageMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;

          mediaPayload = {
            image: res.buffer,
            caption: finalCaption || undefined,
          };
        }
      }
      // Direct Audio
      else if (currentUnwrapped.audioMessage) {
        logger.info("[GROUP_STATUS] Processing direct audio upload for group status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "audio");
        if (res && res.buffer) {
          const mimetype = res.media?.mimetype || currentUnwrapped.audioMessage?.mimetype || "audio/mp4";
          const ptt = Boolean(res.media?.ptt || currentUnwrapped.audioMessage?.ptt);

          mediaPayload = {
            audio: res.buffer,
            mimetype,
            ptt,
          };
        }
      }
      // Direct Document
      else if (currentUnwrapped.documentMessage) {
        const res = await retrieveMediaBuffer(sock, directCandidates, "document");
        if (res && res.buffer) {
          const rawCaption = res.media?.caption || currentUnwrapped.documentMessage?.caption || "";
          const finalCaption = cleanedTypedText || cleanStatusCaption(rawCaption);
          const mimetype = res.media?.mimetype || currentUnwrapped.documentMessage?.mimetype || "application/octet-stream";
          const fileName = res.media?.fileName || currentUnwrapped.documentMessage?.fileName || "attachment";

          mediaPayload = {
            document: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
            fileName,
          };
        }
      }
    }

    // PRIORITY 2: Check media from QUOTED message (user replied to media with .status)
    if (!mediaPayload && quotedMsg) {
      const quotedCandidates = [
        cachedEntry?.rawMessage,
        cachedEntry?.content,
        quotedMsg,
        unwrapQuoted,
      ].filter(Boolean);

      // Quoted Video
      const hasQuotedVideo = Boolean(
        unwrapQuoted.videoMessage ||
        unwrapQuoted.ptvMessage ||
        unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
        cachedEntry?.mediaType === "video" ||
        cachedEntry?.content?.videoMessage
      );

      if (hasQuotedVideo) {
        logger.info("[GROUP_STATUS] Processing quoted video upload for group status (allowing full upload time)...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "video");
        if (res && res.buffer) {
          const origCaption =
            res.media?.caption ||
            unwrapQuoted.videoMessage?.caption ||
            unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
            cachedEntry?.caption ||
            "";
          const cleanOrigCaption = cleanStatusCaption(origCaption);
          const finalCaption = cleanedTypedText || cleanOrigCaption;
          const mimetype = res.media?.mimetype || unwrapQuoted.videoMessage?.mimetype || "video/mp4";

          mediaPayload = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
          };
        }
      }

      // Quoted Image
      const hasQuotedImage = !mediaPayload && Boolean(
        unwrapQuoted.imageMessage ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
        cachedEntry?.mediaType === "image" ||
        cachedEntry?.content?.imageMessage
      );

      if (hasQuotedImage) {
        logger.info("[GROUP_STATUS] Processing quoted image upload for group status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "image");
        if (res && res.buffer) {
          const origCaption =
            res.media?.caption ||
            unwrapQuoted.imageMessage?.caption ||
            unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
            cachedEntry?.caption ||
            "";
          const cleanOrigCaption = cleanStatusCaption(origCaption);
          const finalCaption = cleanedTypedText || cleanOrigCaption;

          mediaPayload = {
            image: res.buffer,
            caption: finalCaption || undefined,
          };
        }
      }

      // Quoted Audio
      const hasQuotedAudio = !mediaPayload && Boolean(
        unwrapQuoted.audioMessage ||
        unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
        cachedEntry?.mediaType === "audio" ||
        cachedEntry?.content?.audioMessage
      );

      if (hasQuotedAudio) {
        logger.info("[GROUP_STATUS] Processing quoted audio upload for group status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "audio");
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

      // Quoted Document
      const hasQuotedDocument = !mediaPayload && Boolean(
        unwrapQuoted.documentMessage ||
        unwrapQuoted.viewOnceMessage?.message?.documentMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.documentMessage ||
        cachedEntry?.mediaType === "document" ||
        cachedEntry?.content?.documentMessage
      );

      if (hasQuotedDocument) {
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "document");
        if (res && res.buffer) {
          const origCaption = res.media?.caption || unwrapQuoted.documentMessage?.caption || "";
          const finalCaption = cleanedTypedText || cleanStatusCaption(origCaption);
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
    }

    // PRIORITY 3: LINK OR TEXT STATUS (Group Invite, Channel, or Web Link)
    if (!mediaPayload) {
      let textToPost = "";

      if (quotedMsg) {
        const origText = cleanStatusCaption(
          unwrapQuoted.conversation ||
          unwrapQuoted.extendedTextMessage?.text ||
          unwrapQuoted.groupInviteMessage?.caption ||
          cachedEntry?.text ||
          ""
        );

        const urlInOrig = (origText || "").match(ANY_LINK_REGEX)?.[0];

        if (!urlInOrig && unwrapQuoted.groupInviteMessage?.inviteCode) {
          const inviteUrl = `https://chat.whatsapp.com/${unwrapQuoted.groupInviteMessage.inviteCode}`;
          textToPost = cleanedTypedText ? `${cleanedTypedText}\n\n${inviteUrl}` : inviteUrl;
        } else if (cleanedTypedText) {
          if (urlInOrig && !cleanedTypedText.includes(urlInOrig)) {
            textToPost = `${cleanedTypedText}\n\n${urlInOrig}`;
          } else {
            textToPost = cleanedTypedText;
          }
        } else {
          textToPost = origText;
        }
      } else {
        textToPost = cleanedTypedText;
      }

      if (!textToPost) {
        if (msgKey?.id) {
          sock.sendMessage(chatId, { react: { text: "❓", key: msgKey } }).catch(() => {});
        }
        return;
      }

      const hasUrl = Boolean(
        ANY_LINK_REGEX.test(textToPost) ||
        unwrapQuoted.groupInviteMessage
      );

      if (hasUrl) {
        logger.info("[GROUP_STATUS] Resolving high-fidelity link preview for link status story...");
        const richPreview = await generateRichLinkPreview(
          textToPost,
          unwrapQuoted.extendedTextMessage || cachedEntry?.content?.extendedTextMessage,
          sock
        );

        if (!richPreview || !richPreview.title || !richPreview.jpegThumbnail || richPreview.jpegThumbnail.length === 0) {
          logger.warn("[GROUP_STATUS] Link preview validation fallback — relaying clean text card.");
          mediaPayload = { text: textToPost };
        } else {
          // Allow deliberate propagation (6-10 seconds) so WhatsApp servers cache the picture thumbnail
          const elapsedSoFar = Date.now() - statusStartTime;
          if (elapsedSoFar < 7000) {
            await new Promise((resolve) => setTimeout(resolve, 7500 - elapsedSoFar));
          }

          const innerMsg = proto.Message.fromObject({
            extendedTextMessage: richPreview,
          });

          const statusV2Message = proto.Message.fromObject({
            groupStatusMessageV2: { message: innerMsg },
          });

          const statusV1Message = proto.Message.fromObject({
            groupStatusMessage: { message: innerMsg },
          });

          logger.info("[GROUP_STATUS] Relaying group status with verified link preview card and thumbnail", {
            chatId,
            title: richPreview.title,
            totalElapsedMs: Date.now() - statusStartTime,
          });

          try {
            await sock.relayMessage(chatId, statusV2Message, {});
          } catch {
            await sock.relayMessage(chatId, statusV1Message, {});
          }

          if (msgKey?.id) {
            await sock.sendMessage(chatId, { react: { text: "✅", key: msgKey } }).catch(() => {});
            setTimeout(() => {
              sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});
            }, 3000);
          }
          return;
        }
      } else {
        mediaPayload = { text: textToPost };
      }
    }

    if (!mediaPayload) {
      if (msgKey?.id) {
        sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
      }
      return;
    }

    // Media upload and generation (allows full time needed for large videos/photos)
    logger.info("[GROUP_STATUS] Uploading status media payload (allowing full upload time)...", {
      chatId,
      mediaType: mediaPayload.video ? "video" : mediaPayload.image ? "image" : mediaPayload.audio ? "audio" : "text",
      hasCaption: Boolean(mediaPayload.caption),
      captionText: mediaPayload.caption || "",
    });

    const innerMsg = await generateWAMessageContent(mediaPayload, {
      upload: sock.waUploadToServer,
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

    logger.info("[GROUP_STATUS] Relaying group status directly to group", {
      chatId,
      mediaType: mediaPayload.video ? "video" : mediaPayload.image ? "image" : mediaPayload.audio ? "audio" : "text",
      totalElapsedMs: Date.now() - statusStartTime,
    });

    try {
      await sock.relayMessage(chatId, statusV2Message, {});
    } catch {
      await sock.relayMessage(chatId, statusV1Message, {});
    }

    if (msgKey?.id) {
      await sock.sendMessage(chatId, { react: { text: "✅", key: msgKey } }).catch(() => {});
      setTimeout(() => {
        sock.sendMessage(chatId, { delete: msgKey }).catch(() => {});
      }, 3000);
    }
  } catch (err) {
    logger.error("[GROUP_STATUS] Execution error", err.message);
    if (msgKey?.id) {
      sock.sendMessage(chatId, { react: { text: "⚠️", key: msgKey } }).catch(() => {});
    }
  }
}
