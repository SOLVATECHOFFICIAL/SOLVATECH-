import { isGroup, jidAliases, getContextInfo, getQuotedMessage, normalizedUser } from "../lib/helpers.js";
import { getSafeMetadata } from "../lib/command-tools.js";
import { isAdmin, isBotAdmin } from "../lib/permissions.js";
import { getChatRecentMessages, removeCachedMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

/**
 * .del / .delete command
 *
 * Lightning-fast deletion:
 *  - Reply to a message with `.del` -> Instantly deletes the replied message.
 *    (Admins can delete any message; Non-admins delete their own messages).
 *  - `.del <amount>` (e.g. `.del 10`, `.del 29`) -> Instantly deletes the last N messages from down to up.
 *    (Admins delete all messages straight including users' own; Non-admins delete only their own messages).
 *  - `.del` (no count, no reply) -> Instantly deletes 1 message.
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

  // 1. Instantly delete the user's .del command message itself (Zero-Trace)
  if (message?.key) {
    sock.sendMessage(chatId, { delete: message.key }).catch(() => {});
  }

  // 2. Reply Mode: If replied to a specific message, delete that message immediately
  const quoted = getQuotedMessage(message, sock);
  const context = getContextInfo(message);
  const targetQuotedId = quoted?.id || quoted?.stanzaId || context?.stanzaId;

  if (targetQuotedId) {
    const quotedParticipant = quoted?.participant || context?.participant || "";
    const isOwnMessage = Boolean(
      quoted?.fromMe ||
      (quotedParticipant && senderAliases.has(quotedParticipant)) ||
      jidAliases(quotedParticipant).some((a) => senderAliases.has(a))
    );

    if (!senderIsAdmin && !isOwnMessage) {
      const notice = await reply("❌ *Permission Denied:* Only group administrators can delete messages sent by other members.").catch(() => null);
      if (notice?.key) {
        setTimeout(() => {
          sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
        }, 3000);
      }
      return;
    }

    if (isGroupChat && !isOwnMessage && !botIsAdmin) {
      const notice = await reply("⚠️ *Bot Admin Required:* I must be a group admin to delete messages sent by other members.").catch(() => null);
      if (notice?.key) {
        setTimeout(() => {
          sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
        }, 3000);
      }
      return;
    }

    const deleteKey = {
      remoteJid: chatId,
      id: targetQuotedId,
      participant: quotedParticipant || sender,
      fromMe: Boolean(quoted?.fromMe || (senderIsLinkedAccount && isOwnMessage)),
    };

    removeCachedMessage(userId, targetQuotedId);

    // Instant parallel delete attempts (with & without fromMe) for light speed deletion
    await Promise.allSettled([
      sock.sendMessage(chatId, { delete: deleteKey }),
      sock.sendMessage(chatId, {
        delete: {
          remoteJid: chatId,
          id: targetQuotedId,
          participant: quotedParticipant,
        },
      }),
    ]).catch(() => {});

    return;
  }

  // 3. Count Mode: .del <amount> (e.g. .del 29)
  let count = 1;
  const rawArg = args[0] ? parseInt(args[0], 10) : NaN;
  if (!isNaN(rawArg) && rawArg > 0) {
    count = Math.min(rawArg, 100);
  }

  // Retrieve cached messages sorted newest first ("from down to up")
  // getChatRecentMessages automatically crosses / filters out any already-deleted messages!
  const recentMessages = getChatRecentMessages(userId, chatId);

  // Exclude the .del trigger message itself and any revoked/handled messages
  const candidatePool = recentMessages.filter((m) => m && m.id && m.id !== message?.key?.id);

  // Filter candidate pool according to permissions
  const eligibleCandidates = candidatePool.filter((m) => {
    if (senderIsAdmin) return true;
    const isSender = senderAliases.has(m.sender) || jidAliases(m.sender).some((a) => senderAliases.has(a));
    const isFromMe = Boolean(m.fromMe && senderIsLinkedAccount);
    return isSender || isFromMe;
  });

  if (eligibleCandidates.length === 0) {
    return;
  }

  // If sender is admin and attempting to delete messages from other participants, verify bot is admin
  const hasOtherMembersMessages = eligibleCandidates.slice(0, count).some((m) => !senderAliases.has(m.sender) && !m.fromMe);
  if (isGroupChat && hasOtherMembersMessages && !botIsAdmin) {
    const notice = await reply("⚠️ *Bot Admin Required:* I must be a group admin to delete other members' messages.").catch(() => null);
    if (notice?.key) {
      setTimeout(() => {
        sock.sendMessage(chatId, { delete: notice.key }).catch(() => {});
      }, 3000);
    }
    return;
  }

  // ULTRA-FAST STREAMLINED BATCH EXECUTION:
  // If number 3 is already deleted, skip it and continue to number 4, 5, etc. until `count` messages are deleted.
  let deletedCount = 0;
  let candidateIndex = 0;
  const BATCH_SIZE = 15;

  while (deletedCount < count && candidateIndex < eligibleCandidates.length) {
    const remainingNeeded = count - deletedCount;
    const batchCandidates = eligibleCandidates.slice(candidateIndex, candidateIndex + Math.min(BATCH_SIZE, remainingNeeded * 2));
    if (batchCandidates.length === 0) break;

    candidateIndex += batchCandidates.length;

    const results = await Promise.allSettled(
      batchCandidates.map(async (msg) => {
        removeCachedMessage(userId, msg.id);
        try {
          await sock.sendMessage(chatId, {
            delete: {
              remoteJid: chatId,
              id: msg.id,
              participant: msg.sender,
              fromMe: Boolean(msg.fromMe),
            },
          });
          return true;
        } catch {
          try {
            await sock.sendMessage(chatId, {
              delete: {
                remoteJid: chatId,
                id: msg.id,
              },
            });
            return true;
          } catch (e) {
            // Skipped or already deleted on WhatsApp — continue to next candidate
            return false;
          }
        }
      })
    );

    for (const res of results) {
      if (res.status === "fulfilled" && res.value === true) {
        deletedCount++;
        if (deletedCount >= count) break;
      }
    }
  }
}
