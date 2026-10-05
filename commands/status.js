import { generateWAMessageContent, proto } from "@whiskeysockets/baileys";
import { isGroup, getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";
import { downloadViewOnceRobust } from "../lib/media.js";
import { downloadMessageMedia } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";
import { generateRichLinkPreview } from "../lib/link-preview.js";
import { logger } from "../lib/logger.js";

/**
 * .status command:
 * Reply to any photo, video, audio, link, or text in a group with `.status [optional caption]`.
 * Posts the content directly as that group's Group Status update (group story).
 *
 * Requirements:
 * - Only works in groups.
 * - Only the linked owner can trigger it.
 * - NEVER posts to personal status (never uses status@broadcast).
 * - Full Link Previews: When replying to a link, waits to generate and attach rich preview
 *   cards (title, description, and high-quality image thumbnail) so it shows properly.
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
  // 1. Group-only & Owner-only
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

    const quotedSource = {
      key: {
        remoteJid: chatId,
        id: quotedStanzaId || msgKey.id,
        participant: contextInfo?.participant,
        fromMe: false,
      },
      message: quotedMsg,
    };

    let mediaPayload = null;

    // ----------------------------------------------------
    // CASE 1: IMAGE
    // ----------------------------------------------------
    const hasImage = Boolean(
      unwrapQuoted.imageMessage ||
      unwrapQuoted.viewOnceMessage?.message?.imageMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.imageMessage ||
      cachedEntry?.mediaType === "image"
    );

    if (hasImage) {
      let imageBuffer;
      try {
        imageBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        imageBuffer = await downloadMessageMedia(quotedSource, "image", sock);
      }

      if (imageBuffer && imageBuffer.length > 0) {
        const origCaption =
          unwrapQuoted.imageMessage?.caption ||
          unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
          "";
        const finalCaption = customCaption || origCaption;

        mediaPayload = {
          image: imageBuffer,
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
      cachedEntry?.mediaType === "video"
    );

    if (hasVideo) {
      let videoBuffer;
      try {
        videoBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        videoBuffer = await downloadMessageMedia(quotedSource, "video", sock);
      }

      if (videoBuffer && videoBuffer.length > 0) {
        const origCaption =
          unwrapQuoted.videoMessage?.caption ||
          unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
          "";
        const finalCaption = customCaption || origCaption;
        const mimetype = unwrapQuoted.videoMessage?.mimetype || "video/mp4";

        mediaPayload = {
          video: videoBuffer,
          caption: finalCaption || undefined,
          mimetype,
        };
      }
    }

    // ----------------------------------------------------
    // CASE 3: AUDIO / VOICE NOTE
    // ----------------------------------------------------
    const hasAudio = !mediaPayload && Boolean(
      unwrapQuoted.audioMessage ||
      unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
      cachedEntry?.mediaType === "audio"
    );

    if (hasAudio) {
      let audioBuffer;
      try {
        audioBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        audioBuffer = await downloadMessageMedia(quotedSource, "audio", sock);
      }

      if (audioBuffer && audioBuffer.length > 0) {
        const mimetype = unwrapQuoted.audioMessage?.mimetype || "audio/mp4";
        const ptt = Boolean(unwrapQuoted.audioMessage?.ptt);

        mediaPayload = {
          audio: audioBuffer,
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
      cachedEntry?.mediaType === "document"
    );

    if (hasDocument) {
      let docBuffer;
      try {
        docBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        docBuffer = await downloadMessageMedia(quotedSource, "document", sock);
      }

      if (docBuffer && docBuffer.length > 0) {
        const origCaption = unwrapQuoted.documentMessage?.caption || "";
        const finalCaption = customCaption || origCaption;
        const mimetype = unwrapQuoted.documentMessage?.mimetype || "application/octet-stream";
        const fileName = unwrapQuoted.documentMessage?.fileName || "status-attachment";

        mediaPayload = {
          document: docBuffer,
          caption: finalCaption || undefined,
          mimetype,
          fileName,
        };
      }
    }

    // ----------------------------------------------------
    // CASE 5: LINK OR TEXT STATUS
    // ----------------------------------------------------
    if (!mediaPayload) {
      const origText = (
        unwrapQuoted.conversation ||
        unwrapQuoted.extendedTextMessage?.text ||
        ""
      ).trim();

      const textToPost = customCaption || origText;
      if (!textToPost) {
        return;
      }

      // Check if text contains a URL and generate rich link preview
      const richPreview = await generateRichLinkPreview(
        textToPost,
        unwrapQuoted.extendedTextMessage
      );

      if (richPreview) {
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

        logger.info("[GROUP_STATUS] Relaying group status with rich link preview", {
          chatId,
          title: richPreview.title,
          hasThumb: Boolean(richPreview.jpegThumbnail),
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

    logger.info("[GROUP_STATUS] Relaying group status directly to group", { chatId });

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
