import axios from "axios";
import sharp from "sharp";
import { prepareWAMessageMedia } from "@whiskeysockets/baileys";
import { getLinkPreview } from "link-preview-js";
import { logger } from "./logger.js";

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s]+/i;
const WA_GROUP_INVITE_REGEX = /chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/i;

/**
 * Extract or generate a rich, high-quality WhatsApp link preview object for extendedTextMessage.
 *
 * Designed to relax and thoroughly resolve the preview:
 * - Queries group invite information if it's a WhatsApp group link.
 * - Thoroughly scrapes OpenGraph, Twitter card, and meta tags.
 * - Downloads the highest resolution preview image available.
 * - Uploads the preview image directly to WhatsApp servers via waUploadToServer (so the status viewer renders the full card).
 * - Embeds thumbnail direct path, media keys, sha256 checksums, and JPEG fallback.
 *
 * @param {string} text - The text containing the URL (and optional caption)
 * @param {object|null} quotedExtendedText - The existing extendedTextMessage object from quoted message (if any)
 * @param {object|null} sock - The active Baileys socket
 * @returns {Promise<object|null>} Rich link preview fields for extendedTextMessage
 */
export async function generateRichLinkPreview(text = "", quotedExtendedText = null, sock = null) {
  const trimmedText = String(text || "").trim();
  const match = trimmedText.match(URL_REGEX);
  let targetUrl = match ? match[0] : "";

  // 1. If quoted message already has high-quality link preview, preserve it immediately
  if (quotedExtendedText && (quotedExtendedText.title || quotedExtendedText.jpegThumbnail || quotedExtendedText.thumbnailDirectPath)) {
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
      thumbnailDirectPath: quotedExtendedText.thumbnailDirectPath || undefined,
      mediaKey: quotedExtendedText.mediaKey || undefined,
      mediaKeyTimestamp: quotedExtendedText.mediaKeyTimestamp || undefined,
      thumbnailSha256: quotedExtendedText.thumbnailSha256 || undefined,
      thumbnailEncSha256: quotedExtendedText.thumbnailEncSha256 || undefined,
      thumbnailHeight: quotedExtendedText.thumbnailHeight || 300,
      thumbnailWidth: quotedExtendedText.thumbnailWidth || 512,
      previewType: quotedExtendedText.previewType ?? 0,
      inviteLinkGroupTypeV2: quotedExtendedText.inviteLinkGroupTypeV2 ?? (targetUrl.includes("chat.whatsapp.com") ? 0 : undefined),
      inviteLinkParentGroupSubjectV2: quotedExtendedText.inviteLinkParentGroupSubjectV2 || quotedExtendedText.title || undefined,
    };
  }

  if (!targetUrl) {
    return null;
  }

  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  logger.info(`[LinkPreview] Deep resolving link preview for: ${targetUrl}`);

  // Helper to upload preview image to WhatsApp CDN for crystal-clear render
  const uploadThumbnailToWhatsApp = async (imageBuffer) => {
    if (!imageBuffer || !sock?.waUploadToServer) return null;
    try {
      const { imageMessage } = await prepareWAMessageMedia(
        { image: imageBuffer },
        {
          upload: sock.waUploadToServer,
          mediaTypeOverride: "thumbnail-link",
          options: { timeout: 20000 },
        }
      );
      return imageMessage || null;
    } catch (upErr) {
      logger.debug(`[LinkPreview] WhatsApp CDN upload notice: ${upErr.message}`);
      return null;
    }
  };

  // --------------------------------------------------------------------------
  // 2. SPECIAL HANDLING FOR WHATSAPP GROUP INVITE LINKS (chat.whatsapp.com/...)
  // --------------------------------------------------------------------------
  const inviteMatch = targetUrl.match(WA_GROUP_INVITE_REGEX);
  if (inviteMatch && sock && typeof sock.groupGetInviteInfo === "function") {
    const inviteCode = inviteMatch[1];
    try {
      logger.info(`[LinkPreview] Resolving WhatsApp group invite info for code: ${inviteCode}`);
      const inviteInfo = await sock.groupGetInviteInfo(inviteCode).catch(() => null);
      if (inviteInfo) {
        let groupThumb = null;
        let cdnImageMsg = null;

        if (inviteInfo.id && typeof sock.profilePictureUrl === "function") {
          try {
            const ppUrl = await sock.profilePictureUrl(inviteInfo.id, "image").catch(() => null);
            if (ppUrl) {
              const ppRes = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 12000 });
              if (ppRes.data && ppRes.data.length > 0) {
                groupThumb = await sharp(ppRes.data)
                  .resize(512, 300, { fit: "cover", position: "center" })
                  .jpeg({ quality: 85 })
                  .toBuffer();

                cdnImageMsg = await uploadThumbnailToWhatsApp(groupThumb);
              }
            }
          } catch {}
        }

        const subject = inviteInfo.subject || "WhatsApp Group Invite";
        const desc = inviteInfo.desc || `WhatsApp Group · ${inviteInfo.size || 0} participants`;

        return {
          text: trimmedText,
          matchedText: targetUrl,
          canonicalUrl: targetUrl,
          title: subject,
          description: desc,
          jpegThumbnail: groupThumb || undefined,
          thumbnailDirectPath: cdnImageMsg?.directPath || undefined,
          mediaKey: cdnImageMsg?.mediaKey || undefined,
          mediaKeyTimestamp: cdnImageMsg?.mediaKeyTimestamp || undefined,
          thumbnailSha256: cdnImageMsg?.fileSha256 || undefined,
          thumbnailEncSha256: cdnImageMsg?.fileEncSha256 || undefined,
          thumbnailHeight: 300,
          thumbnailWidth: 512,
          previewType: 0,
          inviteLinkGroupTypeV2: 0,
          inviteLinkParentGroupSubjectV2: subject,
        };
      }
    } catch (inviteErr) {
      logger.debug(`[LinkPreview] Group invite info notice: ${inviteErr.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // 3. GENERAL WEBPAGE LINK PREVIEW (DEEP RESOLUTION)
  // --------------------------------------------------------------------------
  try {
    let title = "";
    let description = "";
    let imageUrl = "";
    let canonicalUrl = targetUrl;

    // Strategy A: link-preview-js (with generous timeout)
    try {
      const previewData = await Promise.race([
        getLinkPreview(targetUrl, {
          timeout: 15000,
          followRedirects: "follow",
          headers: {
            "User-Agent":
              "WhatsApp/2.23.20.76 A (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Preview timeout")), 16000)
        ),
      ]);

      if (previewData) {
        title = previewData.title || "";
        description = previewData.description || "";
        imageUrl = previewData.images?.[0] || "";
        canonicalUrl = previewData.url || targetUrl;
      }
    } catch (errA) {
      logger.debug(`[LinkPreview] Primary extractor notice: ${errA?.message}`);
    }

    // Strategy B: Deep HTML Scraper with multiple User-Agents if title or image missing
    if (!title || !imageUrl) {
      const userAgents = [
        "WhatsApp/2.23.20.76 A",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      ];

      for (const ua of userAgents) {
        try {
          const response = await axios.get(targetUrl, {
            timeout: 12000,
            headers: {
              "User-Agent": ua,
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            },
            maxRedirects: 8,
          });

          if (typeof response.data === "string") {
            const html = response.data;
            if (!title) {
              const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
              const twitterTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
              const tagTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
              title = ogTitle?.[1] || twitterTitle?.[1] || tagTitle?.[1] || "";
            }

            if (!description) {
              const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
              const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
              const twitterDesc = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i);
              description = ogDesc?.[1] || twitterDesc?.[1] || metaDesc?.[1] || "";
            }

            if (!imageUrl) {
              const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
              const ogImageSecure = html.match(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i);
              const twitterImage = html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i);
              const linkImage = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
              imageUrl = ogImageSecure?.[1] || ogImage?.[1] || twitterImage?.[1] || linkImage?.[1] || "";
            }

            if (title && imageUrl) break;
          }
        } catch {}
      }
    }

    // Download preview image and upload to WhatsApp CDN
    let jpegThumbnail = null;
    let cdnImageMsg = null;

    if (imageUrl) {
      try {
        if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
          imageUrl = new URL(imageUrl, targetUrl).href;
        }

        const imgResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 15000,
          headers: {
            "User-Agent": "WhatsApp/2.23.20.76 A",
          },
        });

        if (imgResponse.data && imgResponse.data.length > 0) {
          jpegThumbnail = await sharp(imgResponse.data)
            .resize(512, 300, { fit: "cover", position: "center" })
            .jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
            .toBuffer();

          cdnImageMsg = await uploadThumbnailToWhatsApp(jpegThumbnail);
        }
      } catch (imgErr) {
        logger.debug(`[LinkPreview] Image download notice for ${imageUrl}: ${imgErr.message}`);
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
      description: description ? description.slice(0, 350) : undefined,
      jpegThumbnail: jpegThumbnail || undefined,
      thumbnailDirectPath: cdnImageMsg?.directPath || undefined,
      mediaKey: cdnImageMsg?.mediaKey || undefined,
      mediaKeyTimestamp: cdnImageMsg?.mediaKeyTimestamp || undefined,
      thumbnailSha256: cdnImageMsg?.fileSha256 || undefined,
      thumbnailEncSha256: cdnImageMsg?.fileEncSha256 || undefined,
      thumbnailHeight: 300,
      thumbnailWidth: 512,
      previewType: isVideoLink ? 1 : 0,
    };
  } catch (err) {
    logger.warn(`[LinkPreview] Deep resolution error: ${err.message}`);
    return {
      text: trimmedText,
      matchedText: targetUrl,
      canonicalUrl: targetUrl,
    };
  }
}
