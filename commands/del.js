import { isGroup, jidAliases, getContextInfo, getQuotedMessage, normalizedUser } from "../lib/helpers.js";
import { getSafeMetadata } from "../lib/command-tools.js";
import { isAdmin, isBotAdmin } from "../lib/permissions.js";
import { getChatRecentMessages, removeCachedMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

/**
 * .del / .delete command
 *
 * Usage:
 *  - Reply to a message with `.del` -> Deletes that specific message.
 *    (Admins can delete any message; Non-admins can only delete their own messages).
 *  - `.del <count>` (e.g. `.del 29`) -> Deletes the last N messages from down to up (newest to oldest).
 *    (Admins delete all messages straight, including users' own; Non-admins delete only their own messages).
 *  - `.del` (no count, no reply) -> Deletes 1 message (Admin: last message; Non-admin: user's last message).
 */
export default async function del({
  sock,
  chatId,
  sender,
  senderJids = [],
  senderIsLinkedAccount = false,
  args = [],
  message,
  reply,
  userId = "default",
}) {
  const isGroupChat = isGroup(chatId);
  const metadata = isGroupChat ? await getSafeMetadata(sock, chatId).catch(() => null) : null;

  const senderAliases = new Set([
    sender,
    ...(Array.isArray(senderJids) ? senderJids : []),
    ...(message?.key?.participant ? jidAliases(message.key.participant) : []),
  ].filter(Boolean).flatMap(jidAliases));

  const senderIsAdmin = senderIsLinkedAccount || (metadata && isAdmin(metadata, [...senderAliases]));

  const botJids = [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
    sock.authState?.creds?.me?.id,
    sock.authState?.creds?.me?.lid,
  ].filter(Boolean).map(normalizedUser);

  const botIsAdmin = !isGroupChat || (metadata && isBotAdmin(metadata, botJids));

  // 1. Delete the user's .del command message itself immediately
  if (message?.key) {
    await sock.sendMessage(chatId, { delete: message.key }).catch(() => {});
  }

  // 2. Check if user replied to a specific message
  const quoted = getQuotedMessage(message, sock);
  const context = getContextInfo(message);
  const targetQuotedId = quoted?.id || quoted?.stanzaId || context?.stanzaId;

  if (targetQuotedId) {
    const quotedParticipant = quoted?.participant || context?.participant || "";
    const isOwnMessage = quoted?.fromMe || (quotedParticipant && senderAliases.has(quotedParticipant)) || jidAliases(quotedParticipant).some((a) => senderAliases.has(a));

    if (!senderIsAdmin && !isOwnMessage) {
      const notice = await reply("❌ *Permission Denied:* Only group administrators can delete messages sent by other members.").catch(() => null);
      if (notice?.key) {
        setTimeout(() => {
          sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
        }, 4000);
      }
      return;
    }

    if (isGroupChat && !isOwnMessage && !botIsAdmin) {
      const notice = await reply("⚠️ *Bot Admin Required:* The bot must be an administrator in this group to delete other members' messages.").catch(() => null);
      if (notice?.key) {
        setTimeout(() => {
          sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
        }, 4000);
      }
      return;
    }

    const deleteKey = {
      remoteJid: chatId,
      id: targetQuotedId,
      participant: quotedParticipant || sender,
      fromMe: Boolean(quoted?.fromMe || (senderIsLinkedAccount && isOwnMessage)),
    };

    let ok = false;
    try {
      await sock.sendMessage(chatId, { delete: deleteKey });
      ok = true;
    } catch {
      try {
        await sock.sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            id: targetQuotedId,
            participant: quotedParticipant,
          },
        });
        ok = true;
      } catch (err) {
        logger.debug(`Could not delete quoted message ${targetQuotedId}:`, err.message);
      }
    }

    if (ok) {
      removeCachedMessage(userId, targetQuotedId);
    }
    return;
  }

  // 3. Bulk count deletion from down to up (newest to oldest)
  let count = 1;
  const rawArg = args[0] ? parseInt(args[0], 10) : NaN;
  if (!isNaN(rawArg) && rawArg > 0) {
    count = Math.min(rawArg, 100);
  }

  // Retrieve cached messages sorted newest first ("down to up")
  const recentMessages = getChatRecentMessages(userId, chatId);

  // Exclude the .del trigger message itself
  const candidatePool = recentMessages.filter((m) => m.id !== message?.key?.id);

  let targetsToDelete = [];

  if (senderIsAdmin) {
    // Admin: delete all straight with users' own from down to up
    targetsToDelete = candidatePool.slice(0, count);
  } else {
    // Non-admin: delete only own messages from down to up
    targetsToDelete = candidatePool.filter((m) => {
      const isSender = senderAliases.has(m.sender) || jidAliases(m.sender).some((a) => senderAliases.has(a));
      const isFromMe = Boolean(m.fromMe && senderIsLinkedAccount);
      return isSender || isFromMe;
    }).slice(0, count);
  }

  if (targetsToDelete.length === 0) {
    const notice = await reply(
      senderIsAdmin
        ? "ℹ️ *No recent messages found in chat history to delete.*"
        : "ℹ️ *No recent messages found from you in chat history to delete.*"
    ).catch(() => null);

    if (notice?.key) {
      setTimeout(() => {
        sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
      }, 4000);
    }
    return;
  }

  // If sender is admin and attempting to delete messages from other participants, verify bot is admin
  const hasOtherMembersMessages = targetsToDelete.some((m) => !senderAliases.has(m.sender) && !m.fromMe);
  if (isGroupChat && hasOtherMembersMessages && !botIsAdmin) {
    const notice = await reply("⚠️ *Bot Admin Required:* The bot must be an administrator in this group to delete other members' messages.").catch(() => null);
    if (notice?.key) {
      setTimeout(() => {
        sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
      }, 4000);
    }
    return;
  }

  let deletedCount = 0;
  for (const msg of targetsToDelete) {
    try {
      await sock.sendMessage(chatId, {
        delete: {
          remoteJid: chatId,
          id: msg.id,
          participant: msg.sender,
          fromMe: Boolean(msg.fromMe),
        },
      });
      removeCachedMessage(userId, msg.id);
      deletedCount += 1;
      // Slight delay to prevent WhatsApp rate limiting
      if (targetsToDelete.length > 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (err) {
      logger.debug(`Could not delete message ${msg.id}:`, err.message);
    }
  }

  const roleLabel = senderIsAdmin ? "message(s) straight" : "of your message(s)";
  const confirmMsg = await reply(
    `🗑️ Successfully deleted *${deletedCount}* ${roleLabel} (newest to oldest).`
  ).catch(() => null);

  // Auto-clean confirm message after 4 seconds so the chat stays completely clean
  if (confirmMsg?.key) {
    setTimeout(() => {
      sock.sendMessage(chatId, { delete: confirmMsg.key }).catch(() => {});
    }, 4000);
  }
}
