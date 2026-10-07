import sharp from "sharp";
import { stickerToImage, stickerToVideo } from "../lib/media.js";
import { downloadMessageMedia, getQuotedMessage, unwrapMediaMessage } from "../lib/helpers.js";
import { logger } from "../lib/logger.js";
import anti from "./anti.js";

export default async function antisticker(props) {
  const { sock, message, chatId, reply, args = [] } = props;
  const first = String(args[0] || "").toLowerCase();

  // If user passes "on", "off", "limit", or "status", route directly to anti-sticker protection toggle
  if (first === "on" || first === "off" || first === "limit" || first === "status" || first === "setlimit") {
    return anti({
      ...props,
      command: "antisticker",
    });
  }

  const source = getQuotedMessage(message) || message;
  const content = unwrapMediaMessage(source);

  if (!content.stickerMessage) {
    return reply(
      "❌ Reply to a sticker with *.antisticker* to convert it to an image/video, or use *.antisticker on/off* to toggle protection."
    );
  }

  try {
    const targetChat = chatId || message.key.remoteJid;
    const buffer = await downloadMessageMedia(source, "stickerMessage", sock);
    if (!buffer || buffer.length === 0) {
      return reply("❌ Could not download the sticker media.");
    }

    // Comprehensive animated sticker detection
    let isAnimated = Boolean(content.stickerMessage.isAnimated);
    if (!isAnimated) {
      try {
        const meta = await sharp(buffer, { animated: true }).metadata();
        if (meta.pages && meta.pages > 1) {
          isAnimated = true;
        }
      } catch {}
    }
    if (!isAnimated && (buffer.includes(Buffer.from("ANIM")) || buffer.includes(Buffer.from("ANMF")))) {
      isAnimated = true;
    }

    if (isAnimated) {
      try {
        const videoBuffer = await stickerToVideo(buffer);
        if (videoBuffer && videoBuffer.length > 0) {
          return await sock.sendMessage(targetChat, {
            video: videoBuffer,
            mimetype: "video/mp4",
            gifPlayback: true,
            caption: "✨ Animated sticker converted to video.",
          });
        }
      } catch (animErr) {
        logger.warn("Animated sticker to video conversion failed, falling back to static image", animErr.message);
      }
    }

    // Static sticker (or fallback) -> PNG image
    const imageBuffer = await stickerToImage(buffer);
    await sock.sendMessage(targetChat, {
      image: imageBuffer,
      mimetype: "image/png",
      caption: "✨ Sticker converted to picture.",
    });
  } catch (error) {
    logger.error("Antisticker command error", error);
    await reply(`❌ Failed to convert sticker: ${error.message || "Unknown error"}`);
  }
}
