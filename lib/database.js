import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { jidAliases } from "./helpers.js";
import { logger } from "./logger.js";
import { supabaseGetById, supabaseUpsert, isSupabaseConfigured } from "./supabase.js";
import { firestoreUpsert, firestoreGetById } from "./firestore-sync.js";

const defaults = {
  antiLink: false,
  antiBot: false,
  antiStatus: false,
  welcome: false,
  goodbye: false,
  warningLimit: 3,
  warnings: {},
  lastViolations: {},
};

// Global unified cache of group rules across all sessions/phones: groupId -> settings
const globalGroupRules = new Map();
const GLOBAL_RULES_FILE = path.join(DATA_DIR, "data", "solvatech-global-group-rules.json");

// Map of userId -> { safeId: string, filePath: string, settings: Record<string, any>, loaded: boolean, writeTail: Promise<void> }
const userStores = new Map();

function normalizeGroupId(groupId = "") {
  if (!groupId) return "default@g.us";
  const str = String(groupId).trim();
  const clean = str.split("@")[0].split(":")[0];
  return clean ? `${clean}@g.us` : "default@g.us";
}

function cleanGroupDocId(groupId) {
  return String(normalizeGroupId(groupId)).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function getUserStore(userId = "default") {
  const safeId = String(userId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!userStores.has(safeId)) {
    const filePath = safeId === "default" 
      ? SETTINGS_FILE 
      : path.join(DATA_DIR, "data", `group-settings-${safeId}.json`);
    userStores.set(safeId, {
      safeId,
      filePath,
      settings: {},
      loaded: false,
      writeTail: Promise.resolve(),
    });
  }
  return userStores.get(safeId);
}

async function loadGlobalGroupRules() {
  try {
    if (fsSync.existsSync?.(GLOBAL_RULES_FILE)) {
      const raw = await fs.readFile(GLOBAL_RULES_FILE, "utf8");
      const parsed = JSON.parse(raw);
      for (const [gid, val] of Object.entries(parsed)) {
        if (val) globalGroupRules.set(normalizeGroupId(gid), val);
      }
    }
  } catch {}
}
loadGlobalGroupRules().catch(() => {});

async function ensureLoaded(userId = "default", targetGroupId = null) {
  const store = getUserStore(userId);
  if (!store.loaded) {
    // 1. Read from local JSON fallback first
    try {
      store.settings = JSON.parse(await fs.readFile(store.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") logger.error(`Could not read group settings file for user ${userId}`, error.message);
      store.settings = {};
    }

    // 2. Fetch group settings from Supabase if configured
    if (isSupabaseConfigured()) {
      try {
        const row = await supabaseGetById("group_settings", store.safeId, "safe_user_id");
        if (row && row.settings && typeof row.settings === "object") {
          store.settings = { ...store.settings, ...row.settings };
        }
      } catch (err) {
        logger.debug(`Supabase group settings fetch notice for user ${userId}:`, err.message);
      }
    }

    // Populate global group cache
    for (const [gid, s] of Object.entries(store.settings)) {
      const normGid = normalizeGroupId(gid);
      if (s && !globalGroupRules.has(normGid)) {
        globalGroupRules.set(normGid, s);
      }
    }
    store.loaded = true;
  }

  // Ensure target group is in global cache
  if (targetGroupId) {
    const normGid = normalizeGroupId(targetGroupId);
    if (!globalGroupRules.has(normGid) && isSupabaseConfigured()) {
      try {
        const ruleRow = await supabaseGetById("group_rules", normGid, "group_id");
        if (ruleRow && ruleRow.rules && typeof ruleRow.rules === "object") {
          globalGroupRules.set(normGid, ruleRow.rules);
        }
      } catch {}
    }
  }

  return store;
}

function normalized(groupId) {
  const normGid = normalizeGroupId(groupId);
  // Authoritative global group settings shared across ALL admins and bots in this group
  const stored = globalGroupRules.get(normGid) || {};

  return {
    ...defaults,
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    antiStatus: typeof stored.antiStatus === "boolean" ? stored.antiStatus : false,
    welcome: typeof stored.welcome === "boolean" ? stored.welcome : false,
    goodbye: typeof stored.goodbye === "boolean" ? stored.goodbye : false,
    warningLimit: Number(stored.warningLimit || 3),
    warnings: stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {},
    lastViolations: stored.lastViolations && typeof stored.lastViolations === "object" ? stored.lastViolations : {},
  };
}

function persist(store, groupId = null) {
  const normGid = groupId ? normalizeGroupId(groupId) : null;
  store.writeTail = store.writeTail
    .catch(() => {})
    .then(async () => {
      // 1. Write local disk backup
      try {
        await fs.mkdir(path.dirname(store.filePath), { recursive: true });
        const temp = `${store.filePath}.tmp`;
        await fs.writeFile(temp, JSON.stringify(store.settings, null, 2));
        await fs.rename(temp, store.filePath);

        // Also update global rules file
        const allRulesObj = {};
        for (const [k, v] of globalGroupRules.entries()) {
          allRulesObj[k] = v;
        }
        await fs.writeFile(GLOBAL_RULES_FILE, JSON.stringify(allRulesObj, null, 2)).catch(() => {});
      } catch (fileErr) {
        logger.warn(`Local group settings write error for user ${store.safeId}`, fileErr.message);
      }

      // 2. Sync to Firestore
      try {
        await firestoreUpsert("group_settings", store.safeId, {
          safeUserId: store.safeId,
          settings: store.settings,
          updatedAt: new Date().toISOString(),
        });
        if (normGid && globalGroupRules.has(normGid)) {
          const cleanDocId = cleanGroupDocId(normGid);
          await firestoreUpsert("group_rules", cleanDocId, {
            groupId: normGid,
            ...globalGroupRules.get(normGid),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (fsErr) {
        logger.debug(`Could not sync group settings to Firestore for user ${store.safeId}:`, fsErr.message);
      }

      // 3. Sync to Supabase if configured
      if (isSupabaseConfigured()) {
        try {
          await supabaseUpsert("group_settings", {
            safe_user_id: store.safeId,
            settings: store.settings,
            updated_at: new Date().toISOString(),
          }, "safe_user_id");

          if (normGid && globalGroupRules.has(normGid)) {
            await supabaseUpsert("group_rules", {
              group_id: normGid,
              rules: globalGroupRules.get(normGid),
              updated_at: new Date().toISOString(),
            }, "group_id");
          }
        } catch (dbErr) {
          logger.warn(`Could not sync group settings to Supabase for user ${store.safeId}:`, dbErr.message);
        }
      }
    });
  return store.writeTail;
}

export async function getGroupSettings(groupId, userId = "default") {
  const normGid = normalizeGroupId(groupId);
  await ensureLoaded(userId, normGid);
  return normalized(normGid);
}

export async function setGroupSetting(groupId, key, value, userId = "default") {
  const normGid = normalizeGroupId(groupId);
  const store = await ensureLoaded(userId, normGid);
  const current = normalized(normGid);
  const updated = { ...current, [key]: value };

  // Set universally across all bots & stores
  globalGroupRules.set(normGid, updated);
  store.settings[normGid] = updated;
  for (const s of userStores.values()) {
    if (s && s.settings) s.settings[normGid] = updated;
  }

  await persist(store, normGid);
  return updated;
}

export async function addWarning(groupId, participant, userId = "default", reason = "Group rule violation", extraAliases = []) {
  const normGid = normalizeGroupId(groupId);
  const store = await ensureLoaded(userId, normGid);
  const current = normalized(normGid);
  const allAliases = new Set([
    ...jidAliases(participant),
    ...(Array.isArray(extraAliases) ? extraAliases.flatMap(jidAliases) : []),
  ]);

  const warnings = { ...current.warnings };
  const lastViolations = { ...(current.lastViolations || {}) };

  // Consolidate any existing warnings recorded under alternate JID forms (e.g. @lid vs @s.whatsapp.net)
  let previousCount = 0;
  for (const [k, v] of Object.entries(warnings)) {
    if (allAliases.has(k) || jidAliases(k).some((a) => allAliases.has(a))) {
      previousCount = Math.max(previousCount, Number(v || 0));
      if (k !== participant) {
        delete warnings[k];
      }
    }
  }
  for (const k of Object.keys(lastViolations)) {
    if (k !== participant && (allAliases.has(k) || jidAliases(k).some((a) => allAliases.has(a)))) {
      delete lastViolations[k];
    }
  }

  const count = previousCount + 1;
  warnings[participant] = count;
  lastViolations[participant] = { reason, timestamp: Date.now() };

  const updated = { ...current, warnings, lastViolations };
  globalGroupRules.set(normGid, updated);
  store.settings[normGid] = updated;
  for (const s of userStores.values()) {
    if (s && s.settings) s.settings[normGid] = updated;
  }
  await persist(store, normGid);

  return {
    count,
    limit: current.warningLimit,
    exceeded: count >= current.warningLimit,
    reason,
  };
}

export async function clearWarning(groupId, participantOrList, userId = "default") {
  const normGid = normalizeGroupId(groupId);
  const store = await ensureLoaded(userId, normGid);
  const current = normalized(normGid);
  const targetList = Array.isArray(participantOrList) ? participantOrList : [participantOrList];
  const wantedAliases = new Set(targetList.filter(Boolean).flatMap(jidAliases));

  const warnings = { ...current.warnings };
  const lastViolations = { ...current.lastViolations };

  for (const key of Object.keys(warnings)) {
    if (wantedAliases.has(key) || jidAliases(key).some((a) => wantedAliases.has(a))) {
      delete warnings[key];
    }
  }
  for (const key of Object.keys(lastViolations)) {
    if (wantedAliases.has(key) || jidAliases(key).some((a) => wantedAliases.has(a))) {
      delete lastViolations[key];
    }
  }

  const updated = { ...current, warnings, lastViolations };
  globalGroupRules.set(normGid, updated);
  store.settings[normGid] = updated;
  for (const s of userStores.values()) {
    if (s && s.settings) s.settings[normGid] = updated;
  }
  await persist(store, normGid);
  return warnings;
}

export async function resetWarnings(groupId, userId = "default") {
  const normGid = normalizeGroupId(groupId);
  const store = await ensureLoaded(userId, normGid);
  const current = normalized(normGid);
  const updated = { ...current, warnings: {}, lastViolations: {} };
  globalGroupRules.set(normGid, updated);
  store.settings[normGid] = updated;
  for (const s of userStores.values()) {
    if (s && s.settings) s.settings[normGid] = updated;
  }
  await persist(store, normGid);
  return updated;
}

export async function setWarningLimit(groupId, limit, userId = "default") {
  const normGid = normalizeGroupId(groupId);
  const store = await ensureLoaded(userId, normGid);
  const current = normalized(normGid);
  const parsedLimit = Math.max(1, Math.min(10, Number(limit || 3)));
  const updated = { ...current, warningLimit: parsedLimit };
  globalGroupRules.set(normGid, updated);
  store.settings[normGid] = updated;
  for (const s of userStores.values()) {
    if (s && s.settings) s.settings[normGid] = updated;
  }
  await persist(store, normGid);
  return parsedLimit;
}

export async function getUserPreferences(userId = "default") {
  const store = await ensureLoaded(userId);
  const prefs = store.settings.__user_preferences || {};
  return {
    autoDeletedToDm: typeof prefs.autoDeletedToDm === "boolean" ? prefs.autoDeletedToDm : true,
    autoViewOnceToDm: typeof prefs.autoViewOnceToDm === "boolean" ? prefs.autoViewOnceToDm : true,
    autoViewStatus: typeof prefs.autoViewStatus === "boolean" ? prefs.autoViewStatus : false,
    ...prefs,
  };
}

export async function setUserPreferences(userId = "default", patch = {}) {
  const store = await ensureLoaded(userId);
  const current = store.settings.__user_preferences || {};
  store.settings.__user_preferences = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await persist(store);
  return store.settings.__user_preferences;
}
