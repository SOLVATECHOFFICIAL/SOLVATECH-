import os from "node:os";

function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  parts.push(`${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`);

  return parts.join(", ");
}

export default async function uptime({ sock, reply, startedAt }) {
  const uptimeSeconds = process.uptime();
  const uptimeFormatted = formatUptime(uptimeSeconds);
  const latency = Date.now() - (startedAt || Date.now());
  const memUsedMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const isConnected = Boolean(sock?.user);
  const botNumber = sock?.user?.id?.split(":")[0]?.split("@")[0] || "Unknown";

  const lines = [
    "⏱️ *SOLVATECH BOT • LIVE UPTIME*",
    "",
    `┃ ⏳ *Continuous Uptime:* ${uptimeFormatted}`,
    `┃ 🟢 *Connection Status:* ${isConnected ? "Live Connected" : "Connecting..."}`,
    `┃ 📱 *Linked Account:* +${botNumber}`,
    `┃ 🏓 *Response Latency:* ${latency} ms`,
    `┃ 💾 *RAM Usage:* ${memUsedMb} MB`,
    `┃ 🖥️ *System:* ${os.type()} ${os.arch()}`,
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ];

  await reply(lines.join("\n"));
}
