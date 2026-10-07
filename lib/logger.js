import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOG_FILE } from "./config.js";

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Proactively clean up any stale temporary files from past runs
try {
  const tmp = os.tmpdir();
  const entries = fs.readdirSync(tmp);
  for (const entry of entries) {
    if (entry.startsWith("solvatech-")) {
      try {
        fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
      } catch {}
    }
  }
} catch {}

const MAX_LOG_BYTES = 2 * 1024 * 1024; // Strictly 2MB limit so Railway disk NEVER fills
let writeCounter = 0;

function checkAndRotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_BYTES) {
      // Keep only latest 250KB of logs
      const KEEP_BYTES = 250 * 1024;
      const buffer = Buffer.alloc(KEEP_BYTES);
      const fd = fs.openSync(LOG_FILE, "r");
      const startPos = Math.max(0, stat.size - KEEP_BYTES);
      fs.readSync(fd, buffer, 0, KEEP_BYTES, startPos);
      fs.closeSync(fd);
      fs.writeFileSync(LOG_FILE, buffer);
    }
  } catch {}
}

function write(level, message, details) {
  const line = `${new Date().toISOString()} [${level}] ${message}${details ? ` ${details}` : ""}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
  if (level === "ERROR") console.error(line.trim());

  writeCounter++;
  if (writeCounter % 150 === 0) {
    checkAndRotateLog();
  }
}

export const logger = {
  debug(message, details) {
    write("DEBUG", message, details);
  },
  info(message, details) {
    write("INFO", message, details);
  },
  warn(message, details) {
    write("WARN", message, details);
  },
  error(message, details) {
    write("ERROR", message, details);
  },
};