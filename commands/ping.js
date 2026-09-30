import os from "node:os";

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d ? `${d}d ` : ""}${h ? `${h}h ` : ""}${m}m ${s}s`;
}

export default async function ping({ sock, reply, startedAt }) {
  const latency = Date.now() - (startedAt || Date.now());
  const memUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const uptime = formatUptime(process.uptime());
  const status = sock?.user ? "Connected 🟢" : "Connecting 🟡";

  await reply([
    "🏓 *SOLVATECH PING & STATUS*",
    `• *Latency:* ${latency} ms`,
    `• *Status:* ${status}`,
    `• *Uptime:* ${uptime}`,
    `• *RAM:* ${memUsed} MB`,
    `• *Platform:* ${os.type()} (${os.arch()})`,
  ].join("\n"));
}