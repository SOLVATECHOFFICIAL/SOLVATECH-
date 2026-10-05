import axios from "axios";
import sharp from "sharp";
import { getLinkPreview } from "link-preview-js";
import { logger } from "./logger.js";

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s]+/i;

/**
 * Extract or generate a rich WhatsApp link preview object for extendedTextMessage.
 *
 * @param {string} text - The text containing the URL (or custom caption)
 * @param {object|null} quotedExtendedText - The existing extendedTextMessage object from quoted message (if any)
 * @returns {Promise<object|null>} Link preview fields for extendedTextMessage, or null if no URL
 */
export async function generateRichLinkPreview(text = "", quotedExtendedText = null) {
  const trimmedText = String(text || "").trim();
  const match = trimmedText.match(URL_REGEX);
  let targetUrl = match ? match[0] : "";

  // 1. If quoted message already has high-quality link preview, preserve it immediately
  if (quotedExtendedText && (quotedExtendedText.title || quotedExtendedText.jpegThumbnail)) {
    const existingThumb = quotedExtendedText.jpegThumbnail
      ? Buffer.from(quotedExtendedText.jpegThumbnail)
      : null;

    return {
      text: trimmedText || quotedExtendedText.text || targetUrl,
      matchedText: quotedExtendedText.matchedText || targetUrl,
      canonicalUrl: quotedExtendedText.canonicalUrl || targetUrl,
      title: quotedExtendedText.title || undefined,
      description: quotedExtendedText.description || undefined,
      jpegThumbnail: existingThumb || undefined,
      previewType: quotedExtendedText.previewType ?? 0,
      thumbnailHeight: quotedExtendedText.thumbnailHeight || (existingThumb ? 250 : undefined),
      thumbnailWidth: quotedExtendedText.thumbnailWidth || (existingThumb ? 400 : undefined),
    };
  }

  if (!targetUrl) {
    return null;
  }

  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    logger.info(`[LinkPreview] Fetching rich link preview for: ${targetUrl}`);

    // 2. Fetch metadata via link-preview-js with 6s timeout
    const previewData = await Promise.race([
      getLinkPreview(targetUrl, {
        timeout: 6000,
        followRedirects: "follow",
        headers: {
          "User-Agent":
            "WhatsApp/2.23.20.76 A (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Link preview fetch timeout")), 6500)
      ),
    ]).catch((err) => {
      logger.debug(`[LinkPreview] Primary fetch notice: ${err?.message}`);
      return null;
    });

    let title = previewData?.title || "";
    let description = previewData?.description || "";
    let imageUrl = previewData?.images?.[0] || "";
    let canonicalUrl = previewData?.url || targetUrl;

    // 3. Fallback: Direct HTML OpenGraph parser if link-preview-js returned empty
    if (!title || !imageUrl) {
      try {
        const response = await axios.get(targetUrl, {
          timeout: 4500,
          headers: {
            "User-Agent":
              "WhatsApp/2.23.20.76 A (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          },
          maxRedirects: 5,
        });

        if (typeof response.data === "string") {
          const html = response.data;
          if (!title) {
            const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
            const twitterTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
            const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            title = ogTitle?.[1] || twitterTitle?.[1] || pageTitle?.[1] || "";
          }

          if (!description) {
            const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
            const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
            description = ogDesc?.[1] || metaDesc?.[1] || "";
          }

          if (!imageUrl) {
            const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
            const twitterImage = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
            imageUrl = ogImage?.[1] || twitterImage?.[1] || "";
          }
        }
      } catch {}
    }

    // 4. Download and optimize thumbnail image with sharp
    let jpegThumbnail = null;
    if (imageUrl) {
      try {
        if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
          imageUrl = new URL(imageUrl, targetUrl).href;
        }

        const imgResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 4500,
          headers: {
            "User-Agent": "WhatsApp/2.23.20.76 A",
          },
        });

        if (imgResponse.data && imgResponse.data.length > 0) {
          jpegThumbnail = await sharp(imgResponse.data)
            .resize(400, 250, { fit: "cover", position: "center" })
            .jpeg({ quality: 80, chromaSubsampling: "4:2:0" })
            .toBuffer();
        }
      } catch (imgErr) {
        logger.debug(`[LinkPreview] Thumbnail resize notice for ${imageUrl}: ${imgErr.message}`);
      }
    }

    const isVideoLink = /youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|instagram\.com\/(?:reel|tv)/i.test(
      targetUrl
    );

    return {
      text: trimmedText,
      matchedText: targetUrl,
      canonicalUrl: canonicalUrl || targetUrl,
      title: title || undefined,
      description: description ? description.slice(0, 300) : undefined,
      jpegThumbnail: jpegThumbnail || undefined,
      previewType: isVideoLink ? 1 : 0,
      thumbnailHeight: jpegThumbnail ? 250 : undefined,
      thumbnailWidth: jpegThumbnail ? 400 : undefined,
    };
  } catch (err) {
    logger.warn(`[LinkPreview] Error generating link preview: ${err.message}`);
    return {
      text: trimmedText,
      matchedText: targetUrl,
      canonicalUrl: targetUrl,
    };
  }
}
