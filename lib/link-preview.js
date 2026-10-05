import axios from "axios";
import sharp from "sharp";
import { prepareWAMessageMedia } from "@whiskeysockets/baileys";
import { getLinkPreview } from "link-preview-js";
import { logger } from "./logger.js";

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s]+/i;
const WA_GROUP_INVITE_REGEX = /chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/i;

/**
 * Generate a crisp, official-styled WhatsApp group preview card banner.
 */
async function createGroupInviteBanner(title = "WhatsApp Group", memberCount = 0) {
  const safeTitle = String(title || "WhatsApp Group")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 36);

  const safeSub = memberCount
    ? `${memberCount} participants`
    : "WhatsApp Group Invite";

  const svg = `
  <svg width="512" height="300" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0B141A"/>
        <stop offset="100%" stop-color="#111B21"/>
      </linearGradient>
      <linearGradient id="wa" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#25D366"/>
        <stop offset="100%" stop-color="#128C7E"/>
      </linearGradient>
    </defs>
    <rect width="512" height="300" fill="url(#bg)"/>
    <circle cx="256" cy="90" r="46" fill="url(#wa)"/>
    <circle cx="244" cy="80" r="10" fill="#FFFFFF"/>
    <circle cx="268" cy="80" r="10" fill="#FFFFFF"/>
    <path d="M230 110 a 14 14 0 0 1 28 0 Z" fill="#FFFFFF"/>
    <path d="M254 110 a 14 14 0 0 1 28 0 Z" fill="#FFFFFF"/>
    <text x="256" y="175" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${safeTitle}</text>
    <text x="256" y="206" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" fill="#8696A0" text-anchor="middle">${safeSub}</text>
    <rect x="176" y="232" width="160" height="38" rx="19" fill="#25D366"/>
    <text x="256" y="256" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="bold" fill="#0B141A" text-anchor="middle">JOIN GROUP</text>
  </svg>
  `;

  return await sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Generate a sleek web link preview banner when a website has no image.
 */
async function createWebLinkBanner(title = "Website Link", domain = "Web Link") {
  const safeTitle = String(title || domain)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 42);

  const safeDomain = String(domain)
    .replace(/&/g, "&amp;")
    .slice(0, 30);

  const svg = `
  <svg width="512" height="300" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0B141A"/>
        <stop offset="100%" stop-color="#182229"/>
      </linearGradient>
      <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#53BDEB"/>
        <stop offset="100%" stop-color="#00A884"/>
      </linearGradient>
    </defs>
    <rect width="512" height="300" fill="url(#bg)"/>
    <circle cx="256" cy="90" r="44" fill="url(#accent)"/>
    <!-- Globe/Link Icon -->
    <circle cx="256" cy="90" r="24" fill="none" stroke="#FFFFFF" stroke-width="3"/>
    <line x1="232" y1="90" x2="280" y2="90" stroke="#FFFFFF" stroke-width="3"/>
    <ellipse cx="256" cy="90" rx="12" ry="24" fill="none" stroke="#FFFFFF" stroke-width="3"/>
    <text x="256" y="175" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${safeTitle}</text>
    <text x="256" y="206" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" fill="#8696A0" text-anchor="middle">${safeDomain}</text>
    <rect x="186" y="232" width="140" height="36" rx="18" fill="#00A884"/>
    <text x="256" y="255" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="bold" fill="#FFFFFF" text-anchor="middle">VISIT LINK</text>
  </svg>
  `;

  return await sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Extract or generate a rich, high-quality WhatsApp link preview object for extendedTextMessage.
 *
 * @param {string} text - The text containing the URL (and optional caption)
 * @param {object|null} quotedExtendedText - Existing extendedTextMessage object from quoted message
 * @param {object|null} sock - The active Baileys socket
 * @returns {Promise<object|null>} Complete link preview object with title, description, and high-quality picture
 */
export async function generateRichLinkPreview(text = "", quotedExtendedText = null, sock = null) {
  const trimmedText = String(text || "").trim();
  const match = trimmedText.match(URL_REGEX);
  let targetUrl = match ? match[0] : "";

  // 1. If quoted message already has high-quality link preview, preserve it
  if (quotedExtendedText && (quotedExtendedText.title || quotedExtendedText.jpegThumbnail || quotedExtendedText.thumbnailDirectPath)) {
    const existingThumb = quotedExtendedText.jpegThumbnail
      ? Buffer.from(quotedExtendedText.jpegThumbnail)
      : null;

    if (existingThumb && existingThumb.length > 0) {
      return {
        text: trimmedText || quotedExtendedText.text || targetUrl,
        matchedText: quotedExtendedText.matchedText || targetUrl,
        canonicalUrl: quotedExtendedText.canonicalUrl || targetUrl,
        title: quotedExtendedText.title || "Link Preview",
        description: quotedExtendedText.description || undefined,
        jpegThumbnail: existingThumb,
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
        inviteLinkParentGroupThumbnailV2: existingThumb,
      };
    }
  }

  if (!targetUrl) {
    return null;
  }

  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  logger.info(`[LinkPreview] Deep resolving link preview for: ${targetUrl}`);

  // Helper to upload preview image to WhatsApp CDN
  const uploadThumbnailToWhatsApp = async (imageBuffer) => {
    if (!imageBuffer || !sock?.waUploadToServer) return null;
    try {
      const { imageMessage } = await prepareWAMessageMedia(
        { image: imageBuffer },
        {
          upload: sock.waUploadToServer,
          mediaTypeOverride: "thumbnail-link",
          options: { timeout: 25000 },
        }
      );
      return imageMessage || null;
    } catch (upErr) {
      logger.debug(`[LinkPreview] WhatsApp CDN upload note: ${upErr.message}`);
      return null;
    }
  };

  // --------------------------------------------------------------------------
  // 2. WHATSAPP GROUP INVITE LINKS (chat.whatsapp.com/...)
  // --------------------------------------------------------------------------
  const inviteMatch = targetUrl.match(WA_GROUP_INVITE_REGEX);
  if (inviteMatch) {
    const inviteCode = inviteMatch[1];
    let subject = "WhatsApp Group Invite";
    let desc = "WhatsApp Group • Tap to view and join";
    let size = 0;
    let groupThumb = null;
    let cdnImageMsg = null;

    if (sock && typeof sock.groupGetInviteInfo === "function") {
      try {
        logger.info(`[LinkPreview] Querying WhatsApp group invite info for code: ${inviteCode}`);
        const inviteInfo = await sock.groupGetInviteInfo(inviteCode).catch(() => null);

        if (inviteInfo) {
          subject = inviteInfo.subject || subject;
          size = inviteInfo.size || 0;
          desc = inviteInfo.desc || `WhatsApp Group · ${size} participants`;

          if (inviteInfo.id && typeof sock.profilePictureUrl === "function") {
            try {
              let ppUrl = await sock.profilePictureUrl(inviteInfo.id, "image").catch(() => null);
              if (!ppUrl) {
                ppUrl = await sock.profilePictureUrl(inviteInfo.id, "preview").catch(() => null);
              }
              if (ppUrl) {
                const ppRes = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 15000 });
                if (ppRes.data && ppRes.data.length > 0) {
                  groupThumb = await sharp(ppRes.data)
                    .resize(512, 300, { fit: "cover", position: "center" })
                    .jpeg({ quality: 88 })
                    .toBuffer();
                  cdnImageMsg = await uploadThumbnailToWhatsApp(groupThumb);
                }
              }
            } catch {}
          }
        }
      } catch (err) {
        logger.debug(`[LinkPreview] Group invite resolution error: ${err.message}`);
      }
    }

    // Ensure a rich, high-resolution group card preview picture is ALWAYS present
    if (!groupThumb) {
      groupThumb = await createGroupInviteBanner(subject, size);
      cdnImageMsg = await uploadThumbnailToWhatsApp(groupThumb);
    }

    return {
      text: trimmedText,
      matchedText: targetUrl,
      canonicalUrl: targetUrl,
      title: subject,
      description: desc,
      jpegThumbnail: groupThumb,
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
      inviteLinkParentGroupThumbnailV2: groupThumb,
    };
  }

  // --------------------------------------------------------------------------
  // 3. GENERAL WEBPAGE LINK PREVIEW (DEEP RESOLUTION)
  // --------------------------------------------------------------------------
  try {
    let title = "";
    let description = "";
    let imageUrl = "";
    let canonicalUrl = targetUrl;

    // Strategy A: link-preview-js
    try {
      const previewData = await Promise.race([
        getLinkPreview(targetUrl, {
          timeout: 18000,
          followRedirects: "follow",
          headers: {
            "User-Agent":
              "WhatsApp/2.23.20.76 A (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Preview timeout")), 19000)
        ),
      ]);

      if (previewData) {
        title = previewData.title || "";
        description = previewData.description || "";
        imageUrl = previewData.images?.[0] || "";
        canonicalUrl = previewData.url || targetUrl;
      }
    } catch {}

    // Strategy B: Deep HTML Scraper with multiple User-Agents
    if (!title || !imageUrl) {
      const userAgents = [
        "WhatsApp/2.23.20.76 A",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      ];

      for (const ua of userAgents) {
        try {
          const response = await axios.get(targetUrl, {
            timeout: 14000,
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

    let jpegThumbnail = null;
    let cdnImageMsg = null;

    if (imageUrl) {
      try {
        if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
          imageUrl = new URL(imageUrl, targetUrl).href;
        }

        const imgResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 16000,
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

    // If website has no image, generate an elegant domain banner so thumbnail is never missing
    let urlHost = "";
    try {
      urlHost = new URL(targetUrl).hostname.replace(/^www\./, "");
    } catch {
      urlHost = "Web Link";
    }

    if (!title) {
      title = urlHost;
    }

    if (!jpegThumbnail) {
      jpegThumbnail = await createWebLinkBanner(title, urlHost);
      cdnImageMsg = await uploadThumbnailToWhatsApp(jpegThumbnail);
    }

    const isVideoLink = /youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|instagram\.com\/(?:reel|tv)/i.test(
      targetUrl
    );

    return {
      text: trimmedText,
      matchedText: targetUrl,
      canonicalUrl: canonicalUrl || targetUrl,
      title: title || urlHost,
      description: description ? description.slice(0, 350) : undefined,
      jpegThumbnail,
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
    return null;
  }
}
