import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
  downloadMediaMessage,
  proto,
} from "@whiskeysockets/baileys";
import sharp from "sharp";
import { isGroup, getMessageContent, unwrapMediaMessage, streamToBuffer } from "../lib/helpers.js";
import { downloadViewOnceRobust } from "../lib/media.js";
import { getCachedIncomingMessage, ensureMediaDownloaded } from "../lib/deleted-messages.js";
import { generateRichLinkPreview } from "../lib/link-preview.js";
import { logger } from "../lib/logger.js";

const ANY_LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|whatsapp\.com\/channel\/|wa\.me\/)[^\s]+/i;

/**
 * Ensures a valid JPEG thumbnail buffer exists for video and image status/posts.
 */
async function ensureJpegThumbnail(buffer, existingThumb = null, isVideo = false) {
  if (existingThumb && Buffer.isBuffer(existingThumb) && existingThumb.length > 0) {
    return existingThumb;
  }
  if (existingThumb && typeof existingThumb === "string") {
    try {
      const b = Buffer.from(existingThumb, "base64");
      if (b.length > 0) return b;
    } catch {}
  }
  if (!isVideo && buffer && Buffer.isBuffer(buffer)) {
    try {
      return await sharp(buffer)
        .resize(320, 320, { fit: "inside" })
        .jpeg({ quality: 75 })
        .toBuffer();
    } catch (err) {
      logger.debug("[GCSTATUS] Image thumbnail generation notice:", err.message);
    }
  }
  return null;
}

/**
 * Robustly extract and decrypt media buffer across multiple candidate representations.
 */
async function retrieveMediaBuffer(sock, candidates = [], mediaType = "image", cachedEntry = null) {
  const streamType = mediaType === "audio" ? "audio" : mediaType === "video" ? "video" : "image";

  // Strategy 1: Check pre-buffered media in cachedEntry
  if (cachedEntry?.mediaBuffer && Buffer.isBuffer(cachedEntry.mediaBuffer) && cachedEntry.mediaBuffer.length > 0) {
    const rawContent = unwrapMediaMessage(cachedEntry.rawMessage || {});
    return {
      buffer: cachedEntry.mediaBuffer,
      media: rawContent?.videoMessage || rawContent?.imageMessage || rawContent?.audioMessage || rawContent?.documentMessage,
    };
  }

  // Strategy 2: Direct stream decryption via downloadContentFromMessage
  for (const candidate of candidates) {
    if (!candidate) continue;
    const content = unwrapMediaMessage(candidate);
    const media =
      content?.videoMessage ||
      content?.imageMessage ||
      content?.audioMessage ||
      content?.documentMessage ||
      content?.ptvMessage ||
      content?.stickerMessage;

    if (media && (media.mediaKey || media.url || media.directPath)) {
      try {
        const stream = await downloadContentFromMessage(media, streamType);
        const buf = await streamToBuffer(stream);
        if (buf && buf.length > 0) {
          return { buffer: buf, media };
        }
      } catch (err) {
        logger.debug(`[GCSTATUS] Direct stream decryption notice for ${mediaType}:`, err.message);
      }
    }
  }

  // Strategy 3: downloadViewOnceRobust
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const target = candidate.message ? candidate : { message: candidate };
      const buf = await downloadViewOnceRobust(sock, target, cachedEntry);
      if (buf && buf.length > 0) {
        const content = unwrapMediaMessage(candidate);
        const media =
          content?.videoMessage ||
          content?.imageMessage ||
          content?.audioMessage ||
          content?.documentMessage;
        return { buffer: buf, media };
      }
    } catch {}
  }

  // Strategy 4: Baileys downloadMediaMessage
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
          content?.videoMessage ||
          content?.imageMessage ||
          content?.audioMessage ||
          content?.documentMessage;
        return { buffer: buf, media };
      }
    } catch {}
  }

  // Strategy 5: cachedEntry on-demand download via ensureMediaDownloaded
  if (cachedEntry) {
    try {
      const buf = await ensureMediaDownloaded(cachedEntry, sock);
      if (buf && buf.length > 0) {
        const rawContent = unwrapMediaMessage(cachedEntry.rawMessage || {});
        return {
          buffer: buf,
          media: rawContent?.videoMessage || rawContent?.imageMessage || rawContent?.audioMessage || rawContent?.documentMessage,
        };
      }
    } catch {}
  }

  return null;
}

/**
 * Strips the command triggers (.gcstatus, .status, .groupstatus with optional everyone/all) cleanly.
 */
function cleanStatusCaption(rawText = "") {
  if (!rawText) return "";
  let cleaned = String(rawText).trim();
  cleaned = cleaned.replace(/^[.!\/#$]?(?:gcstatus|groupstatus|status)(?:\s+@?(?:everyone|all))?\s*/i, "").trim();
  return cleaned;
}

/**
 * Cleans command arguments specifically typed after the command.
 */
function cleanUserArgs(rawArgs = "") {
  if (!rawArgs) return "";
  let cleaned = String(rawArgs).trim();
  cleaned = cleaned.replace(/^[.!\/#$]?(?:gcstatus|groupstatus|status)\s*/i, "").trim();
  cleaned = cleaned.replace(/^@?(?:everyone|all)\s*/i, "").trim();
  return cleaned;
}

/**
 * .gcstatus / .status command:
 * Posts videos, photos, audio, documents, text, or links to ALL participating groups (everyone).
 *
 * SPECIFICATION:
 * - Broadcasts to every group the bot/account participates in.
 * - Supports direct media with caption (e.g. user sends video with caption: .gcstatus everyone <description/link>).
 * - Supports replying to media with .gcstatus everyone <caption/link>.
 * - Strips command prefixes (.gcstatus, .status, everyone) so only the clean under-text/link is uploaded.
 * - Video under-text (caption) is preserved directly on the video message in all groups.
 * - Uploads media once to WhatsApp server, then relays to each group with minimal latency.
 * - Works for linked account owner in any group or personal DM.
 */
export default async function status({
  sock,
  message,
  chatId,
  senderIsLinkedAccount,
  args = [],
  userId = "default",
}) {
  // Owner-only restriction: only the linked owner can trigger broadcasts
  if (!senderIsLinkedAccount) {
    return;
  }

  const msgKey = message?.key || {};
  const currentContent = getMessageContent(message);
  const contextInfo = Object.values(currentContent).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  // React with ⏳ to indicate that processing and uploading has started
  if (msgKey?.id) {
    sock.sendMessage(chatId, { react: { text: "⏳", key: msgKey } }).catch(() => {});
  }

  // Clean the caption provided via command arguments
  const userTypedArgs = args.join(" ").trim();
  const cleanedTypedText = cleanUserArgs(userTypedArgs);

  // Check if current incoming message contains direct media
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

    // PRIORITY 1: Check media attached DIRECTLY to the current message
    if (currentHasDirectMedia) {
      const directCandidates = [message, currentContent, currentUnwrapped].filter(Boolean);

      // Direct Video
      if (currentUnwrapped.videoMessage || currentUnwrapped.ptvMessage) {
        logger.info("[GCSTATUS] Processing direct video for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "video", cachedEntry);
        if (res && res.buffer) {
          const rawCaption = res.media?.caption || currentUnwrapped.videoMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;
          const mimetype = res.media?.mimetype || currentUnwrapped.videoMessage?.mimetype || "video/mp4";

          const existingThumb =
            res.media?.jpegThumbnail ||
            currentUnwrapped.videoMessage?.jpegThumbnail ||
            null;

          mediaPayload = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
            jpegThumbnail: existingThumb || undefined,
          };
        }
      }
      // Direct Image
      else if (currentUnwrapped.imageMessage) {
        logger.info("[GCSTATUS] Processing direct image for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "image", cachedEntry);
        if (res && res.buffer) {
          const rawCaption = res.media?.caption || currentUnwrapped.imageMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;
          const existingThumb =
            res.media?.jpegThumbnail ||
            currentUnwrapped.imageMessage?.jpegThumbnail ||
            null;

          mediaPayload = {
            image: res.buffer,
            caption: finalCaption || undefined,
            jpegThumbnail: existingThumb || undefined,
          };
        }
      }
      // Direct Audio
      else if (currentUnwrapped.audioMessage) {
        logger.info("[GCSTATUS] Processing direct audio for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "audio", cachedEntry);
        if (res && res.buffer) {
          const mimetype = res.media?.mimetype || currentUnwrapped.audioMessage?.mimetype || "audio/mp4";
          mediaPayload = {
            audio: res.buffer,
            mimetype,
            ptt: true,
          };
        }
      }
      // Direct Document
      else if (currentUnwrapped.documentMessage) {
        logger.info("[GCSTATUS] Processing direct document for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "document", cachedEntry);
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

    // PRIORITY 2: Check media from QUOTED message (user replied to media with .gcstatus / .status)
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
        logger.info("[GCSTATUS] Processing quoted video for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "video", cachedEntry);
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

          const existingThumb =
            res.media?.jpegThumbnail ||
            unwrapQuoted.videoMessage?.jpegThumbnail ||
            cachedEntry?.content?.videoMessage?.jpegThumbnail ||
            null;

          mediaPayload = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
            jpegThumbnail: existingThumb || undefined,
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
        logger.info("[GCSTATUS] Processing quoted image for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "image", cachedEntry);
        if (res && res.buffer) {
          const origCaption =
            res.media?.caption ||
            unwrapQuoted.imageMessage?.caption ||
            unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
            cachedEntry?.caption ||
            "";
          const cleanOrigCaption = cleanStatusCaption(origCaption);
          const finalCaption = cleanedTypedText || cleanOrigCaption;

          const existingThumb =
            res.media?.jpegThumbnail ||
            unwrapQuoted.imageMessage?.jpegThumbnail ||
            cachedEntry?.content?.imageMessage?.jpegThumbnail ||
            null;

          mediaPayload = {
            image: res.buffer,
            caption: finalCaption || undefined,
            jpegThumbnail: existingThumb || undefined,
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
        logger.info("[GCSTATUS] Processing quoted audio for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "audio", cachedEntry);
        if (res && res.buffer) {
          const mimetype = res.media?.mimetype || unwrapQuoted.audioMessage?.mimetype || "audio/mp4";
          mediaPayload = {
            audio: res.buffer,
            mimetype,
            ptt: true,
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
        logger.info("[GCSTATUS] Processing quoted document for all groups broadcast...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "document", cachedEntry);
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

    // 1. Fetch ALL participating groups
    let participating = {};
    try {
      participating = await sock.groupFetchAllParticipating();
    } catch (fetchErr) {
      logger.warn("[GCSTATUS] groupFetchAllParticipating notice:", fetchErr.message);
    }

    const participatingJids = Object.keys(participating || {});
    const targetGroups = Array.from(
      new Set([
        ...participatingJids,
        ...(isGroup(chatId) ? [chatId] : []),
      ])
    ).filter((j) => isGroup(j));

    if (targetGroups.length === 0) {
      logger.warn("[GCSTATUS] No participating groups found to post to.");
      if (msgKey?.id) {
        await sock.sendMessage(chatId, { react: { text: "❓", key: msgKey } }).catch(() => {});
      }
      return;
    }

    let successCount = 0;
    const ownJid = sock.user?.id || sock.authState?.creds?.me?.id;

    // CASE A: MEDIA POST (Video, Image, Audio, Document)
    if (mediaPayload) {
      if (mediaPayload.video) {
        const thumb = await ensureJpegThumbnail(
          mediaPayload.video,
          mediaPayload.jpegThumbnail,
          true
        );
        if (thumb) mediaPayload.jpegThumbnail = thumb;
      } else if (mediaPayload.image) {
        const thumb = await ensureJpegThumbnail(
          mediaPayload.image,
          mediaPayload.jpegThumbnail,
          false
        );
        if (thumb) mediaPayload.jpegThumbnail = thumb;
      }

      logger.info(`[GCSTATUS] Broadcasting media to ${targetGroups.length} groups...`, {
        mediaType: mediaPayload.video ? "video" : mediaPayload.image ? "image" : mediaPayload.audio ? "audio" : "document",
        hasCaption: Boolean(mediaPayload.caption),
        caption: mediaPayload.caption || "",
      });

      // Upload once to WhatsApp media server
      let preparedContent = null;
      try {
        preparedContent = await generateWAMessageContent(mediaPayload, {
          upload: sock.waUploadToServer,
        });
      } catch (uploadErr) {
        logger.warn("[GCSTATUS] Single-upload generateWAMessageContent error, will fallback per group:", uploadErr.message);
      }

      for (const groupJid of targetGroups) {
        try {
          if (preparedContent) {
            const fullMsg = generateWAMessageFromContent(groupJid, preparedContent, {
              userJid: ownJid,
            });
            await sock.relayMessage(groupJid, fullMsg.message, { messageId: fullMsg.key.id });
            successCount++;
          } else {
            await sock.sendMessage(groupJid, mediaPayload);
            successCount++;
          }
        } catch (relayErr) {
          logger.debug(`[GCSTATUS] Relay error to ${groupJid}, falling back to sendMessage:`, relayErr.message);
          try {
            await sock.sendMessage(groupJid, mediaPayload);
            successCount++;
          } catch (sendErr) {
            logger.warn(`[GCSTATUS] Could not deliver media to group ${groupJid}:`, sendErr.message);
          }
        }

        if (targetGroups.length > 1) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    // CASE B: TEXT OR LINK POST
    else {
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

      let linkPreviewMsg = null;
      if (hasUrl) {
        logger.info("[GCSTATUS] Generating rich link preview for groups broadcast...");
        try {
          const richPreview = await generateRichLinkPreview(
            textToPost,
            unwrapQuoted.extendedTextMessage || cachedEntry?.content?.extendedTextMessage,
            sock
          );
          if (richPreview && richPreview.title) {
            linkPreviewMsg = {
              text: textToPost,
              contextInfo: richPreview.contextInfo,
            };
          }
        } catch (previewErr) {
          logger.debug("[GCSTATUS] Link preview fallback:", previewErr.message);
        }
      }

      const textPayload = linkPreviewMsg || { text: textToPost };

      logger.info(`[GCSTATUS] Broadcasting text/link to ${targetGroups.length} groups...`, {
        textSnippet: textToPost.slice(0, 60),
      });

      for (const groupJid of targetGroups) {
        try {
          await sock.sendMessage(groupJid, textPayload);
          successCount++;
        } catch (err) {
          logger.warn(`[GCSTATUS] Could not deliver text to group ${groupJid}:`, err.message);
        }

        if (targetGroups.length > 1) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    logger.info(`[GCSTATUS] Completed broadcast to ${successCount}/${targetGroups.length} groups.`);

    if (msgKey?.id) {
      if (successCount > 0) {
        await sock.sendMessage(chatId, { react: { text: "✅", key: msgKey } }).catch(() => {});
      } else {
        await sock.sendMessage(chatId, { react: { text: "⚠️", key: msgKey } }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error("[GCSTATUS] Execution error:", err.message);
    if (msgKey?.id) {
      sock.sendMessage(chatId, { react: { text: "⚠️", key: msgKey } }).catch(() => {});
    }
  }
}
