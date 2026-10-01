import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";

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

// Global cache of group rules across all sessions/phones: groupId -> settings
const globalGroupRules = new Map();
const GLOBAL_RULES_FILE = path.join(DATA_DIR, "data", "solvatech-global-group-rules.json");

// Map of userId -> { safeId: string, filePath: string, settings: Record<string, any>, loaded: boolean, writeTail: Promise<void> }
const userStores = new Map();

function cleanGroupDocId(groupId) {
  return String(groupId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
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
        if (val) globalGroupRules.set(gid, val);
      }
    }
  } catch {}
}
loadGlobalGroupRules().catch(() => {});

async function ensureLoaded(userId = "default") {
  const store = getUserStore(userId);
  if (store.loaded) return store;

  // 1. Try reading from local JSON fallback first
  try {
    store.settings = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") logger.error(`Could not read group settings file for user ${userId}`, error.message);
    store.settings = {};
  }

  // 2. Fetch authoritative group settings from Firestore if available with timeout guard
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const doFetch = async () => {
        const { doc, getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "group_settings", store.safeId));
        if (docSnap.exists()) {
          const firestoreData = docSnap.data() || {};
          // Merge Firestore data over local JSON data (Firestore is source of truth)
          store.settings = { ...store.settings, ...firestoreData };
        }
      };

      await Promise.race([
        doFetch(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    } catch (err) {
      logger.debug(`Firestore group settings fetch notice for user ${userId}`, err.message);
    }
  }

  // Populate global cache with any loaded settings
  for (const [gid, s] of Object.entries(store.settings)) {
    if (s && !globalGroupRules.has(gid)) {
      globalGroupRules.set(gid, s);
    }
  }

  store.loaded = true;
  return store;
}

function normalized(store, groupId) {
  // 1. Check user store first, then fallback to persistent group ID rule
  const stored = (store && store.settings && store.settings[groupId])
    ? store.settings[groupId]
    : (globalGroupRules.get(groupId) || {});

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

      // 2. Sync to Firestore (Permanent Source of Truth) with timeout guard
      const db = getFirebaseServerFirestore();
      if (db) {
        try {
          const doSet = async () => {
            const { doc, setDoc } = await import("firebase/firestore");
            const writes = [
              setDoc(doc(db, "group_settings", store.safeId), store.settings, { merge: true }),
            ];

            // If a specific group was modified, also write to permanent group_rules/{cleanGroupId}
            if (groupId && store.settings[groupId]) {
              const cleanGid = cleanGroupDocId(groupId);
              writes.push(
                setDoc(doc(db, "group_rules", cleanGid), {
                  groupId,
                  ...store.settings[groupId],
                  updatedAt: new Date().toISOString(),
                }, { merge: true })
              );
            }

            await Promise.all(writes);
          };

          await Promise.race([
            doSet(),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ]);
        } catch (dbErr) {
          logger.warn(`Could not sync group settings to Firestore for user ${store.safeId}`, dbErr.message);
        }
      }
    });
  return store.writeTail;
}

export async function getGroupSettings(groupId, userId = "default") {
  const store = await ensureLoaded(userId);

  // If settings for this groupId are not in this user's store, check global cache & Firestore group_rules
  if (!store.settings[groupId]) {
    const cleanGid = cleanGroupDocId(groupId);
    if (globalGroupRules.has(groupId)) {
      store.settings[groupId] = globalGroupRules.get(groupId);
    } else {
      const db = getFirebaseServerFirestore();
      if (db) {
        try {
          const { doc, getDoc } = await import("firebase/firestore");
          const snap = await getDoc(doc(db, "group_rules", cleanGid));
          if (snap.exists()) {
            const data = snap.data();
            store.settings[groupId] = data;
            globalGroupRules.set(groupId, data);
          }
        } catch {}
      }
    }
  }

  return normalized(store, groupId);
}

export async function setGroupSetting(groupId, key, value, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const updated = { ...current, [key]: value };

  store.settings[groupId] = updated;
  globalGroupRules.set(groupId, updated);

  await persist(store, groupId);
  return updated;
}

export async function addWarning(groupId, participant, userId = "default", reason = "Group rule violation") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const count = (current.warnings[participant] || 0) + 1;
  const warnings = { ...current.warnings, [participant]: count };
  const lastViolations = {
    ...(current.lastViolations || {}),
    [participant]: { reason, timestamp: Date.now() },
  };
  store.settings[groupId] = { ...current, warnings, lastViolations };
  await persist(store);
  return {
    count,
    limit: current.warningLimit,
    exceeded: count >= current.warningLimit,
    reason,
  };
}

export async function clearWarning(groupId, participant, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const warnings = { ...current.warnings };
  const lastViolations = { ...current.lastViolations };
  delete warnings[participant];
  delete lastViolations[participant];
  store.settings[groupId] = { ...current, warnings, lastViolations };
  await persist(store);
  return warnings;
}

export async function resetWarnings(groupId, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  store.settings[groupId] = { ...current, warnings: {}, lastViolations: {} };
  await persist(store);
  return store.settings[groupId];
}

export async function setWarningLimit(groupId, limit, userId = "default") {
  const store = await ensureLoaded(userId);
  const current = normalized(store, groupId);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 3));
  store.settings[groupId] = { ...current, warningLimit: safeLimit };
  await persist(store);
  return safeLimit;
}

export async function getUserPreferences(userId = "default") {
  const store = await ensureLoaded(userId);
  const prefs = store.settings.__user_preferences || {};
  return {
    autoDeletedToDm: typeof prefs.autoDeletedToDm === "boolean" ? prefs.autoDeletedToDm : true,
    autoViewOnceToDm: typeof prefs.autoViewOnceToDm === "boolean" ? prefs.autoViewOnceToDm : true,
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
