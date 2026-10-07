import { normalizeNumber } from "../lib/helpers.js";
import { requireAdmin } from "../lib/command-tools.js";

export default async function add({ sock, chatId, sender, senderJids, senderIsLinkedAccount, args, reply }) {
  const metadata = await requireAdmin(sock, chatId, sender, true, senderJids, senderIsLinkedAccount);
  const number = normalizeNumber(args[0]);
  if (!number || number.length < 7) return reply("❌ Please provide a valid number with country code.");
  try {
    const res = await sock.groupParticipantsUpdate(chatId, [`${number}@s.whatsapp.net`], "add");
    const firstResult = Array.isArray(res) ? res[0] : null;
    const status = firstResult?.status ? String(firstResult.status) : "200";

    if (status === "403" || status === "408") {
      let inviteLink = "";
      try {
        const code = await sock.groupInviteCode(chatId);
        if (code) inviteLink = `\n🔗 *Invite Link:* https://chat.whatsapp.com/${code}`;
      } catch {}
      return reply(`⚠️ *Privacy Restricted:* +${number} has privacy settings preventing direct addition.${inviteLink ? `${inviteLink}\n_Forward this link to them to join._` : ""}`);
    }

    await reply(`✅ Added +${number} to the group.`);
  } catch (error) {
    let inviteLink = "";
    try {
      const code = await sock.groupInviteCode(chatId);
      if (code) inviteLink = `\n🔗 *Invite Link:* https://chat.whatsapp.com/${code}`;
    } catch {}
    return reply(`❌ Could not add +${number}. They may have group privacy restrictions enabled.${inviteLink ? `${inviteLink}\n_Share this link with them to join._` : ""}`);
  }
  return metadata;
}