import fs from "node:fs";
import path from "node:path";
import { LOG_FILE } from "./config.js";

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function write(level, message, details) {
  const line = `${new Date().toISOString()} [${level}] ${message}${details ? ` ${details}` : ""}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
  if (level === "ERROR") console.error(line.trim());
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