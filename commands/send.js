import { downloadViewOnceRobust } from "../lib/media.js";
import { downloadMessageMedia, getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

const STATUS_BROADCAST_JID = "status@broadcast";

/**
 * .send command:
 * When a user directly replies to a WhatsApp Status with `.send`,
 * retrieves the exact Status (image, video, audio, document, or text)
 * and sends it directly back into the current chat (remoteJid).
 */
export default async function send({ sock, message, chatId, reply, userId = "default" }) {
  const msgKey = message.key || {};
  const content = getMessageContent(message);
  const contextInfo = Object.values(content).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  // 1. Strict Status Reply Verification
  const cachedEntry = quotedStanzaId ? getCachedIncomingMessage(userId, quotedStanzaId) : null;
  const isStatus =
    contextInfo?.remoteJid === STATUS_BROADCAST_JID ||
    message.key?.remoteJid === STATUS_BROADCAST_JID ||
    cachedEntry?.remoteJid === STATUS_BROADCAST_JID;

  if (!quotedMsg || !isStatus) {
    logger.warn("[SEND] Rejected: not a direct reply to a WhatsApp Status", {
      hasQuotedMsg: Boolean(quotedMsg),
      isStatus,
      quotedRemoteJid: contextInfo?.remoteJid,
    });
    return reply("Reply directly to a Status with .send");
  }

  const unwrapQuoted = unwrapMediaMessage(quotedMsg);
  let messagePayload = null;
  let statusType = "unknown";

  try {
    const quotedSource = {
      key: {
        remoteJid: STATUS_BROADCAST_JID,
        id: quotedStanzaId || msgKey.id,
        participant: contextInfo?.participant,
        fromMe: false,
      },
      message: quotedMsg,
    };

    // ----------------------------------------------------
    // CASE 1: IMAGE STATUS
    // ----------------------------------------------------
    const hasImage = Boolean(
      unwrapQuoted.imageMessage ||
      unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
      cachedEntry?.mediaType === "image"
    );

    if (hasImage) {
      statusType = "image";
      let imageBuffer;
      try {
        imageBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[SEND] downloadViewOnceRobust failed for image, trying downloadMessageMedia fallback", err.message);
        try {
          imageBuffer = await downloadMessageMedia(quotedSource, "image", sock);
        } catch (fbErr) {
          logger.error("[SEND] All image retrieval attempts failed", fbErr.message);
        }
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        logger.error("[SEND] Image retrieval failed: Empty buffer");
        return reply("❌ I couldn't retrieve that Status.");
      }

      const caption =
        unwrapQuoted.imageMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
        "";

      messagePayload = {
        image: imageBuffer,
        caption: caption || undefined,
      };
    }

    // ----------------------------------------------------
    // CASE 2: VIDEO STATUS
    // ----------------------------------------------------
    const hasVideo = !messagePayload && Boolean(
      unwrapQuoted.videoMessage ||
      unwrapQuoted.ptvMessage ||
      unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
      cachedEntry?.mediaType === "video"
    );

    if (hasVideo) {
      statusType = "video";
      let videoBuffer;
      try {
        videoBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[SEND] downloadViewOnceRobust failed for video, trying downloadMessageMedia fallback", err.message);
        try {
          videoBuffer = await downloadMessageMedia(quotedSource, "video", sock);
        } catch (fbErr) {
          logger.error("[SEND] All video retrieval attempts failed", fbErr.message);
        }
      }

      if (!videoBuffer || videoBuffer.length === 0) {
        logger.error("[SEND] Video retrieval failed: Empty buffer");
        return reply("❌ I couldn't retrieve that Status.");
      }

      const caption =
        unwrapQuoted.videoMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
        "";
      const mimetype = unwrapQuoted.videoMessage?.mimetype || "video/mp4";

      messagePayload = {
        video: videoBuffer,
        caption: caption || undefined,
        mimetype,
      };
    }

    // ----------------------------------------------------
    // CASE 3: AUDIO / VOICE STATUS
    // ----------------------------------------------------
    const hasAudio = !messagePayload && Boolean(
      unwrapQuoted.audioMessage ||
      unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
      cachedEntry?.mediaType === "audio"
    );

    if (hasAudio) {
      statusType = "audio";
      let audioBuffer;
      try {
        audioBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[SEND] downloadViewOnceRobust failed for audio, trying downloadMessageMedia fallback", err.message);
        try {
          audioBuffer = await downloadMessageMedia(quotedSource, "audio", sock);
        } catch (fbErr) {
          logger.error("[SEND] All audio retrieval attempts failed", fbErr.message);
        }
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        logger.error("[SEND] Audio retrieval failed: Empty buffer");
        return reply("❌ I couldn't retrieve that Status.");
      }

      const mimetype = unwrapQuoted.audioMessage?.mimetype || "audio/mp4";
      const ptt = Boolean(unwrapQuoted.audioMessage?.ptt);

      messagePayload = {
        audio: audioBuffer,
        mimetype,
        ptt,
      };
    }

    // ----------------------------------------------------
    // CASE 4: DOCUMENT / FILE STATUS
    // ----------------------------------------------------
    const hasDocument = !messagePayload && Boolean(
      unwrapQuoted.documentMessage ||
      unwrapQuoted.viewOnceMessage?.message?.documentMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.documentMessage ||
      cachedEntry?.mediaType === "document"
    );

    if (hasDocument) {
      statusType = "document";
      let docBuffer;
      try {
        docBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch (err) {
        logger.warn("[SEND] downloadViewOnceRobust failed for document, trying downloadMessageMedia fallback", err.message);
        try {
          docBuffer = await downloadMessageMedia(quotedSource, "document", sock);
        } catch (fbErr) {
          logger.error("[SEND] All document retrieval attempts failed", fbErr.message);
        }
      }

      if (!docBuffer || docBuffer.length === 0) {
        logger.error("[SEND] Document retrieval failed: Empty buffer");
        return reply("❌ I couldn't retrieve that Status.");
      }

      const caption = unwrapQuoted.documentMessage?.caption || "";
      const mimetype = unwrapQuoted.documentMessage?.mimetype || "application/octet-stream";
      const fileName = unwrapQuoted.documentMessage?.fileName || "status-file";

      messagePayload = {
        document: docBuffer,
        caption: caption || undefined,
        mimetype,
        fileName,
      };
    }

    // ----------------------------------------------------
    // CASE 5: TEXT STATUS
    // ----------------------------------------------------
    if (!messagePayload) {
      const statusText = (
        unwrapQuoted.conversation ||
        unwrapQuoted.extendedTextMessage?.text ||
        ""
      ).trim();

      if (statusText.length > 0) {
        statusType = "text";
        messagePayload = {
          text: statusText,
        };
      }
    }

    if (!messagePayload) {
      logger.error("[SEND] Status content unrecognized or retrieval yielded no data");
      return reply("❌ I couldn't retrieve that Status.");
    }

    // ----------------------------------------------------
    // SEND RETRIEVED CONTENT INTO CURRENT CHAT (chatId / remoteJid)
    // ----------------------------------------------------
    logger.info("[SEND] Sending retrieved status content to current chat", {
      chatId,
      statusType,
    });

    try {
      const sendResult = await sock.sendMessage(chatId, messagePayload);

      if (!sendResult || !sendResult.key?.id) {
        logger.error("[SEND] Send failed: No valid message key returned");
        return reply("❌ I couldn't send that Status.");
      }

      logger.info("[SEND] Successfully sent retrieved status to chat", {
        chatId,
        statusType,
        messageId: sendResult.key.id,
      });
    } catch (sendErr) {
      logger.error("[SEND] Failed to send retrieved status to chat", {
        chatId,
        statusType,
        error: sendErr.message,
      });
      return reply("❌ I couldn't send that Status.");
    }
  } catch (err) {
    logger.error("[SEND] Execution error", { error: err.message, stack: err.stack });
    return reply("❌ I couldn't retrieve that Status.");
  }
}
