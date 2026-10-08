import { addWarning, clearWarning, setWarningLimit } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { isAdmin, isBotAdmin, isOwner, resolveGroupTargetJids } from "../lib/permissions.js";
import { getContextInfo, getQuotedMessage, jidAliases } from "../lib/helpers.js";
import { getChatRecentMessages, removeCachedMessage } from "../lib/deleted-messages.js";
import { logger } from "../lib/logger.js";

export default async function warn({
  sock,
  chatId,
  sender,
  senderJids,
  senderIsLinkedAccount,
  args = [],
  message,
  reply,
  userId = "default",
}) {
  const sub = String(args[0] || "").toLowerCase();
  const val = String(args[1] || "").toLowerCase();
  if (sub === "limit" || sub === "setlimit") {
    await requireAdmin(sock, chatId, sender, false, senderJids, senderIsLinkedAccount);
    const limitNum = parseInt(val, 10);
    if (!limitNum || isNaN(limitNum) || limitNum < 1 || limitNum > 10) {
      return reply("❌ *Invalid parameter:* Please specify a valid warning limit between *1* and *10*.\n_Example: *.warn limit 3* or *.warns limit 4*_");
    }
    const newLimit = await setWarningLimit(chatId, limitNum, userId);
    return reply(`✅ *Group Warning Threshold Updated:* *${newLimit}* violations before removal.\n_Synced to group cloud settings._`);
  }

  const metadata = await requireAdmin(sock, chatId, sender, false, senderJids, senderIsLinkedAccount);

  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply("❌ *Target Missing:* Please tag or reply to the member you want to warn.\n_Usage: *.warn @user [reason]* or *.warn limit <1-10>*_");
  }

  const targetJid = resolved.canonicalJid;
  const targetClean = targetJid.split("@")[0].split(":")[0];
  const targetAliases = resolved.allJids;

  // Cannot warn admins or group owner
  if (isAdmin(metadata, targetAliases) || isOwner(metadata, targetAliases)) {
    return reply("❌ *Admin Immune:* Group administrators and owners cannot receive warnings.");
  }

  // REQUIREMENT: ".warn must delete that particular thing no matter what"
  // Delete the offending message that caused the warning immediately!
  const quoted = getQuotedMessage(message, sock);
  const context = getContextInfo(message);
  const targetQuotedId = quoted?.id || quoted?.stanzaId || context?.stanzaId;
  const targetParticipant = quoted?.participant || context?.participant || targetJid;

  if (targetQuotedId) {
    removeCachedMessage(userId, targetQuotedId);
    sock.sendMessage(chatId, {
      delete: {
        remoteJid: chatId,
        id: targetQuotedId,
        participant: targetParticipant,
        fromMe: false,
      },
    }).catch(() => {});
  } else if (targetJid) {
    // If not quoted directly (e.g. .warn @user reason), delete the offender's most recent message from chat history
    try {
      const recent = getChatRecentMessages(userId, chatId);
      const targetAliasSet = new Set(targetAliases.flatMap(jidAliases));
      const targetRecentMsg = recent.find((m) => targetAliasSet.has(m.sender));
      if (targetRecentMsg) {
        removeCachedMessage(userId, targetRecentMsg.id);
        sock.sendMessage(chatId, {
          delete: {
            remoteJid: chatId,
            id: targetRecentMsg.id,
            participant: targetRecentMsg.sender,
            fromMe: Boolean(targetRecentMsg.fromMe),
          },
        }).catch(() => {});
      }
    } catch (tagErr) {
      logger.debug(`Could not delete target recent message: ${tagErr.message}`);
    }
  }

  const reason = args.filter((a) => !a.startsWith("@")).join(" ").trim() || "Violation of group rules";
  const result = await addWarning(chatId, targetJid, userId, reason, targetAliases);

  const adminClean = sender.split("@")[0].split(":")[0];
  const mentions = [...new Set([targetJid, sender, resolved.mentionJid].filter(Boolean))];

  // REQUIREMENT: "Also the second one .warn not deleting the warn message"
  // Keep the warning announcement visible in the group chat permanently (no auto-deletion).
  if (result.exceeded) {
    const botJids = [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber,
    ].filter(Boolean);

    if (!isBotAdmin(metadata, botJids)) {
      return reply(
        `⚠️ @${targetClean} reached *${result.count}/${result.limit}* warnings, but the bot is not a group admin to remove them.\n_Issued on behalf of Admin: @${adminClean}_`,
        { mentions }
      );
    }

    try {
      await sock.groupParticipantsUpdate(chatId, [targetJid], "remove");
      await clearWarning(chatId, targetAliases, userId);
      return reply(
        `🚨 *Warning Threshold Exceeded:* @${targetClean} reached *${result.count}/${result.limit}* warnings and has been removed from the group.\n_Action enforced on behalf of Admin: @${adminClean}_\n_Reason: ${reason}_`,
        { mentions }
      );
    } catch (err) {
      return reply(
        `⚠️ @${targetClean} reached *${result.count}/${result.limit}* warnings. (Bot could not remove: ${err.message})\n_Issued on behalf of Admin: @${adminClean}_`,
        { mentions }
      );
    }
  }

  return reply(
    `👮‍♂️ *Admin Warning Issued:* @${targetClean} has been warned (*${result.count}/${result.limit}*).\n_Issued by Admin: @${adminClean}_\n_Reason: ${reason}_\n_Offending message deleted._\n_Reaching ${result.limit} warnings will result in removal from the group._`,
    { mentions }
  );
}
