import { downloadContentFromMessage, downloadMediaMessage, getContentType, jidNormalizedUser } from "@whiskeysockets/baileys";
import axios from "axios";
import { BOT_NAME, OWNER_NAME, PREFIX } from "./config.js";

export function getMessageText(message) {
  const content = getMessageContent(message);
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

export function getMessageContent(message) {
  let content = message?.message || message || {};

  for (let depth = 0; depth < 6; depth += 1) {
    const nested =
      content.ephemeralMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message;

    if (!nested) break;
    content = nested;
  }

  return content;
}

export function getContextInfo(message) {
  const content = getMessageContent(message);
  return Object.values(content).find((value) => (
    value && typeof value === "object" && value.contextInfo
  ))?.contextInfo || null;
}

export function getQuotedMessage(message) {
  const content = getMessageContent(message);
  const context = Object.values(content).find((value) => (
    value && typeof value === "object" && value.contextInfo
  ))?.contextInfo;
  if (!context?.quotedMessage) return null;

  return {
    key: {
      remoteJid: message.key.remoteJid,
      id: context.stanzaId,
      participant: context.participant,
      fromMe: false,
    },
    id: context.stanzaId,
    stanzaId: context.stanzaId,
    participant: context.participant,
    message: context.quotedMessage,
  };
}

export function unwrapMediaMessage(message) {
  return getMessageContent(message);
}

export function participantNumber(jid = "") {
  return jid.split("@")[0].split(":")[0];
}

export function extractParticipantNumber(jid = "") {
  return participantNumber(jid);
}

export function mentionText(jid) {
  return `@${participantNumber(jid)}`;
}

export function normalizeNumber(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  // Handle accidental extra 0 after country code 234 (e.g. 234080... 14 digits)
  if (digits.startsWith("2340") && digits.length === 14) {
    digits = `234${digits.slice(4)}`;
  }
  // Standard Nigerian 11-digit local format: 080..., 090..., 070..., 081..., 091..., etc.
  if (/^0\d{10}$/.test(digits)) {
    return `234${digits.slice(1)}`;
  }
  // 10-digit Nigerian number without leading 0 (e.g. 8012345678, 9012345678)
  if (/^[789]\d{9}$/.test(digits)) {
    return `234${digits}`;
  }
  return digits;
}

export function isGroup(jid = "") {
  return jid.endsWith("@g.us");
}

const SUPPORTED_PREFIXES = [".", "!", "/", "#"];
const BARE_COMMAND_KEYWORDS = new Set(["menu", "help", "ping", "alive", "open", "vv", "share", "send", "rd", "warn", "warns", "tagall", "admin", "admins", "sticker", "read", "profile", "expire", "link", "uptime"]);

export function isCommand(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SUPPORTED_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  return BARE_COMMAND_KEYWORDS.has(firstWord);
}

export function parseCommand(text) {
  const trimmed = String(text || "").trim();
  let withoutPrefix = trimmed;
  for (const p of SUPPORTED_PREFIXES) {
    if (withoutPrefix.startsWith(p)) {
      withoutPrefix = withoutPrefix.slice(p.length).trim();
      break;
    }
  }
  const [command = "", ...args] = withoutPrefix.split(/\s+/);
  return { command: command.toLowerCase(), args, text: args.join(" ") };
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function downloadMessageMedia(message, type, sock = null) {
  // 1. Try Baileys downloadMediaMessage if message structure is passed
  if (message) {
    try {
      const targetMsg = message.message ? message : { message };
      const ctx = sock ? { logger: sock.logger, reuploadRequest: sock.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : undefined } : undefined;
      const buf = await downloadMediaMessage(targetMsg, "buffer", {}, ctx);
      if (buf && buf.length > 0) {
        return buf;
      }
    } catch {
      // Continue to next fallback strategy
    }
  }

  // 2. Direct stream decryption via downloadContentFromMessage
  const content = unwrapMediaMessage(message);
  const normalizedKey = type.endsWith("Message") ? type : `${type}Message`;
  const plainKey = type.replace("Message", "");
  const media =
    content?.[normalizedKey] ||
    content?.[plainKey] ||
    content?.[type] ||
    content?.imageMessage ||
    content?.videoMessage ||
    content?.ptvMessage ||
    content?.stickerMessage ||
    content?.documentMessage;

  if (!media) throw new Error(`No supported media was found for type ${type}.`);
  const mediaStreamType = plainKey === "ptv" ? "video" : (plainKey === "sticker" ? "sticker" : (plainKey.toLowerCase() || "image"));
  try {
    return await streamToBuffer(await downloadContentFromMessage(media, mediaStreamType));
  } catch (streamErr) {
    // 3. If direct URL exists, download via HTTP
    if (media.url && typeof media.url === "string" && media.url.startsWith("http")) {
      const response = await axios.get(media.url, { responseType: "arraybuffer", timeout: 30000 });
      return Buffer.from(response.data);
    }
    throw streamErr;
  }
}

export function groupMentions(participants, message) {
  const mentions = participants.map((item) => item.id);
  return { text: `${message ? `${message}\n\n` : ""}${participants.map((item) => mentionText(item.id)).join(" ")}`, mentions };
}

export function menuText() {
  return [
    "╭━━━〔 ⚡ *SOLVATECH BOT COMMAND DIRECTORY* 〕━━━╮",
    "",
    "┃ 🛡️ *Deleted-Message Recovery:* _Personal DM_",
    "┃ 👁️ *View-Once Recovery:* _Personal DM (Owner Protected)_",
    "┃ ⚙️ *Group Cloud Sync:* _Active (Firebase Firestore)_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "╭──〔 ⚡ *CORE UTILITY* 〕──╮",
    "│",
    "│ • *.ping* — _Instant network latency and server response time_",
    "│ • *.uptime* — _Show continuous bot uptime & server telemetry_",
    "│ • *.owner* — _Official SOLVATECH BOT developer contact_",
    "│ • *.expire* — _Real-time license expiry countdown & key details_",
    "│ • *.share* — _Share SOLVATECH BOT features with friends/groups_",
    "│ • *.menu* — _Display this command directory_",
    "│ • *.link* — _Retrieve active group invite link_",
    "│ • *.groupinfo* — _Complete group metadata, creator, and admin roster_",
    "│ • *.profile* [@user] — _View WhatsApp bio, account details & group role_",
    "│",
    "╰────────────────────────────────",
    "",
    "╭──〔 📸 *MEDIA & MESSAGE RECOVERY* 〕──╮",
    "│",
    "│ • *.sticker* — _Convert photo to sticker or video to animated sticker_",
    "│ • *.antisticker* — _Convert static sticker to image or animated to video_",
    "│ • *.read* — _Extract verbatim text from image via High-Precision OCR_",
    "│ • *.open / .vv* — _Reveal view-once media privately to your personal DM_",
    "│ • *.send* — _Reply to any WhatsApp Status to extract and send into chat_",
    "│ • *.rd* — _Restore deleted message/media to your personal DM_",
    "│",
    "╰──────────────────────────────────────",
    "",
    "╭──〔 🛡️ *GROUP SECURITY & ADMIN* 〕──╮",
    "│",
    "│ • *.pin* — _Pin replied message in group (7 days)_",
    "│ • *.tagall* [msg] — _Mention all group members_",
    "│ • *.admin* / *.admins* — _Mention all group administrators_",
    "│ • *.kick* @user — _Remove participant from group_",
    "│ • *.add* <phone> — _Add new member to group with country code_",
    "│ • *.promote* @user — _Promote member to group admin_",
    "│ • *.demote* @user — _Demote group admin to member_",
    "│ • *.lock* — _Restrict group messaging to admins only_",
    "│ • *.unlock* — _Allow all members to send messages_",
    "│ • *.antilink on/off* — _Auto-remove external links with shared warnings_",
    "│ • *.antibot on/off* — _Auto-remove rogue automated bot accounts_",
    "│ • *.antistatus on/off* — _Auto-remove WhatsApp status group mentions_",
    "│ • *.autowelcome on/off* — _Auto-welcome new participants upon joining_",
    "│ • *.autogoodbye on/off* — _Auto-goodbye departing members upon leaving_",
    "│ • *.anti* — _Inspect group protections & warning threshold_",
    "│ • *.warn @user* — _Issue official warning to a member_",
    "│ • *.warns* — _Inspect member warnings & group warning limit_",
    "│ • *.clearwarns @user* — _Clear warnings for a specific member_",
    "│ • *.resetwarns* — _Reset all group member warnings to zero_",
    "│",
    "╰─────────────────────────────────────",
    "",
    "╭──〔 👑 *CONTROLLER ONLY* 〕──╮",
    "│",
    "│ • *.spam* <message> — _Send controlled repeated broadcast_",
    "│ • *.stop* — _Terminate active repeated operation immediately_",
    "│",
    "╰──────────────────────────────",
  ].join("\n");
}

export function mediaTypeFromMessage(message) {
  const content = unwrapMediaMessage(message);
  if (content?.imageMessage) return "image";
  if (content?.videoMessage || content?.ptvMessage) return "video";
  if (content?.audioMessage) return "audio";
  if (content?.documentMessage) {
    const mime = content.documentMessage.mimetype || "";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    return "document";
  }
  if (content?.stickerMessage) return "sticker";
  const type = getContentType(content);
  if (type === "imageMessage") return "image";
  if (type === "videoMessage" || type === "ptvMessage") return "video";
  if (type === "audioMessage") return "audio";
  if (type === "documentMessage") return "document";
  return null;
}

export function normalizedUser(jid) {
  return jidNormalizedUser(jid);
}

// Baileys can expose a participant as a phone JID, a LID, or a device JID
// depending on the message and the WhatsApp account. Keep all useful aliases
// so admin checks do not reject a real admin just because the two events use
// different JID forms.
export function jidAliases(jid) {
  if (!jid) return [];
  const value = String(jid);
  const aliases = new Set([value, normalizedUser(value)]);
  const [local, server = ""] = value.split("@");
  if (local) {
    aliases.add(`${local.split(":")[0]}@${server}`);
    aliases.add(local.split(":")[0]);
  }
  return [...aliases].filter(Boolean);
}

export function messageSenderJids(message, fallback = "") {
  const key = message?.key || {};
  return [
    key.participant,
    key.participantAlt,
    key.senderPn,
    message?.participant,
    message?.participantAlt,
    fallback,
  ].filter(Boolean);
}