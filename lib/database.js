import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SETTINGS_FILE } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore } from "./auth.js";

const defaults = {
  antiLink: false,
  antiBot: false,
  antiStatus: true,
  welcome: true,
  goodbye: true,
  warningLimit: 3,
  warnings: {},
  lastViolations: {},
};

// Map of userId -> { safeId: string, filePath: string, settings: Record<string, any>, loaded: boolean, writeTail: Promise<void> }
const userStores = new Map();

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

  // 2. Fetch authoritative group settings from Firestore if available
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const docSnap = await getDoc(doc(db, "group_settings", store.safeId));
      if (docSnap.exists()) {
        const firestoreData = docSnap.data() || {};
        // Merge Firestore data over local JSON data (Firestore is source of truth)
        store.settings = { ...store.settings, ...firestoreData };
      }
    } catch (err) {
      logger.debug(`Firestore group settings fetch notice for user ${userId}`, err.message);
    }
  }

  store.loaded = true;
  return store;
}

function normalized(store, groupId) {
  const stored = store.settings[groupId] || {};
  return {
    ...defaults,
    antiLink: typeof stored.antiLink === "boolean" ? stored.antiLink : Boolean(stored.anti),
    antiBot: Boolean(stored.antiBot),
    antiStatus: typeof stored.antiStatus === "boolean" ? stored.antiStatus : true,
    welcome: typeof stored.welcome === "boolean" ? stored.welcome : true,
    goodbye: typeof stored.goodbye === "boolean" ? stored.goodbye : true,
    warningLimit: Number(stored.warningLimit || 3),
    warnings: stored.warnings && typeof stored.warnings === "object" ? stored.warnings : {},
    lastViolations: stored.lastViolations && typeof stored.lastViolations === "object" ? stored.lastViolations : {},
  };
}

function persist(store) {
  store.writeTail = store.writeTail
    .catch(() => {})
    .then(async () => {
      // 1. Write local disk backup
      try {
        await fs.mkdir(path.dirname(store.filePath), { recursive: true });
        const temp = `${store.filePath}.tmp`;
        await fs.writeFile(temp, JSON.stringify(store.settings, null, 2));
        await fs.rename(temp, store.filePath);
      } catch (fileErr) {
        logger.warn(`Local group settings write error for user ${store.safeId}`, fileErr.message);
      }

      // 2. Sync to Firestore (Permanent Source of Truth)
      const db = getFirebaseServerFirestore();
      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          await setDoc(doc(db, "group_settings", store.safeId), store.settings, { merge: true });
        } catch (dbErr) {
          logger.warn(`Could not sync group settings to Firestore for user ${store.safeId}`, dbErr.message);
        }
      }
    });
  return store.writeTail;
}

export async function getGroupSettings(groupId, userId = "default") {
  const store = await ensureLoaded(userId);
  return normalized(store, groupId);
}

export async function setGroupSetting(groupId, key, value, userId = "default") {
  const store = await ensureLoaded(userId);
  store.settings[groupId] = { ...normalized(store, groupId), [key]: value };
  await persist(store);
  return store.settings[groupId];
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
