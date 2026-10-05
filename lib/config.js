import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(rootDir, "..");

const defaultDataDir = fs.existsSync("/app/runtime") ? "/app/runtime" : (fs.existsSync("/data") ? "/data" : ROOT_DIR);
export const DATA_DIR = path.resolve(process.env.BOT_DATA_DIR || defaultDataDir);
export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
export const BOT_NAME = "SOLVATECH BOT";
export const OWNER_NAME = "SOLVATECHOFFICIAL";
export const PREFIX = ".";
export const SESSION_DIR = path.join(DATA_DIR, "sessions");
export const SETTINGS_FILE = path.join(DATA_DIR, "data", "group-settings.json");
export const LOG_FILE = path.join(DATA_DIR, "logs", "bot.log");
export const PAIRING_TTL_MS = 140 * 1000;
export const COMMAND_NAMES = [
  "ping",
  "menu",
  "link",
  "tagall",
  "admin",
  "admins",
  "tagadmin",
  "sticker",
  "antisticker",
  "read",
  "open",
  "vv",
  "rd",
  "pin",
  "kick",
  "add",
  "promote",
  "demote",
  "lock",
  "unlock",
  "antilink",
  "antibot",
  "anti",
  "warns",
  "clearwarns",
  "clearwarn",
  "resetwarns",
  "spam",
  "stop",
  "alive",
  "groupinfo",
  "uptime",
  "owner",
  "profile",
  "expire",
  "status",
  "groupstatus",
  "del",
  "delete",
];