import { imageToSticker, videoToSticker } from "../lib/media.js";
import { downloadMessageMedia, getQuotedMessage, mediaTypeFromMessage } from "../lib/helpers.js";
import { logger } from "../lib/logger.js";

export default async function sticker({ sock, message, chatId, reply }) {
  const targetChat = chatId || message.key.remoteJid;
  const source = getQuotedMessage(message) || message;
  const type = mediaTypeFromMessage(source);

  if (!type || (type !== "image" && type !== "video")) {
    return reply("❌ Reply to an image or video with *.sticker*.");
  }

  try {
    const buffer = await downloadMessageMedia(source, `${type}Message`, sock);
    if (!buffer || buffer.length === 0) {
      return reply("❌ Could not download the media.");
    }

    const isVideo = type === "video";
    const stickerBuffer = isVideo ? await videoToSticker(buffer) : await imageToSticker(buffer);

    await sock.sendMessage(targetChat, {
      sticker: stickerBuffer,
      isAnimated: isVideo,
    });
  } catch (error) {
    logger.error("Sticker command error", error);
    await reply(`❌ Failed to create sticker: ${error.message || "Could not process media"}`);
  }
}