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
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedId ||
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    content.interactiveMessage?.body?.text ||
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
      content.documentWithCaptionMessage?.message ||
      content.deviceSentMessage?.message ||
      content.editedMessage?.message?.protocolMessage?.editedMessage ||
      content.ptvMessage;

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

export function getQuotedMessage(message, sock = null) {
  const content = getMessageContent(message);
  const context = Object.values(content).find((value) => (
    value && typeof value === "object" && value.contextInfo
  ))?.contextInfo;
  if (!context?.quotedMessage) return null;

  let quotedFromMe = false;
  if (sock?.user && context.participant) {
    const botJids = [
      sock.user.id,
      sock.user.lid,
      sock.user.phoneNumber,
    ].filter(Boolean);
    const botAliases = new Set(botJids.flatMap(jidAliases));
    quotedFromMe = jidAliases(context.participant).some((a) => botAliases.has(a));
  }

  return {
    key: {
      remoteJid: message.key.remoteJid,
      id: context.stanzaId,
      participant: context.participant,
      fromMe: quotedFromMe,
    },
    id: context.stanzaId,
    stanzaId: context.stanzaId,
    participant: context.participant,
    fromMe: quotedFromMe,
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
  // Standard Nigerian 11-digit local format: 070, 080, 081, 090, 091, 071...
  if (/^0(70|80|81|90|91|71)\d{8}$/.test(digits)) {
    return `234${digits.slice(1)}`;
  }
  // 10-digit Nigerian number without leading 0 (e.g. 8012345678, 9012345678)
  if (/^(70|80|81|90|91|71)\d{8}$/.test(digits)) {
    return `234${digits}`;
  }
  // If still has a leading zero and was not Nigerian, strip the leading 0 if accompanied by country code
  if (digits.startsWith("0") && digits.length > 10) {
    digits = digits.slice(1);
  }
  return digits;
}

export function isGroup(jid = "") {
  return jid.endsWith("@g.us");
}

const SUPPORTED_PREFIXES = [".", "!", "/", "#"];

const KNOWN_COMMAND_WORDS = new Set([
  "ping",
  "menu",
  "help",
  "alive",
  "ai",
  "ask",
  "gpt",
  "link",
  "tagall",
  "admin",
  "admins",
  "tagadmin",
  "sticker",
  "antisticker",
  "read",
  "open",
  "vv",
  "viewonce",
  "rd",
  "pin",
  "kick",
  "add",
  "promote",
  "demote",
  "lock",
  "unlock",
  "antilink",
  "antibot",
  "anti",
  "warn",
  "warns",
  "clearwarns",
  "clearwarn",
  "resetwarns",
  "spam",
  "stop",
  "halt",
  "cancel",
  "groupinfo",
  "uptime",
  "owner",
  "profile",
  "expire",
  "status",
  "groupstatus",
  "gcstatus",
  "gc",
  "del",
  "delete",
  "welcome",
  "goodbye",
  "share",
  "send",
]);

const COMMAND_ALIASES = {
  help: "menu",
  ask: "ai",
  gpt: "ai",
  admins: "admin",
  tagadmin: "admin",
  viewonce: "vv",
  rd: "read",
  clearwarn: "clearwarns",
  groupstatus: "status",
  gc: "gcstatus",
  delete: "del",
  antilink: "anti",
  antibot: "anti",
};

export function isCommand(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. Check prefixed commands (.menu, !ping, /ai, #tagall)
  for (const p of SUPPORTED_PREFIXES) {
    if (trimmed.startsWith(p) && trimmed.length > p.length) {
      const remainder = trimmed.slice(p.length).trim();
      const firstWord = remainder.split(/\s+/)[0]?.toLowerCase();
      if (firstWord && (/^[a-zA-Z]/.test(firstWord) || KNOWN_COMMAND_WORDS.has(firstWord))) {
        return true;
      }
    }
  }

  // 2. Check standalone word commands (menu, ping, alive, ai, help, etc.)
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (firstWord && KNOWN_COMMAND_WORDS.has(firstWord)) {
    return true;
  }

  return false;
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
  const [rawCommand = "", ...args] = withoutPrefix.split(/\s+/);
  const normalizedCmd = rawCommand.toLowerCase();
  const command = COMMAND_ALIASES[normalizedCmd] || normalizedCmd;
  return { command, args, text: args.join(" ") };
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
    "┃ 🔒 *Bot Access Mode:* _100% Private (Owner-Only)_",
    "┃ 🛡️ *Deleted-Message Recovery:* _Auto-Forwarded to Personal DM_",
    "┃ 👁️ *View-Once Recovery:* _Personal DM (Owner Protected)_",
    "┃ ⚙️ *Group Cloud Sync:* _Active (Supabase & Firebase)_",
    "",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    "╭──〔 ⚡ *CORE UTILITY* 〕──╮",
    "│",
    "│ • *.ping* — _Instant network latency and server response time_",
    "│ • *.ai* <question> — _AI assistant questions, explanations & writing_",
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
    "│ • *.gcstatus* [caption] — _Upload replied or attached media to 24h WhatsApp Status for current group_",
    "│ • *.gcstatus everyone* [caption] — _Upload to 24h WhatsApp Status for all groups you belong to_",
    "│",
    "╰──────────────────────────────────────",
    "",
    "╭──〔 🛡️ *GROUP SECURITY & ADMIN* 〕──╮",
    "│",
    "│ • *.pin* — _Pin replied message in group (7 days)_",
    "│ • *.del* [count] — _Delete last N messages (Admin: all; Member: own)_",
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