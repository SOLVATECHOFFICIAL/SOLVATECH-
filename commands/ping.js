import os from "node:os";

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d ? `${d}d ` : ""}${h ? `${h}h ` : ""}${m}m ${s}s`;
}

export default async function ping({ sock, reply, startedAt, message }) {
  const latency = Date.now() - (startedAt || Date.now());
  const rawTimestamp = Number(message?.messageTimestamp?.low ?? message?.messageTimestamp ?? 0);
  const timestampMs = rawTimestamp > 0
    ? (rawTimestamp > 1e11 ? rawTimestamp : rawTimestamp * 1000)
    : null;
  const messageAgeMs = timestampMs === null ? null : Math.max(0, Date.now() - timestampMs);
  const memUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const uptime = formatUptime(process.uptime());
  const status = sock?.user ? "Connected 🟢" : "Connecting 🟡";

  await reply([
    "🏓 *SOLVATECH PING & STATUS*",
    `• *Bot handling:* ${latency} ms`,
    `• *Message age at bot:* ${messageAgeMs === null ? "Unknown" : `${messageAgeMs} ms`}`,
    `• *Source:* ${message?.key?.fromMe ? "Self-chat test" : "Incoming message"}`,
    `• *Status:* ${status}`,
    `• *Uptime:* ${uptime}`,
    `• *RAM:* ${memUsed} MB`,
    `• *Platform:* ${os.type()} (${os.arch()})`,
  ].join("\n"));
}