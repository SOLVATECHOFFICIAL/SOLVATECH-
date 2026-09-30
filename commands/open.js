import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { downloadViewOnceRobust, guessViewOnceType, viewOncePayload } from "../lib/media.js";
import { getQuotedMessage, isGroup, participantNumber } from "../lib/helpers.js";
import { getCachedIncomingMessage } from "../lib/deleted-messages.js";

export default async function open({ sock, message, reply, userId = "default", chatId }) {
  // 1. Instantly delete the user's .vv / .open trigger message from the group/chat so zero trace is left!
  if (message?.key) {
    await sock.sendMessage(chatId, { delete: message.key }).catch(() => {});
  }

  const quoted = getQuotedMessage(message);
  const source = quoted || message;

  // Retrieve cached incoming message if quoted
  const quotedId = quoted?.id || quoted?.stanzaId || quoted?.key?.id;
  const cachedEntry = quotedId ? getCachedIncomingMessage(userId, quotedId) : null;

  const type = guessViewOnceType(source, cachedEntry);

  // Target for view-once delivery: ALWAYS send directly to owner's personal WhatsApp DM!
  const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : (sock.user?.phoneNumber ? `${sock.user.phoneNumber}@s.whatsapp.net` : chatId);

  if (!type) {
    await sock.sendMessage(ownerJid, {
      text: "❌ *View-Once Notice:* Please reply directly to a view-once photo, video, or audio note with *.open* (or *.vv*)."
    }).catch(() => {});
    return;
  }

  try {
    const buffer = await downloadViewOnceRobust(sock, source, cachedEntry);
    if (!buffer || buffer.length === 0) {
      await sock.sendMessage(ownerJid, {
        text: `❌ *View-Once Notice:* Could not retrieve the view-once ${type}. It may have expired on WhatsApp servers.`
      }).catch(() => {});
      return;
    }

    const payload = viewOncePayload(source, buffer, type, cachedEntry);

    // Add clean contextual header to the caption when delivering to personal DM
    const sender = quoted?.participant || source?.key?.participant || source?.participant || "";
    const senderClean = sender ? participantNumber(sender) : "";
    let contextHeader = `👁️ *VIEW-ONCE RECOVERED (Zero-Trace)*\n👤 *From:* ${senderClean ? `@${senderClean}` : "Unknown Member"}`;
    if (isGroup(chatId)) {
      try {
        const meta = await sock.groupMetadata(chatId);
        if (meta?.subject) contextHeader += `\n📍 *Source:* ${meta.subject}`;
      } catch {}
    }

    if (payload.caption) {
      payload.caption = `${contextHeader}\n💬 *Original Caption:* ${payload.caption}`;
    } else {
      payload.caption = contextHeader;
    }
    payload.mentions = [sender].filter(Boolean);

    // Send solely to the owner's personal DM with NO trace left in group
    await sock.sendMessage(ownerJid, payload);
  } catch (error) {
    await sock.sendMessage(ownerJid, {
      text: `❌ *View-Once Error:* Could not recover view-once ${type}: ${error.message || "Decryption failed"}`
    }).catch(() => {});
  }
}
