import { getMessageContent, isGroup, jidAliases, normalizeNumber, normalizedUser } from "./helpers.js";

export async function groupContext(sock, jid) {
  if (!isGroup(jid)) throw new Error("This command only works in groups.");
  const metadata = await sock.groupMetadata(jid);
  const admins = metadata.participants.filter((item) => item.admin);
  const botJid = normalizedUser(sock.user?.id || "");
  const senderJid = normalizedUser(metadata._messageSender || "");
  return { metadata, admins, botJid, senderJid };
}

export function isAdmin(metadata, jid) {
  if (!metadata || !Array.isArray(metadata.participants)) return false;
  if (isOwner(metadata, jid)) return true;

  const rawList = Array.isArray(jid) ? jid : [jid];
  const wanted = new Set(rawList.flatMap(jidAliases));
  const wantedDigits = new Set(rawList.map((j) => String(j).split("@")[0].split(":")[0].replace(/\D/g, "")).filter(Boolean));

  return Boolean(metadata.participants.find((item) => {
    const isItemAdmin = item.admin === "admin" || item.admin === "superadmin" || item.admin === true;
    if (!isItemAdmin) return false;

    const participantAliases = [
      ...(item.id ? jidAliases(item.id) : []),
      ...(item.jid ? jidAliases(item.jid) : []),
      ...(item.lid ? jidAliases(item.lid) : []),
      ...(item.phoneNumber ? jidAliases(item.phoneNumber) : []),
    ];
    const sameUser = participantAliases.some((alias) => wanted.has(alias));
    if (sameUser) return true;

    const itemDigits = String(item.id || item.phoneNumber || "").split("@")[0].split(":")[0].replace(/\D/g, "");
    if (itemDigits && wantedDigits.has(itemDigits)) return true;

    return false;
  }));
}

export function isOwner(metadata, jid) {
  if (!metadata) return false;
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).flatMap(jidAliases));
  const owners = [
    metadata.owner,
    metadata.ownerPn,
    metadata.ownerLid,
    metadata.subjectOwner,
  ].filter(Boolean);
  return owners.some((owner) => jidAliases(owner).some((alias) => wanted.has(alias)));
}

export function isBotAdmin(metadata, botJid) {
  return isAdmin(metadata, botJid);
}

export function participantJid(metadata, jid) {
  const wanted = new Set((Array.isArray(jid) ? jid : [jid]).flatMap(jidAliases));
  const participant = metadata.participants.find((item) => {
    const aliases = [
      ...(item.id ? jidAliases(item.id) : []),
      ...(item.jid ? jidAliases(item.jid) : []),
      ...(item.lid ? jidAliases(item.lid) : []),
      ...(item.phoneNumber ? jidAliases(item.phoneNumber) : []),
    ];
    return aliases.some((alias) => wanted.has(alias));
  });
  return participant?.id || participant?.jid || participant?.lid || participant?.phoneNumber || null;
}

export function targetFromMessage(message) {
  const content = getMessageContent(message);
  const context =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo;
  const mentioned = context?.mentionedJid || [];
  return mentioned[0] || context?.participant || null;
}

export function assertAdmin(metadata, sender, botRequired = false, botJid = "") {
  if (!isAdmin(metadata, sender)) throw new Error("❌ You must be a group admin.");
  if (botRequired && !isBotAdmin(metadata, botJid)) throw new Error("❌ I need to be a group admin.");
}

export function resolveGroupTargetJids(metadata, message, args = []) {
  const content = getMessageContent(message);
  const context =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.viewOnceMessageV2?.message?.imageMessage?.contextInfo ||
    content.viewOnceMessageV2?.message?.videoMessage?.contextInfo;

  let targetCandidate = context?.participant;

  if (!targetCandidate && context?.mentionedJid?.length) {
    targetCandidate = context.mentionedJid[0];
  }

  if (!targetCandidate && Array.isArray(args)) {
    const rawMatch = args.find((a) => {
      if (typeof a !== "string") return false;
      const stripped = a.replace(/[@+\s-]/g, "");
      return stripped.length >= 7 && stripped.length <= 16 && /^\d+$/.test(stripped);
    });
    if (rawMatch) {
      const stripped = rawMatch.replace(/[@+\s-]/g, "");
      const normalized = normalizeNumber(stripped);
      if (normalized) targetCandidate = `${normalized}@s.whatsapp.net`;
    }
  }

  if (!targetCandidate) return null;

  const targetClean = String(targetCandidate).split("@")[0].split(":")[0];
  const targetDigits = targetClean.replace(/\D/g, "");
  const matchingParticipant = metadata?.participants?.find((p) => {
    const aliases = [
      p.id,
      p.jid,
      p.lid,
      p.phoneNumber,
    ].filter(Boolean);
    return aliases.some((a) => {
      if (a.includes(targetClean)) return true;
      const aDigits = String(a).split("@")[0].split(":")[0].replace(/\D/g, "");
      if (targetDigits.length >= 7 && aDigits && (aDigits === targetDigits || aDigits.endsWith(targetDigits) || targetDigits.endsWith(aDigits))) {
        return true;
      }
      return false;
    });
  });

  const canonicalJid = matchingParticipant?.id || targetCandidate;
  const mentionJid = targetCandidate;
  const allJids = matchingParticipant
    ? [matchingParticipant.id, matchingParticipant.jid, matchingParticipant.lid, matchingParticipant.phoneNumber, targetCandidate].filter(Boolean)
    : [targetCandidate];

  return {
    canonicalJid,
    mentionJid,
    allJids,
    targetClean,
  };
}

export const resolveManualWarnTarget = resolveGroupTargetJids;