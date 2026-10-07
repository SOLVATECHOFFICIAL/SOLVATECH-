import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import axios from "axios";
import sharp from "sharp";
import {
  prepareWAMessageMedia,
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
  downloadMediaMessage,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { isGroup, getMessageContent, getMessageText, unwrapMediaMessage, streamToBuffer } from "../lib/helpers.js";
import { downloadViewOnceRobust } from "../lib/media.js";
import { getCachedIncomingMessage, ensureMediaDownloaded } from "../lib/deleted-messages.js";
import { getSafeMetadata } from "../lib/command-tools.js";
import { generateRichLinkPreview } from "../lib/link-preview.js";
import { logger } from "../lib/logger.js";

const ANY_LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|whatsapp\.com\/channel\/|wa\.me\/)[^\s]+/i;

/**
 * Extracts a high quality frame from a video buffer using ffmpeg for status preview.
 */
async function extractVideoThumbnail(videoBuffer) {
  if (!videoBuffer || !Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solva-vid-thumb-"));
  const input = path.join(dir, "input.mp4");
  const output = path.join(dir, "thumb.jpg");
  try {
    await fs.writeFile(input, videoBuffer);
    await new Promise((resolve) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-ss", "00:00:00.3",
        "-i", input,
        "-vframes", "1",
        "-vf", "scale=360:360:force_original_aspect_ratio=decrease",
        "-q:v", "3",
        output,
      ]);
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    let thumbBuf = await fs.readFile(output).catch(() => null);
    if (!thumbBuf || thumbBuf.length === 0) {
      // Fallback without timestamp seek for micro-clips
      await new Promise((resolve) => {
        const child = spawn("ffmpeg", [
          "-y",
          "-i", input,
          "-vframes", "1",
          "-vf", "scale=360:360:force_original_aspect_ratio=decrease",
          "-q:v", "3",
          output,
        ]);
        child.on("close", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
      });
      thumbBuf = await fs.readFile(output).catch(() => null);
    }
    return thumbBuf;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ensures a valid JPEG thumbnail buffer exists for video and image group status.
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
  if (isVideo && buffer && Buffer.isBuffer(buffer)) {
    const vidThumb = await extractVideoThumbnail(buffer);
    if (vidThumb) return vidThumb;
  }
  if (!isVideo && buffer && Buffer.isBuffer(buffer)) {
    try {
      return await sharp(buffer)
        .resize(360, 360, { fit: "inside" })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      logger.debug("[GCSTATUS] Image thumbnail generation notice:", err.message);
    }
  }
  return null;
}

/**
 * Converts any audio buffer into WhatsApp Status-compliant Opus audio in an OGG container.
 * WhatsApp Status strictly requires "audio/ogg; codecs=opus" with ptt=true.
 */
async function ensureOpusVoiceNote(audioBuffer) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return audioBuffer;
  // If already Opus in OGG container (magic header 'OggS')
  if (audioBuffer.length > 4 && audioBuffer.slice(0, 4).toString() === "OggS") {
    return audioBuffer;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "solva-voice-"));
  const input = path.join(dir, "input.bin");
  const output = path.join(dir, "output.ogg");
  try {
    await fs.writeFile(input, audioBuffer);
    const converted = await new Promise((resolve) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-i", input,
        "-c:a", "libopus",
        "-b:a", "64k",
        "-ac", "1",
        "-ar", "48000",
        "-f", "ogg",
        output,
      ]);
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    if (converted) {
      const oggBuf = await fs.readFile(output).catch(() => null);
      if (oggBuf && oggBuf.length > 0) return oggBuf;
    }
    return audioBuffer;
  } catch (err) {
    logger.debug("[GCSTATUS] Opus voice note conversion note:", err.message);
    return audioBuffer;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Deep media retrieval that thoroughly downloads from all candidate sources without rushing.
 */
async function retrieveMediaBuffer(sock, candidates = [], mediaType = "image", cachedEntry = null) {
  const streamType = mediaType === "audio" ? "audio" : mediaType === "video" ? "video" : "image";

  // Strategy 1: Check pre-buffered media in memory
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

  // Strategy 3: Baileys downloadMediaMessage with logger context
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

  // Strategy 4: downloadViewOnceRobust
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

  // Strategy 6: If direct HTTPS url is available on media object
  for (const candidate of candidates) {
    if (!candidate) continue;
    const content = unwrapMediaMessage(candidate);
    const media =
      content?.videoMessage ||
      content?.imageMessage ||
      content?.audioMessage ||
      content?.documentMessage;
    if (media?.url && typeof media.url === "string" && media.url.startsWith("http")) {
      try {
        const resp = await axios.get(media.url, { responseType: "arraybuffer", timeout: 45000 });
        if (resp.data && resp.data.length > 0) {
          return { buffer: Buffer.from(resp.data), media };
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Strips the command triggers (.gcstatus, .gc status with optional everyone/all) cleanly.
 */
function cleanStatusCaption(rawText = "") {
  if (!rawText) return "";
  let cleaned = String(rawText).trim();
  cleaned = cleaned.replace(/^[.!\/#$]?(?:gc\s*status|gcstatus|groupstatus|status)(?:\s+@?(?:everyone|all))?\s*/i, "").trim();
  return cleaned;
}

/**
 * Cleans command arguments specifically typed after the command.
 */
function cleanUserArgs(rawArgs = "") {
  if (!rawArgs) return "";
  let cleaned = String(rawArgs).trim();
  cleaned = cleaned.replace(/^[.!\/#$]?(?:gc\s*status|gcstatus|groupstatus|status)\s*/i, "").trim();
  cleaned = cleaned.replace(/^@?(?:everyone|all)\s*/i, "").trim();
  return cleaned;
}

/**
 * .gcstatus / .gcstatus everyone command:
 * Posts videos, photos, audio, documents, links or text directly to WHATSAPP GROUP STATUS (Group Stories)!
 *
 * SPECIFICATION & USER REQUIREMENTS:
 * - Does NOT send regular chat messages into groups or back to the user's DM.
 * - Posts natively as a 24-hour Group Status story (wrapped in `groupStatusMessageV2` and synced to `status@broadcast`).
 * - For links: Takes the deliberate time needed (never rushed) to generate high-quality preview banners with titles & descriptions.
 * - For media (video, pic, sound): Downloads and uploads fully to WhatsApp MMG servers, using whatever seconds/minutes are required.
 * - Audio: Automatically transcodes to WhatsApp-compliant Opus OGG voice notes so WhatsApp servers never reject sound.
 * - Strictly honest verification: Reacts with ⏳ while processing and ✅ ONLY when WhatsApp servers truly accept the publication.
 * - If anything fails, gives a REAL, clear error explaining why and how to resolve it.
 * - `.gcstatus [caption]`: Updates the Group Status of ONLY the current group.
 * - `.gcstatus everyone [caption]`: Updates the Group Status across ALL groups the bot belongs to.
 */
export default async function status({
  sock,
  message,
  chatId,
  senderIsLinkedAccount,
  args = [],
  reply,
  userId = "default",
}) {
  // Owner-only restriction: only the linked owner can publish to group status
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

  // React with ⏳ immediately so the user knows processing has started
  if (msgKey?.id) {
    sock.sendMessage(chatId, { react: { text: "⏳", key: msgKey } }).catch(() => {});
  }

  // Handle ".gc status ..." where args[0] is "status"
  const normalizedArgs = [...args];
  if (normalizedArgs[0] && normalizedArgs[0].toLowerCase() === "status") {
    normalizedArgs.shift();
  }

  const userTypedArgs = normalizedArgs.join(" ").trim();
  const rawCaptionText = getMessageText(message) || "";

  // Differentiate:
  // .gcstatus everyone => post Group Status for ALL groups
  // .gcstatus => post Group Status ONLY for the current group
  const isEveryone = Boolean(
    /\b(?:everyone|all|@everyone|@all)\b/i.test(userTypedArgs)
  );

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

  // Detect if this is a media request
  const isMediaRequest = Boolean(
    currentHasDirectMedia ||
    unwrapQuoted.videoMessage ||
    unwrapQuoted.imageMessage ||
    unwrapQuoted.audioMessage ||
    unwrapQuoted.documentMessage ||
    unwrapQuoted.ptvMessage ||
    unwrapQuoted.stickerMessage ||
    unwrapQuoted.viewOnceMessage ||
    unwrapQuoted.viewOnceMessageV2 ||
    cachedEntry?.mediaType
  );

  // If no media (direct or quoted) and no text/link, return prompt
  if (!isMediaRequest && !cleanedTypedText) {
    if (msgKey?.id) {
      sock.sendMessage(chatId, { react: { text: "❓", key: msgKey } }).catch(() => {});
    }
    if (typeof reply === "function") {
      await reply("ℹ️ *Usage:* Reply to a picture, video, voice note, or link with *.gcstatus* (or *.gcstatus everyone*).");
    }
    return;
  }

  try {
    let preparedInner = null;
    let rawContentToPrepare = null;
    let detectedMediaType = null;
    const ownJid = sock.user?.id || sock.authState?.creds?.me?.id;

    // ----------------------------------------------------
    // CASE A: DIRECT MEDIA ATTACHED TO CURRENT MESSAGE
    // ----------------------------------------------------
    if (currentHasDirectMedia) {
      const directCandidates = [message, currentContent, currentUnwrapped].filter(Boolean);

      // Direct Video
      if (currentUnwrapped.videoMessage || currentUnwrapped.ptvMessage) {
        detectedMediaType = "video";
        logger.info("[GCSTATUS] Downloading direct video for Group Status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "video", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          const rawCaption = res.media?.caption || currentUnwrapped.videoMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;
          const existingThumb = res.media?.jpegThumbnail || currentUnwrapped.videoMessage?.jpegThumbnail || null;
          const thumb = await ensureJpegThumbnail(res.buffer, existingThumb, true);

          logger.info(`[GCSTATUS] Uploading video (${(res.buffer.length / 1024 / 1024).toFixed(2)} MB) to WhatsApp MMG servers...`);
          const uploaded = await prepareWAMessageMedia(
            {
              video: res.buffer,
              caption: finalCaption || undefined,
              mimetype: "video/mp4",
              jpegThumbnail: thumb || undefined,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            videoMessage: {
              ...uploaded.videoMessage,
              caption: finalCaption || undefined,
              jpegThumbnail: thumb || uploaded.videoMessage?.jpegThumbnail || undefined,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype: "video/mp4",
            jpegThumbnail: thumb || undefined,
          };
        }
      }
      // Direct Image
      else if (currentUnwrapped.imageMessage) {
        detectedMediaType = "image";
        logger.info("[GCSTATUS] Downloading direct image for Group Status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "image", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          const rawCaption = res.media?.caption || currentUnwrapped.imageMessage?.caption || "";
          const cleanMediaCaption = cleanStatusCaption(rawCaption);
          const finalCaption = cleanedTypedText || cleanMediaCaption;
          const existingThumb = res.media?.jpegThumbnail || currentUnwrapped.imageMessage?.jpegThumbnail || null;
          const thumb = await ensureJpegThumbnail(res.buffer, existingThumb, false);

          logger.info(`[GCSTATUS] Uploading image (${(res.buffer.length / 1024).toFixed(1)} KB) to WhatsApp MMG servers...`);
          const uploaded = await prepareWAMessageMedia(
            {
              image: res.buffer,
              caption: finalCaption || undefined,
              mimetype: "image/jpeg",
              jpegThumbnail: thumb || undefined,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            imageMessage: {
              ...uploaded.imageMessage,
              caption: finalCaption || undefined,
              jpegThumbnail: thumb || uploaded.imageMessage?.jpegThumbnail || undefined,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            image: res.buffer,
            caption: finalCaption || undefined,
            mimetype: "image/jpeg",
            jpegThumbnail: thumb || undefined,
          };
        }
      }
      // Direct Audio
      else if (currentUnwrapped.audioMessage) {
        detectedMediaType = "audio";
        logger.info("[GCSTATUS] Downloading direct audio for Group Status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "audio", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          logger.info("[GCSTATUS] Converting audio to WhatsApp Status Opus voice note...");
          const opusBuffer = await ensureOpusVoiceNote(res.buffer);
          const uploaded = await prepareWAMessageMedia(
            {
              audio: opusBuffer,
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            audioMessage: {
              ...uploaded.audioMessage,
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            audio: opusBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          };
        }
      }
      // Direct Document
      else if (currentUnwrapped.documentMessage) {
        detectedMediaType = "document";
        logger.info("[GCSTATUS] Downloading direct document for Group Status...");
        const res = await retrieveMediaBuffer(sock, directCandidates, "document", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          const rawCaption = res.media?.caption || currentUnwrapped.documentMessage?.caption || "";
          const finalCaption = cleanedTypedText || cleanStatusCaption(rawCaption);
          const mimetype = res.media?.mimetype || currentUnwrapped.documentMessage?.mimetype || "application/octet-stream";
          const fileName = res.media?.fileName || currentUnwrapped.documentMessage?.fileName || "attachment";

          const uploaded = await prepareWAMessageMedia(
            {
              document: res.buffer,
              caption: finalCaption || undefined,
              mimetype,
              fileName,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            documentMessage: {
              ...uploaded.documentMessage,
              caption: finalCaption || undefined,
              fileName,
              contextInfo: {
                isGroupStatus: true,
              },
            },
          };
          rawContentToPrepare = {
            document: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
            fileName,
          };
        }
      }
    }

    // ----------------------------------------------------
    // CASE B: QUOTED MEDIA (USER REPLIED TO MESSAGE)
    // ----------------------------------------------------
    if (!preparedInner && quotedMsg) {
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
        detectedMediaType = "video";
        logger.info("[GCSTATUS] Downloading quoted video for Group Status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "video", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          const origCaption =
            res.media?.caption ||
            unwrapQuoted.videoMessage?.caption ||
            unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
            cachedEntry?.caption ||
            "";
          const cleanOrigCaption = cleanStatusCaption(origCaption);
          const finalCaption = cleanedTypedText || cleanOrigCaption;
          const existingThumb =
            res.media?.jpegThumbnail ||
            unwrapQuoted.videoMessage?.jpegThumbnail ||
            cachedEntry?.content?.videoMessage?.jpegThumbnail ||
            null;
          const thumb = await ensureJpegThumbnail(res.buffer, existingThumb, true);

          logger.info(`[GCSTATUS] Uploading video (${(res.buffer.length / 1024 / 1024).toFixed(2)} MB) to WhatsApp MMG servers...`);
          const uploaded = await prepareWAMessageMedia(
            {
              video: res.buffer,
              caption: finalCaption || undefined,
              mimetype: "video/mp4",
              jpegThumbnail: thumb || undefined,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            videoMessage: {
              ...uploaded.videoMessage,
              caption: finalCaption || undefined,
              jpegThumbnail: thumb || uploaded.videoMessage?.jpegThumbnail || undefined,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            video: res.buffer,
            caption: finalCaption || undefined,
            mimetype: "video/mp4",
            jpegThumbnail: thumb || undefined,
          };
        }
      }

      // Quoted Image
      const hasQuotedImage = !preparedInner && Boolean(
        unwrapQuoted.imageMessage ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
        cachedEntry?.mediaType === "image" ||
        cachedEntry?.content?.imageMessage
      );

      if (hasQuotedImage) {
        detectedMediaType = "image";
        logger.info("[GCSTATUS] Downloading quoted image for Group Status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "image", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
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
          const thumb = await ensureJpegThumbnail(res.buffer, existingThumb, false);

          logger.info(`[GCSTATUS] Uploading image (${(res.buffer.length / 1024).toFixed(1)} KB) to WhatsApp MMG servers...`);
          const uploaded = await prepareWAMessageMedia(
            {
              image: res.buffer,
              caption: finalCaption || undefined,
              mimetype: "image/jpeg",
              jpegThumbnail: thumb || undefined,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            imageMessage: {
              ...uploaded.imageMessage,
              caption: finalCaption || undefined,
              jpegThumbnail: thumb || uploaded.imageMessage?.jpegThumbnail || undefined,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            image: res.buffer,
            caption: finalCaption || undefined,
            mimetype: "image/jpeg",
            jpegThumbnail: thumb || undefined,
          };
        }
      }

      // Quoted Audio
      const hasQuotedAudio = !preparedInner && Boolean(
        unwrapQuoted.audioMessage ||
        unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
        cachedEntry?.mediaType === "audio" ||
        cachedEntry?.content?.audioMessage
      );

      if (hasQuotedAudio) {
        detectedMediaType = "audio";
        logger.info("[GCSTATUS] Downloading quoted audio for Group Status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "audio", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          logger.info("[GCSTATUS] Converting quoted audio to WhatsApp Status Opus voice note...");
          const opusBuffer = await ensureOpusVoiceNote(res.buffer);
          const uploaded = await prepareWAMessageMedia(
            {
              audio: opusBuffer,
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            audioMessage: {
              ...uploaded.audioMessage,
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
              contextInfo: {
                isGroupStatus: true,
                statusAttributions: [
                  {
                    type: 1,
                    groupStatus: {
                      authorJid: ownJid,
                    },
                  },
                ],
              },
            },
          };
          rawContentToPrepare = {
            audio: opusBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          };
        }
      }

      // Quoted Document
      const hasQuotedDocument = !preparedInner && Boolean(
        unwrapQuoted.documentMessage ||
        unwrapQuoted.viewOnceMessage?.message?.documentMessage ||
        unwrapQuoted.viewOnceMessageV2?.message?.documentMessage ||
        cachedEntry?.mediaType === "document" ||
        cachedEntry?.content?.documentMessage
      );

      if (hasQuotedDocument) {
        detectedMediaType = "document";
        logger.info("[GCSTATUS] Downloading quoted document for Group Status...");
        const res = await retrieveMediaBuffer(sock, quotedCandidates, "document", cachedEntry);
        if (res && res.buffer && res.buffer.length > 0) {
          const origCaption = res.media?.caption || unwrapQuoted.documentMessage?.caption || "";
          const finalCaption = cleanedTypedText || cleanStatusCaption(origCaption);
          const mimetype = res.media?.mimetype || unwrapQuoted.documentMessage?.mimetype || "application/octet-stream";
          const fileName = res.media?.fileName || unwrapQuoted.documentMessage?.fileName || "attachment";

          const uploaded = await prepareWAMessageMedia(
            {
              document: res.buffer,
              caption: finalCaption || undefined,
              mimetype,
              fileName,
            },
            { upload: sock.waUploadToServer }
          );

          preparedInner = {
            documentMessage: {
              ...uploaded.documentMessage,
              caption: finalCaption || undefined,
              fileName,
              contextInfo: {
                isGroupStatus: true,
              },
            },
          };
          rawContentToPrepare = {
            document: res.buffer,
            caption: finalCaption || undefined,
            mimetype,
            fileName,
          };
        }
      }
    }

    // STRICT INTEGRITY CHECK:
    // If user attempted to send/reply to media, but media download failed:
    // NEVER fake success! Give the real, honest error!
    if (isMediaRequest && !preparedInner) {
      logger.error("[GCSTATUS] Media download failed: Empty buffer or expired on WhatsApp servers");
      if (msgKey?.id) {
        await sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
      }
      if (typeof reply === "function") {
        await reply(
          `❌ *Media Download Failed:* Could not retrieve the ${detectedMediaType || "media file"} from WhatsApp.\n\n` +
          `• *Reason:* The media stream may have expired on WhatsApp servers or was not cached in memory.\n` +
          `• *Solution:* Forward or send the ${detectedMediaType || "video/image"} directly into this chat with *.gcstatus* to post it instantly.`
        );
      }
      return;
    }

    // ----------------------------------------------------
    // CASE C: TEXT / LINK STATUS WITH RICH PREVIEW
    // ----------------------------------------------------
    if (!preparedInner) {
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

      const hasUrl = Boolean(ANY_LINK_REGEX.test(textToPost));

      if (hasUrl) {
        logger.info("[GCSTATUS] Generating rich preview banner for link status...");
        try {
          const preview = await generateRichLinkPreview(
            textToPost,
            unwrapQuoted.extendedTextMessage || cachedEntry?.content?.extendedTextMessage,
            sock
          );

          // Deliberately take 1500ms time to allow complete CDN sync and high quality rendering
          await new Promise((r) => setTimeout(r, 1500));

          if (preview && (preview.title || preview.jpegThumbnail)) {
            logger.info("[GCSTATUS] Successfully generated rich preview banner for status:", preview.title);
            preparedInner = {
              extendedTextMessage: {
                text: textToPost,
                matchedText: preview.matchedText || preview.canonicalUrl || textToPost,
                canonicalUrl: preview.canonicalUrl || preview.matchedText || textToPost,
                title: preview.title || "WhatsApp Link",
                description: preview.description || "",
                jpegThumbnail: preview.jpegThumbnail,
                thumbnailDirectPath: preview.thumbnailDirectPath,
                mediaKey: preview.mediaKey,
                mediaKeyTimestamp: preview.mediaKeyTimestamp,
                thumbnailSha256: preview.thumbnailSha256,
                thumbnailEncSha256: preview.thumbnailEncSha256,
                thumbnailHeight: preview.thumbnailHeight || 300,
                thumbnailWidth: preview.thumbnailWidth || 512,
                previewType: preview.previewType ?? 0,
                inviteLinkGroupTypeV2: preview.inviteLinkGroupTypeV2,
                inviteLinkParentGroupSubjectV2: preview.inviteLinkParentGroupSubjectV2,
                inviteLinkParentGroupThumbnailV2: preview.inviteLinkParentGroupThumbnailV2,
                contextInfo: {
                  isGroupStatus: true,
                  externalAdReply: {
                    title: preview.title || "WhatsApp Link",
                    body: preview.description || "",
                    mediaType: 1,
                    thumbnail: preview.jpegThumbnail,
                    sourceUrl: preview.matchedText || preview.canonicalUrl || textToPost,
                    renderLargerThumbnail: true,
                    showAdAttribution: true,
                  },
                },
              },
            };

            rawContentToPrepare = {
              text: textToPost,
              linkPreview: {
                "matched-text": preview.matchedText || preview.canonicalUrl || textToPost,
                title: preview.title,
                description: preview.description,
                jpegThumbnail: preview.jpegThumbnail,
                highQualityThumbnail: preview.highQualityThumbnail,
              },
              contextInfo: {
                isGroupStatus: true,
                externalAdReply: {
                  title: preview.title || "WhatsApp Link",
                  body: preview.description || "",
                  mediaType: 1,
                  thumbnail: preview.jpegThumbnail,
                  sourceUrl: preview.matchedText || preview.canonicalUrl || textToPost,
                  renderLargerThumbnail: true,
                  showAdAttribution: true,
                },
              },
            };
          }
        } catch (previewErr) {
          logger.warn("[GCSTATUS] Link preview generation notice:", previewErr.message);
        }
      }

      if (!preparedInner) {
        preparedInner = {
          extendedTextMessage: {
            text: textToPost,
            contextInfo: {
              isGroupStatus: true,
            },
          },
        };
        rawContentToPrepare = { text: textToPost };
      }
    }

    // ----------------------------------------------------
    // RESOLVE TARGET GROUPS & AUDIENCE
    // ----------------------------------------------------
    let targetGroupJids = [];
    const audienceParticipants = new Set();
    if (ownJid) {
      const normalizedOwn = jidNormalizedUser(ownJid);
      if (normalizedOwn) audienceParticipants.add(normalizedOwn);
    }

    if (isEveryone) {
      let participating = {};
      try {
        participating = await sock.groupFetchAllParticipating();
      } catch (fetchErr) {
        logger.warn("[GCSTATUS] groupFetchAllParticipating notice:", fetchErr.message);
      }

      targetGroupJids = Array.from(new Set([
        ...Object.keys(participating || {}),
        ...(isGroup(chatId) ? [chatId] : []),
      ])).filter((j) => isGroup(j));

      if (targetGroupJids.length === 0) {
        if (msgKey?.id) {
          await sock.sendMessage(chatId, { react: { text: "❓", key: msgKey } }).catch(() => {});
        }
        if (typeof reply === "function") {
          await reply("❌ *No Groups Found:* The bot is not a member of any WhatsApp groups.");
        }
        return;
      }

      for (const gId of targetGroupJids) {
        try {
          const meta = (participating && participating[gId]?.participants)
            ? participating[gId]
            : await sock.groupMetadata(gId).catch(() => null);
          if (meta?.participants) {
            for (const p of meta.participants) {
              const rawId = p?.id || p?.jid;
              if (rawId) {
                const normalized = jidNormalizedUser(rawId);
                if (normalized && normalized.endsWith("@s.whatsapp.net")) {
                  audienceParticipants.add(normalized);
                }
              }
            }
          }
        } catch {}
      }
    } else {
      if (!isGroup(chatId)) {
        if (msgKey?.id) {
          await sock.sendMessage(chatId, { react: { text: "⚠️", key: msgKey } }).catch(() => {});
        }
        if (typeof reply === "function") {
          await reply("❌ *.gcstatus* works inside a group chat. To post to all your groups from anywhere, use *.gcstatus everyone*.");
        }
        return;
      }

      targetGroupJids = [chatId];
      try {
        const meta = await sock.groupMetadata(chatId).catch(() => null) ||
                     await getSafeMetadata(sock, chatId).catch(() => null);
        if (meta?.participants) {
          for (const p of meta.participants) {
            const rawId = p?.id || p?.jid;
            if (rawId) {
              const normalized = jidNormalizedUser(rawId);
              if (normalized && normalized.endsWith("@s.whatsapp.net")) {
                audienceParticipants.add(normalized);
              }
            }
          }
        }
      } catch {}
    }

    const statusJidList = Array.from(audienceParticipants);
    if (statusJidList.length === 0) {
      if (msgKey?.id) {
        await sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
      }
      if (typeof reply === "function") {
        await reply("❌ *Audience Error:* Could not resolve any group members for the status update. Please try again.");
      }
      return;
    }

    // ----------------------------------------------------
    // PUBLISH GROUP STATUS: BROADCAST STORY & GROUP RELAY
    // ----------------------------------------------------
    logger.info(`[GCSTATUS] Publishing Group Status to ${targetGroupJids.length} group(s) with ${statusJidList.length} audience member(s)...`);

    let broadcastSuccess = false;
    let broadcastError = null;

    // 1. Primary: Broadcast story to status@broadcast with exact group audience
    try {
      const broadcastMsg = generateWAMessageFromContent(
        "status@broadcast",
        preparedInner,
        {
          userJid: ownJid,
          statusJidList,
        }
      );

      await sock.relayMessage("status@broadcast", broadcastMsg.message, {
        messageId: broadcastMsg.key.id,
        statusJidList,
      });
      broadcastSuccess = true;
      logger.info("[GCSTATUS] Successfully published status to status@broadcast!");
    } catch (bErr) {
      broadcastError = bErr;
      logger.warn("[GCSTATUS] Relay to status@broadcast error:", bErr.message);

      // Fallback: sock.sendMessage directly to status@broadcast
      try {
        await sock.sendMessage("status@broadcast", rawContentToPrepare, { statusJidList });
        broadcastSuccess = true;
        logger.info("[GCSTATUS] Fallback sendMessage to status@broadcast succeeded!");
      } catch (fallbackErr) {
        broadcastError = fallbackErr;
        logger.error("[GCSTATUS] Fallback broadcast error:", fallbackErr.message);
      }
    }

    // 2. Companion: Relay groupStatusMessageV2 to each destination group
    let groupRelaySuccess = false;
    let lastGroupError = null;

    for (const groupJid of targetGroupJids) {
      try {
        const groupStatusMsg = generateWAMessageFromContent(
          groupJid,
          {
            groupStatusMessageV2: {
              message: preparedInner,
            },
          },
          {
            userJid: ownJid,
          }
        );

        await sock.relayMessage(groupJid, groupStatusMsg.message, {
          messageId: groupStatusMsg.key.id,
        });
        groupRelaySuccess = true;
      } catch (groupRelayErr) {
        lastGroupError = groupRelayErr;
        logger.warn(`[GCSTATUS] Group status relay notice for ${groupJid}:`, groupRelayErr.message);
      }

      if (targetGroupJids.length > 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // 3. HONEST OUTCOME DETERMINATION:
    const finalSuccess = broadcastSuccess || groupRelaySuccess;

    if (finalSuccess) {
      logger.info(`[GCSTATUS] Group Status dispatch complete. (broadcast: ${broadcastSuccess}, groupRelay: ${groupRelaySuccess})`);
      if (msgKey?.id) {
        await sock.sendMessage(chatId, { react: { text: "✅", key: msgKey } }).catch(() => {});
      }
    } else {
      const errReason = broadcastError?.message || lastGroupError?.message || "WhatsApp servers rejected the status payload.";
      logger.error(`[GCSTATUS] Group Status publication failed completely: ${errReason}`);
      if (msgKey?.id) {
        await sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
      }
      if (typeof reply === "function") {
        await reply(
          `❌ *Group Status Failed:* WhatsApp servers rejected the publication.\n\n` +
          `• *Reason:* ${errReason}\n` +
          `• *Payload Type:* ${detectedMediaType || (hasUrl ? "link preview" : "text status")}\n` +
          `• *Target Audience:* ${statusJidList.length} member(s) across ${targetGroupJids.length} group(s)`
        );
      }
    }
  } catch (err) {
    logger.error("[GCSTATUS] Execution error:", err);
    if (msgKey?.id) {
      await sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
    }
    if (typeof reply === "function") {
      await reply(`❌ *Group Status Error:* ${err.message || "An unexpected error occurred."}`);
    }
  }
}
