import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { downloadMessageMedia, getQuotedMessage, mediaTypeFromMessage, unwrapMediaMessage } from "../lib/helpers.js";
import { logger } from "../lib/logger.js";

let cachedClient = null;
let cachedKey = null;

function getApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_KEY ||
    ""
  ).trim();
}

function getAIClient() {
  const apiKey = getApiKey();

  if (apiKey) {
    if (!cachedClient || cachedKey !== apiKey) {
      cachedClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
      cachedKey = apiKey;
    }
    return cachedClient;
  }

  // If credentials are supplied via GOOGLE_APPLICATION_CREDENTIALS
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
    if (credsPath.startsWith("{")) {
      try {
        const credentials = JSON.parse(credsPath);
        return new GoogleGenAI({
          googleAuthOptions: { credentials },
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      } catch (err) {
        logger.warn("Could not parse GOOGLE_APPLICATION_CREDENTIALS as JSON", err.message);
      }
    } else {
      return new GoogleGenAI({
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
    }
  }

  throw new Error(
    "Gemini API key is missing. Please set GEMINI_API_KEY in your Railway environment variables (Project Settings > Variables)."
  );
}

const OCR_MODELS = ["gemini-2.5-flash", "gemini-3.7-flash", "gemini-3.8-flash"];

export default async function read({ sock, message, reply }) {
  const source = getQuotedMessage(message) || message;
  const content = unwrapMediaMessage(source);
  const type = mediaTypeFromMessage(source);

  const isImage = type === "image" || Boolean(content.imageMessage) || content.documentMessage?.mimetype?.startsWith("image/");
  if (!isImage) {
    return reply("❌ Reply to an image or send an image with *.read* to extract its text.");
  }

  try {
    const buffer = await downloadMessageMedia(source, "imageMessage", sock);
    if (!buffer || buffer.length === 0) {
      return reply("❌ Could not download the image media for text extraction.");
    }

    let imageBuffer = buffer;
    try {
      imageBuffer = await sharp(buffer)
        .rotate()
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (sharpErr) {
      logger.warn("Sharp could not re-encode image, using raw buffer", sharpErr.message);
      imageBuffer = buffer;
    }

    const ai = getAIClient();
    let extractedText = "";
    let lastError = null;

    for (const model of OCR_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: imageBuffer.toString("base64"),
              },
            },
            {
              text: "Extract and transcribe all visible text from this image VERBATIM without translating, summarizing, correcting, or adding commentary. Return ONLY the exact transcribed text as it appears in the image. If there is no visible text in the image, reply with: [NO TEXT DETECTED IN IMAGE]",
            },
          ],
        });

        extractedText = (response.text || "").trim();
        if (extractedText) break;
      } catch (err) {
        lastError = err;
        logger.warn(`OCR model ${model} failed, trying next`, err.message);
      }
    }

    if (!extractedText && lastError) {
      throw lastError;
    }

    if (!extractedText || extractedText === "[NO TEXT DETECTED IN IMAGE]") {
      return reply("🔍 *OCR Result:* No readable text was detected in this image.");
    }

    await reply([
      "📖 *VERBATIM OCR EXTRACTED TEXT*",
      "────────────────────────────",
      extractedText,
    ].join("\n"));
  } catch (error) {
    logger.error("OCR extraction failed", error);
    await reply(`❌ OCR extraction failed: ${error.message || "Failed to process image"}`);
  }
}
