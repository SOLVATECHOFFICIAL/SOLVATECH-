import { isGroup, getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";
import { downloadViewOnceRobust } from "../lib/media.js";
import { downloadMessageMedia } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

const STATUS_BROADCAST_JID = "status@broadcast";

/**
 * .status command:
 * Reply to any photo, video, audio/sound, or text in a group with `.status [optional caption]`.
 * Posts the replied content directly to WhatsApp Group Status so every member of the group
 * can view the group story update with its caption underneath.
 *
 * Strict Privacy:
 * - Only works in groups.
 * - Only the linked account owner can execute this command.
 * - Broadcasts to all group participants (members & admins alike).
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
  // 1. Group-only restriction
  if (!isGroup(chatId)) {
    return reply("❌ This command only works in groups.");
  }

  // 2. Strict Owner-Only Privacy: Only the linked bot owner can post to status
  if (!senderIsLinkedAccount) {
    return;
  }

  // 3. Extract replied message
  const msgKey = message?.key || {};
  const content = getMessageContent(message);
  const contextInfo = Object.values(content).find(
    (val) => val && typeof val === "object" && val.contextInfo
  )?.contextInfo;

  const quotedMsg = contextInfo?.quotedMessage;
  const quotedStanzaId = contextInfo?.stanzaId;

  if (!quotedMsg) {
    return reply([
      "╭━━〔 📢 *GROUP STATUS* 〕━━╮",
      "┃ 💡 *Usage:* Reply to any photo, video, audio, or text with *.status*",
      "┃ 📌 *Example:* _.status [optional new caption]_",
      "┃ 👥 *Audience:* Every member of this group can view the group status story!",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    ].join("\n"));
  }

  // Acknowledge operation immediately with hourglass reaction
  sock.sendMessage(chatId, { react: { text: "⏳", key: msgKey } }).catch(() => {});

  try {
    // 4. Fetch group roster & subject
    const groupMetadata = await sock.groupMetadata(chatId);
    const participants = groupMetadata?.participants || [];
    const statusJidList = participants
      .map((p) => p.id || p.jid || p.lid)
      .filter(Boolean);

    if (!statusJidList.length) {
      throw new Error("Could not retrieve group participant roster.");
    }

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

    // Shared Group Status ContextInfo: tags the specific group so it appears as a group status
    const statusContextInfo = {
      mentionedJid: [chatId],
      groupMentions: [
        {
          groupJid: chatId,
          groupSubject: groupMetadata?.subject || "Group",
        },
      ],
    };

    let statusPayload = null;
    let mediaType = "unknown";

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
      mediaType = "image";
      let imageBuffer;
      try {
        imageBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        imageBuffer = await downloadMessageMedia(quotedSource, "image", sock);
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error("Failed to download image buffer.");
      }

      const origCaption =
        unwrapQuoted.imageMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.imageMessage?.caption ||
        "";
      const finalCaption = customCaption || origCaption;

      statusPayload = {
        image: imageBuffer,
        caption: finalCaption || undefined,
        contextInfo: statusContextInfo,
      };
    }

    // ----------------------------------------------------
    // CASE 2: VIDEO
    // ----------------------------------------------------
    const hasVideo = !statusPayload && Boolean(
      unwrapQuoted.videoMessage ||
      unwrapQuoted.ptvMessage ||
      unwrapQuoted.viewOnceMessage?.message?.videoMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.videoMessage ||
      cachedEntry?.mediaType === "video"
    );

    if (hasVideo) {
      mediaType = "video";
      let videoBuffer;
      try {
        videoBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        videoBuffer = await downloadMessageMedia(quotedSource, "video", sock);
      }

      if (!videoBuffer || videoBuffer.length === 0) {
        throw new Error("Failed to download video buffer.");
      }

      const origCaption =
        unwrapQuoted.videoMessage?.caption ||
        unwrapQuoted.viewOnceMessage?.message?.videoMessage?.caption ||
        "";
      const finalCaption = customCaption || origCaption;
      const mimetype = unwrapQuoted.videoMessage?.mimetype || "video/mp4";

      statusPayload = {
        video: videoBuffer,
        caption: finalCaption || undefined,
        mimetype,
        contextInfo: statusContextInfo,
      };
    }

    // ----------------------------------------------------
    // CASE 3: AUDIO / VOICE NOTE
    // ----------------------------------------------------
    const hasAudio = !statusPayload && Boolean(
      unwrapQuoted.audioMessage ||
      unwrapQuoted.viewOnceMessage?.message?.audioMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.audioMessage ||
      cachedEntry?.mediaType === "audio"
    );

    if (hasAudio) {
      mediaType = "audio";
      let audioBuffer;
      try {
        audioBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        audioBuffer = await downloadMessageMedia(quotedSource, "audio", sock);
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error("Failed to download audio buffer.");
      }

      const mimetype = unwrapQuoted.audioMessage?.mimetype || "audio/mp4";
      const ptt = Boolean(unwrapQuoted.audioMessage?.ptt);

      statusPayload = {
        audio: audioBuffer,
        mimetype,
        ptt,
        contextInfo: statusContextInfo,
      };
    }

    // ----------------------------------------------------
    // CASE 4: DOCUMENT / FILE
    // ----------------------------------------------------
    const hasDocument = !statusPayload && Boolean(
      unwrapQuoted.documentMessage ||
      unwrapQuoted.viewOnceMessage?.message?.documentMessage ||
      unwrapQuoted.viewOnceMessageV2?.message?.documentMessage ||
      cachedEntry?.mediaType === "document"
    );

    if (hasDocument) {
      mediaType = "document";
      let docBuffer;
      try {
        docBuffer = await downloadViewOnceRobust(sock, quotedSource, cachedEntry);
      } catch {
        docBuffer = await downloadMessageMedia(quotedSource, "document", sock);
      }

      if (!docBuffer || docBuffer.length === 0) {
        throw new Error("Failed to download document buffer.");
      }

      const origCaption = unwrapQuoted.documentMessage?.caption || "";
      const finalCaption = customCaption || origCaption;
      const mimetype = unwrapQuoted.documentMessage?.mimetype || "application/octet-stream";
      const fileName = unwrapQuoted.documentMessage?.fileName || "status-attachment";

      statusPayload = {
        document: docBuffer,
        caption: finalCaption || undefined,
        mimetype,
        fileName,
        contextInfo: statusContextInfo,
      };
    }

    // ----------------------------------------------------
    // CASE 5: TEXT STATUS
    // ----------------------------------------------------
    if (!statusPayload) {
      const origText = (
        unwrapQuoted.conversation ||
        unwrapQuoted.extendedTextMessage?.text ||
        ""
      ).trim();

      const textToPost = customCaption || origText;
      if (!textToPost) {
        throw new Error("No media or text content found in replied message.");
      }

      mediaType = "text";
      statusPayload = {
        text: textToPost,
        contextInfo: statusContextInfo,
      };
    }

    logger.info("[GROUP_STATUS] Publishing group status update", {
      chatId,
      mediaType,
      memberCount: statusJidList.length,
      groupSubject: groupMetadata?.subject,
    });

    // 5. Send to WhatsApp Status Broadcast with group audience
    await sock.sendMessage(STATUS_BROADCAST_JID, statusPayload, {
      broadcast: true,
      statusJidList,
      backgroundColor: "#1e293b",
      font: 1,
    });

    // 6. Success reaction & confirmation
    sock.sendMessage(chatId, { react: { text: "✅", key: msgKey } }).catch(() => {});

    await reply([
      "╭━━〔 📢 *GROUP STATUS PUBLISHED* 〕━━╮",
      "┃",
      `┃ 🏷️ *Group:* ${groupMetadata?.subject || "This Group"}`,
      `┃ 👥 *Audience:* All *${statusJidList.length}* members`,
      `┃ 📁 *Content Type:* *${mediaType.toUpperCase()}*`,
      "┃ 🟢 *Status:* Live on WhatsApp Group Stories (24h)",
      "┃",
      "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
      "",
      "_Every member in this group can now view the status story on WhatsApp!_",
    ].join("\n"));
  } catch (err) {
    logger.error("[GROUP_STATUS] Failed to post group status", {
      chatId,
      error: err.message,
    });
    sock.sendMessage(chatId, { react: { text: "❌", key: msgKey } }).catch(() => {});
    return reply(`❌ *Failed to post group status:* ${err.message || "Unknown error"}`);
  }
}
