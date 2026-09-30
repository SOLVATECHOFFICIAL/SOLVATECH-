import { getDeletedMessageForRestore, ensureMediaDownloaded } from "../lib/deleted-messages.js";
import { getMessageContent, unwrapMediaMessage } from "../lib/helpers.js";

export default async function rd({ sock, message, chatId, sender, reply, userId = "default" }) {
  // Check if user quoted an alert or a message
  const content = getMessageContent(message);
  const context = Object.values(content).find((v) => v && typeof v === "object" && v.contextInfo)?.contextInfo;
  const quotedStanzaId = context?.stanzaId || null;

  const deletedRecord = getDeletedMessageForRestore(userId, chatId, quotedStanzaId);

  if (!deletedRecord) {
    return reply("ℹ️ No deleted messages found in the 24-hour cache for this chat. (Messages must be observed before deletion to be cached).");
  }

  // Download media buffer on demand if available
  if (deletedRecord.mediaType && !deletedRecord.mediaBuffer) {
    await ensureMediaDownloaded(deletedRecord, sock);
  }

  const senderNumber = (deletedRecord.sender || "").split("@")[0].split(":")[0];
  const timeStr = new Date(deletedRecord.originalTimestamp).toLocaleString();

  // If deleted record has media buffer
  if (deletedRecord.mediaBuffer && deletedRecord.mediaType) {
    const rawContent = unwrapMediaMessage(deletedRecord.rawMessage || {});
    const captionHeader = [
      `♻️ *[RESTORED DELETED ${deletedRecord.mediaType.toUpperCase()}]*`,
      `👤 *Sender:* @${senderNumber}`,
      `⏱️ *Sent At:* ${timeStr}`,
    ].join("\n");

    if (deletedRecord.mediaType === "image") {
      return await sock.sendMessage(chatId, {
        image: deletedRecord.mediaBuffer,
        caption: `${captionHeader}\n${deletedRecord.text ? `💬 *Caption:* ${deletedRecord.text}` : ""}`,
        mentions: [deletedRecord.sender].filter(Boolean),
      });
    }

    if (deletedRecord.mediaType === "video") {
      return await sock.sendMessage(chatId, {
        video: deletedRecord.mediaBuffer,
        caption: `${captionHeader}\n${deletedRecord.text ? `💬 *Caption:* ${deletedRecord.text}` : ""}`,
        mentions: [deletedRecord.sender].filter(Boolean),
      });
    }

    if (deletedRecord.mediaType === "audio") {
      return await sock.sendMessage(chatId, {
        audio: deletedRecord.mediaBuffer,
        mimetype: rawContent.audioMessage?.mimetype || "audio/ogg; codecs=opus",
        ptt: Boolean(rawContent.audioMessage?.ptt),
      });
    }

    if (deletedRecord.mediaType === "sticker") {
      return await sock.sendMessage(chatId, {
        sticker: deletedRecord.mediaBuffer,
      });
    }

    if (deletedRecord.mediaType === "document") {
      return await sock.sendMessage(chatId, {
        document: deletedRecord.mediaBuffer,
        mimetype: rawContent.documentMessage?.mimetype || "application/octet-stream",
        fileName: rawContent.documentMessage?.fileName || "restored-file",
        caption: captionHeader,
        mentions: [deletedRecord.sender].filter(Boolean),
      });
    }
  }

  // If text message
  if (deletedRecord.text) {
    return await reply([
      "♻️ *[RESTORED DELETED MESSAGE]*",
      `👤 *Sender:* @${senderNumber}`,
      `⏱️ *Original Time:* ${timeStr}`,
      "────────────────────────────",
      `💬 *Message:*`,
      deletedRecord.text,
    ].join("\n"), {
      mentions: [deletedRecord.sender].filter(Boolean),
    });
  }

  return reply("ℹ️ The deleted message was detected, but no recoverable text or media payload could be extracted.");
}
