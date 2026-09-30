import { addWarning, getGroupSettings, setWarningLimit } from "../lib/database.js";
import { requireAdmin } from "../lib/command-tools.js";
import { assertAdmin, isAdmin, resolveGroupTargetJids } from "../lib/permissions.js";

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
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  assertAdmin(metadata, [sender, ...(Array.isArray(senderJids) ? senderJids : [])], true, [
    sock.user?.id,
    sock.user?.lid,
    sock.user?.phoneNumber,
  ].filter(Boolean));

  const sub = String(args[0] || "").toLowerCase();
  const val = String(args[1] || "").toLowerCase();
  if (sub === "limit" || sub === "setlimit") {
    const limitNum = parseInt(val, 10);
    if (!limitNum || isNaN(limitNum) || limitNum < 1 || limitNum > 10) {
      return reply("❌ *Invalid parameter:* Please specify a valid warning limit between *1* and *10*.\n_Example: *.warn limit 3* or *.warns limit 4*_");
    }
    const newLimit = await setWarningLimit(chatId, limitNum, userId);
    return reply(`✅ *Group Warning Threshold Updated:* *${newLimit}* violations before removal.\n_Synced to Firebase Firestore._`);
  }

  const resolved = resolveGroupTargetJids(metadata, message, args);
  if (!resolved || !resolved.canonicalJid) {
    return reply("❌ *Target Missing:* Please tag or reply to the member you want to warn.\n_Usage: *.warn @user [reason]* or *.warn limit <1-10>*_");
  }

  const targetJid = resolved.canonicalJid;
  const targetClean = targetJid.split("@")[0].split(":")[0];
  const targetAliases = resolved.allJids;

  // Cannot warn admins
  if (isAdmin(metadata, targetAliases)) {
    return reply("❌ *Admin Immune:* Group administrators cannot receive warnings.");
  }

  const reason = args.filter((a) => !a.startsWith("@")).join(" ").trim() || "Violation of group rules";
  const result = await addWarning(chatId, targetJid, userId, reason);

  const mentions = [...new Set([targetJid, resolved.mentionJid].filter(Boolean))];

  if (result.exceeded) {
    try {
      await sock.groupParticipantsUpdate(chatId, [targetJid], "remove");
      return reply(
        `🚨 *Warning Threshold Exceeded:* @${targetClean} reached *${result.count}/${result.limit}* warnings and has been removed from the group.\n_Reason: ${reason}_`,
        { mentions }
      );
    } catch (err) {
      return reply(
        `⚠️ @${targetClean} reached *${result.count}/${result.limit}* warnings. (Bot could not remove: ${err.message})`,
        { mentions }
      );
    }
  }

  return reply(
    `⚠️ *Warning Issued:* @${targetClean} has been warned (*${result.count}/${result.limit}*).\n_Reason: ${reason}_\n_Reaching ${result.limit} warnings will result in removal._`,
    { mentions }
  );
}
