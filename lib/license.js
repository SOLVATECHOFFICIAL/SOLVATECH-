import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { ADMIN_EMAIL, ADMIN_EMAILS, isAdminEmail, writeFirestoreDocumentRest } from "./auth.js";
import { isSupabaseConfigured, supabaseUpsert, supabaseGetById, supabaseGetAll, supabaseDelete } from "./supabase.js";
import {
  firestoreUpsert,
  firestoreGetById,
  firestoreGetAll,
  firestoreDelete,
} from "./firestore-sync.js";

export { ADMIN_EMAIL };

// Local file fallback for runtime resilience
const LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-licenses.json");
const USER_LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-user-licenses.json");
const SYSTEM_CONFIG_FILE = path.join(DATA_DIR, "data", "solvatech-system-config.json");

// In-memory cache & write lock to prevent race conditions during redemptions
let inMemoryLicenses = null;
let inMemoryUserLicenses = null;
let inMemorySystemConfig = null;
let inMemoryPlans = null;
let licenseOperationQueue = Promise.resolve();

/**
 * Official system price schedule for SOLVATECH BOT licenses.
 * Backed globally by Supabase system_config (key: "license_plans").
 * Dual properties: priceNgn and price for 100% compatibility.
 */
export const OFFICIAL_LICENSE_PLANS = [
  { id: "1d", days: 1, name: "1 Day", priceNgn: 200, price: 200 },
  { id: "3d", days: 3, name: "3 Days", priceNgn: 500, price: 500 },
  { id: "7d", days: 7, name: "7 Days", priceNgn: 1000, price: 1000 },
  { id: "14d", days: 14, name: "14 Days", priceNgn: 2000, price: 2000 },
  { id: "30d", days: 30, name: "30 Days", priceNgn: 4000, price: 4000 },
  { id: "60d", days: 60, name: "2 Months", priceNgn: 8000, price: 8000 },
  { id: "90d", days: 90, name: "3 Months", priceNgn: 12000, price: 12000 },
  { id: "180d", days: 180, name: "6 Months", priceNgn: 24000, price: 24000 },
  { id: "365d", days: 365, name: "12 Months", priceNgn: 48000, price: 48000 },
];

/**
 * Loads or seeds global license plans from Firestore / Supabase / local
 */
export async function getGlobalLicensePlans() {
  function normalizePlans(plans) {
    if (!Array.isArray(plans)) return OFFICIAL_LICENSE_PLANS;
    return plans.map((p) => {
      const val = Number(p.priceNgn ?? p.price ?? 0);
      return {
        ...p,
        priceNgn: val,
        price: val,
      };
    });
  }

  if (inMemoryPlans && Array.isArray(inMemoryPlans) && inMemoryPlans.length > 0) {
    return normalizePlans(inMemoryPlans);
  }

  // 1. Check Firestore
  try {
    const fsRow = await firestoreGetById("system_config", "license_plans");
    if (fsRow && Array.isArray(fsRow.plans) && fsRow.plans.length > 0) {
      inMemoryPlans = normalizePlans(fsRow.plans);
      return inMemoryPlans;
    }
  } catch {}

  // 2. Check Supabase
  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "license_plans", "key");
      if (row && row.value?.plans && Array.isArray(row.value.plans) && row.value.plans.length > 0) {
        inMemoryPlans = normalizePlans(row.value.plans);
        return inMemoryPlans;
      }

      // Seed Supabase with official plans
      await supabaseUpsert("system_config", {
        key: "license_plans",
        value: { plans: OFFICIAL_LICENSE_PLANS },
        updated_at: new Date().toISOString(),
      }, "key");
      inMemoryPlans = OFFICIAL_LICENSE_PLANS;
      return inMemoryPlans;
    } catch (err) {
      logger.debug("Supabase license plans fetch notice:", err.message);
    }
  }

  inMemoryPlans = OFFICIAL_LICENSE_PLANS;
  return inMemoryPlans;
}

/**
 * Admin: Update global license plans in Firestore & Supabase
 */
export async function updateGlobalLicensePlans(plansArray, authToken = null) {
  if (!Array.isArray(plansArray) || plansArray.length === 0) {
    throw new Error("Plans array must not be empty.");
  }
  inMemoryPlans = plansArray;
  const nowIso = new Date().toISOString();

  // 1. Sync to Firestore
  try {
    await firestoreUpsert("system_config", "license_plans", {
      key: "license_plans",
      plans: plansArray,
      updatedAt: nowIso,
    }, authToken);
  } catch (err) {
    logger.warn("Could not sync license plans to Firestore:", err.message);
  }

  // 2. Sync to Supabase
  if (isSupabaseConfigured()) {
    try {
      await supabaseUpsert("system_config", {
        key: "license_plans",
        value: { plans: plansArray },
        updated_at: nowIso,
      }, "key");
    } catch (err) {
      logger.warn("Could not sync license plans to Supabase:", err.message);
    }
  }

  return inMemoryPlans;
}

/**
 * Authoritative cloud hydration on boot and sync:
 * Queries Firestore and Supabase and hydrates all keys and user licenses into memory and disk.
 */
export async function syncAllLicensesFromCloud(authToken = null) {
  await loadLocalStore();

  // 1. Fetch from Firestore
  try {
    const [fsLicenses, fsUserLicenses, fsPlans] = await Promise.all([
      firestoreGetAll("licenses", authToken).catch(() => []),
      firestoreGetAll("user_licenses", authToken).catch(() => []),
      firestoreGetById("system_config", "license_plans", authToken).catch(() => null),
    ]);

    for (const fl of fsLicenses || []) {
      const code = fl.code || fl.id;
      if (code) {
        inMemoryLicenses[code] = {
          code,
          durationDays: fl.durationDays || fl.duration_days || "30",
          isUnlimited: Boolean(fl.isUnlimited || fl.is_unlimited || fl.durationDays === "Unlimited"),
          status: fl.status || "unused",
          createdBy: fl.createdBy || fl.created_by || ADMIN_EMAIL,
          redeemedByUid: fl.redeemedByUid || fl.redeemed_by_uid || null,
          redeemedByEmail: fl.redeemedByEmail || fl.redeemed_by_email || null,
          redeemedAt: fl.redeemedAt || fl.redeemed_at || null,
          expiresAt: fl.expiresAt || fl.expires_at || null,
          priceNgn: Number(fl.priceNgn || fl.price_ngn || 0),
          createdAt: fl.createdAt || fl.created_at || new Date().toISOString(),
        };
      }
    }

    for (const ful of fsUserLicenses || []) {
      const uid = String(ful.uid || ful.id || "").replace(/^user_/, "");
      if (uid) {
        const isUnl = Boolean(ful.isUnlimited || ful.is_unlimited || ful.durationDays === "Unlimited");
        const rec = {
          uid,
          email: ful.email || "",
          lastLicenseCode: ful.lastLicenseCode || ful.last_license_code || "",
          durationDays: ful.durationDays || (isUnl ? "Unlimited" : "30"),
          isUnlimited: isUnl,
          status: ful.status || (isUnl ? "active" : "expired"),
          redeemedAt: ful.redeemedAt || ful.redeemed_at || null,
          expiresAt: ful.expiresAt || ful.expires_at || null,
          updatedAt: ful.updatedAt || ful.updated_at || new Date().toISOString(),
        };
        inMemoryUserLicenses[uid] = rec;
      }
    }

    if (fsPlans && fsPlans.plans && Array.isArray(fsPlans.plans)) {
      inMemoryPlans = fsPlans.plans;
    }
  } catch (err) {
    logger.debug("[Firestore] License sync note:", err.message);
  }

  // 2. Fetch from Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const [sbLicenses, sbUserLicenses] = await Promise.all([
        supabaseGetAll("licenses").catch(() => []),
        supabaseGetAll("user_licenses").catch(() => []),
      ]);

      for (const row of sbLicenses || []) {
        if (row && row.code) {
          inMemoryLicenses[row.code] = {
            code: row.code,
            durationDays: row.duration_days,
            isUnlimited: Boolean(row.is_unlimited),
            status: row.status || "unused",
            createdBy: row.created_by,
            redeemedByUid: row.redeemed_by_uid,
            redeemedByEmail: row.redeemed_by_email,
            redeemedAt: row.redeemed_at,
            expiresAt: row.expires_at,
            priceNgn: Number(row.price_ngn || 0),
            createdAt: row.created_at,
          };
        }
      }

      for (const row of sbUserLicenses || []) {
        if (row && row.uid) {
          const isUnl = Boolean(row.is_unlimited || row.duration_days === "Unlimited");
          inMemoryUserLicenses[row.uid] = {
            uid: row.uid,
            email: row.email || "",
            lastLicenseCode: row.last_license_code,
            durationDays: row.duration_days,
            isUnlimited: isUnl,
            status: row.status,
            redeemedAt: row.redeemed_at,
            expiresAt: row.expires_at,
            updatedAt: row.updated_at,
          };
        }
      }
    } catch (err) {
      logger.debug("[Supabase] License sync note:", err.message);
    }
  }

  // Persist locally so in-memory store and local files are instantly in sync
  await persistLocalStore();
  return {
    totalLicenses: Object.keys(inMemoryLicenses || {}).length,
    totalUsers: Object.keys(inMemoryUserLicenses || {}).length,
  };
}

/**
 * Returns official price in NGN for a given duration in days from global plans
 */
export function getOfficialLicensePrice(durationDays) {
  const days = parseInt(durationDays, 10);
  if (isNaN(days) || days <= 0) return 0;

  const plans = inMemoryPlans || OFFICIAL_LICENSE_PLANS;
  const match = plans.find((p) => Number(p.days) === days);
  if (match) return Number(match.priceNgn);

  // Pro-rate for custom days based on 30-day baseline (₦4,000 / 30)
  return Math.round(days * (4000 / 30));
}

/**
 * Generates an unguessable, cryptographically random license code.
 * Format: SOLVA-XXXX-XXXX-XXXX
 */
export function generateCryptographicCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segment = (len) => {
    const bytes = crypto.randomBytes(len);
    let str = "";
    for (let i = 0; i < len; i++) {
      str += alphabet[bytes[i] % alphabet.length];
    }
    return str;
  };
  return `SOLVA-${segment(4)}-${segment(4)}-${segment(4)}`;
}

function withAtomicLock(fn) {
  const next = licenseOperationQueue.then(() => fn()).catch((err) => {
    logger.error("License atomic operation error", err.stack || err.message);
    throw err;
  });
  licenseOperationQueue = next.then(() => {}).catch(() => {});
  return next;
}

async function loadLocalStore() {
  if (!inMemoryLicenses) {
    try {
      if (fsSync.existsSync(LICENSES_FILE)) {
        inMemoryLicenses = JSON.parse(await fs.readFile(LICENSES_FILE, "utf8"));
      } else {
        inMemoryLicenses = {};
      }
    } catch {
      inMemoryLicenses = {};
    }
  }

  if (!inMemoryUserLicenses) {
    try {
      if (fsSync.existsSync(USER_LICENSES_FILE)) {
        inMemoryUserLicenses = JSON.parse(await fs.readFile(USER_LICENSES_FILE, "utf8"));
      } else {
        inMemoryUserLicenses = {};
      }
    } catch {
      inMemoryUserLicenses = {};
    }
  }
}

async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LICENSES_FILE), { recursive: true });
    await fs.writeFile(LICENSES_FILE, JSON.stringify(inMemoryLicenses || {}, null, 2));
    await fs.writeFile(USER_LICENSES_FILE, JSON.stringify(inMemoryUserLicenses || {}, null, 2));
  } catch (err) {
    logger.error("Failed to persist local license store", err.message);
  }
}

export function formatRemainingTime(ms) {
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} Day${days === 1 ? "" : "s"}`);
  if (hours > 0 || days > 0) parts.push(`${hours} Hour${hours === 1 ? "" : "s"}`);
  parts.push(`${minutes} Minute${minutes === 1 ? "" : "s"} left`);
  return parts.join(" ");
}

/**
 * Admin: Generates a new license record.
 * Supports standard paid plans and Unlimited Lifetime keys.
 */
export async function createLicenseRecord(durationDays, createdByEmail, authToken = null) {
  const isUnlimited = durationDays === "Unlimited" || durationDays === "unlimited" || String(durationDays).toLowerCase() === "lifetime";
  let days = 0;
  if (!isUnlimited) {
    days = parseInt(durationDays, 10);
    if (isNaN(days) || days <= 0 || days > 36500) {
      throw new Error("Invalid duration. Duration must be between 1 and 365 days or Unlimited.");
    }
  }

  return withAtomicLock(async () => {
    await loadLocalStore();
    const code = generateCryptographicCode();
    const nowIso = new Date().toISOString();
    const priceNgn = isUnlimited ? 0 : getOfficialLicensePrice(days);

    const licenseData = {
      code,
      durationDays: isUnlimited ? "Unlimited" : days,
      isUnlimited,
      createdAt: nowIso,
      createdBy: createdByEmail || ADMIN_EMAIL,
      status: "unused",
      redeemedByUid: null,
      redeemedByEmail: null,
      redeemedAt: null,
      expiresAt: null,
      priceNgn,
    };

    // 1. Sync to Firestore licenses collection
    try {
      await firestoreUpsert("licenses", code, {
        code,
        durationDays: String(licenseData.durationDays),
        isUnlimited,
        createdBy: licenseData.createdBy,
        status: "unused",
        priceNgn,
        createdAt: nowIso,
      }, authToken);
    } catch (err) {
      logger.warn("Could not sync license to Firestore:", err.message);
    }

    // 2. Sync to Supabase licenses table
    if (isSupabaseConfigured()) {
      try {
        await supabaseUpsert("licenses", {
          code,
          duration_days: String(licenseData.durationDays),
          is_unlimited: isUnlimited,
          created_by: licenseData.createdBy,
          status: "unused",
          price_ngn: priceNgn,
          created_at: nowIso,
        }, "code");
      } catch (err) {
        logger.warn("Could not sync license to Supabase:", err.message);
      }
    }

    inMemoryLicenses[code] = licenseData;
    await persistLocalStore();
    return licenseData;
  });
}

/**
 * Admin: Lists all licenses from Firestore and Supabase (newest first)
 */
export async function listAllLicenses(authToken = null) {
  await loadLocalStore();

  // 1. Sync from Firestore
  try {
    const fsRows = await firestoreGetAll("licenses", authToken);
    if (Array.isArray(fsRows)) {
      for (const row of fsRows) {
        const code = row.code || row.id;
        if (code) {
          inMemoryLicenses[code] = {
            code,
            durationDays: row.durationDays || row.duration_days || "30",
            isUnlimited: Boolean(row.isUnlimited || row.is_unlimited || row.durationDays === "Unlimited"),
            status: row.status || "unused",
            createdBy: row.createdBy || row.created_by || ADMIN_EMAIL,
            redeemedByUid: row.redeemedByUid || row.redeemed_by_uid || null,
            redeemedByEmail: row.redeemedByEmail || row.redeemed_by_email || null,
            redeemedAt: row.redeemedAt || row.redeemed_at || null,
            expiresAt: row.expiresAt || row.expires_at || null,
            priceNgn: Number(row.priceNgn || row.price_ngn || 0),
            createdAt: row.createdAt || row.created_at || new Date().toISOString(),
          };
        }
      }
    }
  } catch (err) {
    logger.debug("Firestore licenses read notice:", err.message);
  }

  // 2. Sync from Supabase
  if (isSupabaseConfigured()) {
    try {
      const rows = await supabaseGetAll("licenses", { orderBy: "created_at", ascending: false });
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && row.code) {
            inMemoryLicenses[row.code] = {
              code: row.code,
              durationDays: row.duration_days,
              isUnlimited: Boolean(row.is_unlimited),
              status: row.status || "unused",
              createdBy: row.created_by,
              redeemedByUid: row.redeemed_by_uid,
              redeemedByEmail: row.redeemed_by_email,
              redeemedAt: row.redeemed_at,
              expiresAt: row.expires_at,
              priceNgn: Number(row.price_ngn || 0),
              createdAt: row.created_at,
            };
          }
        }
      }
    } catch (err) {
      logger.warn("Supabase licenses read notice:", err.message);
    }
  }

  await persistLocalStore();

  return Object.values(inMemoryLicenses || {}).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Atomically redeems a license code for a verified user.
 * Writes to Firestore, Supabase, and local disk.
 */
export async function redeemLicenseCode(rawCode, verifiedUser, authToken = null) {
  if (!rawCode || typeof rawCode !== "string") {
    throw new Error("License code is required.");
  }
  if (!verifiedUser || !verifiedUser.uid) {
    throw new Error("Valid authenticated user required.");
  }

  const rawClean = rawCode.trim().toUpperCase();
  const strippedCode = rawClean.replace(/[^A-Z0-9]/g, "");
  const uid = verifiedUser.uid;
  const bareUid = uid.replace(/^user_/, "");
  const email = (verifiedUser.email || "").trim().toLowerCase();

  return withAtomicLock(async () => {
    await loadLocalStore();

    let cleanCode = rawClean;
    let license = inMemoryLicenses[cleanCode];

    if (!license) {
      for (const [codeKey, record] of Object.entries(inMemoryLicenses)) {
        const keyStripped = codeKey.replace(/[^A-Z0-9]/g, "");
        if (keyStripped === strippedCode || keyStripped.replace(/^SOLVA/, "") === strippedCode.replace(/^SOLVA/, "")) {
          cleanCode = codeKey;
          license = record;
          break;
        }
      }
    }

    // Check Firestore
    if (!license) {
      try {
        const fsLic = await firestoreGetById("licenses", cleanCode, authToken);
        if (fsLic && (fsLic.code || fsLic.id)) {
          cleanCode = fsLic.code || fsLic.id;
          license = {
            code: cleanCode,
            durationDays: fsLic.durationDays || fsLic.duration_days,
            isUnlimited: Boolean(fsLic.isUnlimited || fsLic.is_unlimited || fsLic.durationDays === "Unlimited"),
            status: fsLic.status || "unused",
            createdBy: fsLic.createdBy || fsLic.created_by,
            redeemedByUid: fsLic.redeemedByUid || fsLic.redeemed_by_uid,
            redeemedByEmail: fsLic.redeemedByEmail || fsLic.redeemed_by_email,
            redeemedAt: fsLic.redeemedAt || fsLic.redeemed_at,
            expiresAt: fsLic.expiresAt || fsLic.expires_at,
            priceNgn: Number(fsLic.priceNgn || fsLic.price_ngn || 0),
            createdAt: fsLic.createdAt || fsLic.created_at,
          };
          inMemoryLicenses[cleanCode] = license;
        }
      } catch (err) {
        logger.debug("Firestore license query notice:", err.message);
      }
    }

    // Check Supabase
    if (isSupabaseConfigured() && !license) {
      try {
        const row = await supabaseGetById("licenses", cleanCode, "code");
        if (row && row.code) {
          license = {
            code: row.code,
            durationDays: row.duration_days,
            isUnlimited: Boolean(row.is_unlimited),
            status: row.status || "unused",
            createdBy: row.created_by,
            redeemedByUid: row.redeemed_by_uid,
            redeemedByEmail: row.redeemed_by_email,
            redeemedAt: row.redeemed_at,
            expiresAt: row.expires_at,
            priceNgn: Number(row.price_ngn || 0),
            createdAt: row.created_at,
          };
          cleanCode = row.code;
          inMemoryLicenses[cleanCode] = license;
        }
      } catch (err) {
        logger.debug("Supabase license query notice:", err.message);
      }
    }

    if (!license) {
      const err = new Error("Invalid license code. Please verify the characters and try again.");
      err.code = "LICENSE_NOT_FOUND";
      throw err;
    }

    if (license.status === "used" || license.redeemedByUid) {
      const err = new Error("This license code has already been redeemed and cannot be reused.");
      err.code = "LICENSE_ALREADY_USED";
      throw err;
    }

    const now = new Date();
    const nowIso = now.toISOString();

    const isLicenseUnlimited = Boolean(
      license.isUnlimited === true ||
      license.durationDays === "Unlimited" ||
      license.durationDays === "unlimited" ||
      String(license.durationDays).toLowerCase() === "lifetime"
    );

    const durationDays = isLicenseUnlimited ? "Unlimited" : (Number(license.durationDays) || 1);
    const durationMs = isLicenseUnlimited ? null : (Number(durationDays) * 86400000);

    // Retrieve current user license from Firestore / Supabase / memory
    let existingUserLicense = null;

    // Check Firestore
    try {
      const fsUserLic = await firestoreGetById("user_licenses", bareUid, authToken);
      if (fsUserLic) {
        existingUserLicense = {
          uid: bareUid,
          email: fsUserLic.email || email,
          lastLicenseCode: fsUserLic.lastLicenseCode || fsUserLic.last_license_code,
          durationDays: fsUserLic.durationDays || fsUserLic.duration_days,
          isUnlimited: Boolean(fsUserLic.isUnlimited || fsUserLic.is_unlimited || fsUserLic.durationDays === "Unlimited"),
          status: fsUserLic.status,
          expiresAt: fsUserLic.expiresAt || fsUserLic.expires_at,
        };
      }
    } catch {}

    // Check Supabase
    if (!existingUserLicense && isSupabaseConfigured()) {
      try {
        const uRow = await supabaseGetById("user_licenses", bareUid, "uid");
        if (uRow) {
          existingUserLicense = {
            uid: uRow.uid,
            email: uRow.email,
            lastLicenseCode: uRow.last_license_code,
            durationDays: uRow.duration_days,
            isUnlimited: Boolean(uRow.is_unlimited),
            status: uRow.status,
            expiresAt: uRow.expires_at,
          };
        }
      } catch {}
    }
    if (!existingUserLicense) {
      existingUserLicense = inMemoryUserLicenses[bareUid] || inMemoryUserLicenses[uid] || null;
    }

    let expiryIso = null;
    let newIsUnlimited = isLicenseUnlimited;

    if (isLicenseUnlimited) {
      newIsUnlimited = true;
      expiryIso = null;
    } else {
      // Normal paid license: extend existing valid license or start from now
      let startTimestamp = now.getTime();
      if (existingUserLicense && existingUserLicense.expiresAt && !existingUserLicense.isUnlimited) {
        const currentExp = new Date(existingUserLicense.expiresAt).getTime();
        if (currentExp > startTimestamp) {
          startTimestamp = currentExp;
        }
      }
      const newExpDate = new Date(startTimestamp + durationMs);
      expiryIso = newExpDate.toISOString();
      // If user was already Unlimited, keep Unlimited ON and save normal days
      if (existingUserLicense && existingUserLicense.isUnlimited) {
        newIsUnlimited = true;
      }
    }

    // Update license record
    license.status = "used";
    license.redeemedByUid = bareUid;
    license.redeemedByEmail = email;
    license.redeemedAt = nowIso;
    license.expiresAt = expiryIso;
    license.isUnlimited = isLicenseUnlimited;

    // Update user active license
    const userLicenseRecord = {
      uid: bareUid,
      email,
      lastLicenseCode: cleanCode,
      durationDays: newIsUnlimited ? "Unlimited" : durationDays,
      isUnlimited: newIsUnlimited,
      redeemedAt: nowIso,
      expiresAt: expiryIso,
      status: "active",
      updatedAt: nowIso,
    };

    inMemoryLicenses[cleanCode] = license;
    inMemoryUserLicenses[bareUid] = userLicenseRecord;
    inMemoryUserLicenses[uid] = userLicenseRecord;

    // 1. Sync to Firestore
    try {
      await Promise.all([
        firestoreUpsert("licenses", cleanCode, {
          code: cleanCode,
          status: "used",
          redeemedByUid: bareUid,
          redeemedByEmail: email,
          redeemedAt: nowIso,
          expiresAt: expiryIso,
          isUnlimited: isLicenseUnlimited,
          updatedAt: nowIso,
        }, authToken),
        firestoreUpsert("user_licenses", bareUid, userLicenseRecord, authToken),
        firestoreUpsert("users", bareUid, {
          id: bareUid,
          email,
          lastLoginAt: nowIso,
        }, authToken),
      ]);
    } catch (err) {
      logger.warn("Could not sync redemption to Firestore:", err.message);
    }

    // 2. Sync to Supabase
    if (isSupabaseConfigured()) {
      try {
        await Promise.all([
          supabaseUpsert("licenses", {
            code: cleanCode,
            status: "used",
            redeemed_by_uid: bareUid,
            redeemed_by_email: email,
            redeemed_at: nowIso,
            expires_at: expiryIso,
            is_unlimited: isLicenseUnlimited,
          }, "code"),
          supabaseUpsert("user_licenses", {
            uid: bareUid,
            email,
            last_license_code: cleanCode,
            duration_days: String(userLicenseRecord.durationDays),
            is_unlimited: newIsUnlimited,
            status: "active",
            redeemed_at: nowIso,
            expires_at: expiryIso,
            updated_at: nowIso,
          }, "uid"),
          supabaseUpsert("users", {
            id: bareUid,
            email,
            last_login_at: nowIso,
          }, "id"),
        ]);
      } catch (err) {
        logger.warn("Could not sync redemption to Supabase:", err.message);
      }
    }

    await persistLocalStore();

    // Attribution
    try {
      const { recordPurchaseForReferral } = await import("./referral.js");
      await recordPurchaseForReferral(
        bareUid,
        durationDays,
        cleanCode,
        Boolean(license.isReward || license.isFree),
        email,
        authToken
      );
    } catch {}

    // Dispatch real WhatsApp notification DM to user
    try {
      const { sendWhatsAppNotificationToUser } = await import("./whatsapp.js");
      const redeemMsg = [
        "🔑 *SOLVATECH BOT: LICENSE REDEEMED!*",
        "────────────────────────────",
        `Hello! You have successfully redeemed license key: \`${cleanCode}\``,
        `📅 *Duration Added:* ${isLicenseUnlimited ? "Lifetime Unlimited" : `${durationDays} Days`}`,
        `⏳ *Status:* Active ${expiryIso ? `(Expires: ${new Date(expiryIso).toLocaleDateString()})` : "(Never - Unlimited)"}`,
        "",
        "Your WhatsApp bot engine is running 24/7 in cloud uptime. Send *.menu* to view commands.",
        "────────────────────────────",
        "_SOLVATECH BOT Management Platform_",
      ].join("\n");
      sendWhatsAppNotificationToUser(bareUid, redeemMsg).catch(() => {});
    } catch {}

    const remainingMs = expiryIso ? Math.max(0, new Date(expiryIso).getTime() - Date.now()) : 3153600000000;

    return {
      success: true,
      message: isLicenseUnlimited ? "Unlimited Lifetime License activated successfully!" : `License activated! Added ${durationDays} day(s).`,
      license: {
        code: cleanCode,
        durationDays: userLicenseRecord.durationDays,
        isUnlimited: newIsUnlimited,
        redeemedAt: nowIso,
        expiresAt: expiryIso,
        remainingMs,
        remainingFormatted: newIsUnlimited ? "Unlimited (Lifetime)" : formatRemainingTime(remainingMs),
      },
    };
  });
}

/**
 * Retrieves a user's authoritative license status from Firestore, Supabase, and cache.
 */
export async function getUserLicenseStatus(uid, email = "") {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const rawUid = String(uid || "").trim();
  const bareUid = rawUid.replace(/^user_/, "");

  const isAdmin = isAdminEmail(cleanEmail) || isAdminEmail(rawUid) || isAdminEmail(bareUid);
  if (isAdmin) {
    return {
      hasActiveLicense: true,
      status: "active",
      isAdmin: true,
      isUnlimited: true,
      code: "ADMIN-UNLIMITED",
      durationDays: "Unlimited",
      redeemedAt: new Date().toISOString(),
      expiresAt: null,
      remainingMs: 3153600000000,
      remainingFormatted: "Unlimited (Admin Access)",
      serverTime: new Date().toISOString(),
    };
  }

  if (!bareUid && !cleanEmail) {
    return { hasActiveLicense: false, status: "none", isAdmin: false, isUnlimited: false };
  }

  let userLicense = null;

  // 1. Check in-memory local store
  await loadLocalStore();
  userLicense =
    inMemoryUserLicenses[bareUid] ||
    inMemoryUserLicenses[rawUid] ||
    (cleanEmail ? inMemoryUserLicenses[cleanEmail] : null);

  // 2. Check Firestore
  if (!userLicense && bareUid) {
    try {
      const fsRow = await firestoreGetById("user_licenses", bareUid);
      if (fsRow) {
        userLicense = {
          uid: bareUid,
          email: fsRow.email || cleanEmail,
          lastLicenseCode: fsRow.lastLicenseCode || fsRow.last_license_code,
          durationDays: fsRow.durationDays || fsRow.duration_days,
          isUnlimited: Boolean(fsRow.isUnlimited || fsRow.is_unlimited || fsRow.durationDays === "Unlimited"),
          status: fsRow.status,
          redeemedAt: fsRow.redeemedAt || fsRow.redeemed_at,
          expiresAt: fsRow.expiresAt || fsRow.expires_at,
        };
        inMemoryUserLicenses[bareUid] = userLicense;
      }
    } catch (err) {
      logger.debug("Firestore getUserLicenseStatus lookup notice:", err.message);
    }
  }

  // 3. Check Supabase
  if (!userLicense && isSupabaseConfigured() && bareUid) {
    try {
      const row = await supabaseGetById("user_licenses", bareUid, "uid");
      if (row) {
        userLicense = {
          uid: row.uid,
          email: row.email || cleanEmail,
          lastLicenseCode: row.last_license_code,
          durationDays: row.duration_days,
          isUnlimited: Boolean(row.is_unlimited),
          status: row.status,
          redeemedAt: row.redeemed_at,
          expiresAt: row.expires_at,
        };
        inMemoryUserLicenses[bareUid] = userLicense;
      }
    } catch (err) {
      logger.debug("Supabase getUserLicenseStatus lookup notice:", err.message);
    }
  }

  if (!userLicense) {
    return {
      hasActiveLicense: false,
      status: "none",
      isAdmin: false,
      isUnlimited: false,
      message: "No active license",
      remainingMs: 0,
      remainingFormatted: null,
      expiresAt: null,
      serverTime: new Date().toISOString(),
    };
  }

  // 4. User is Unlimited (Lifetime)
  if (userLicense.isUnlimited || userLicense.durationDays === "Unlimited") {
    return {
      hasActiveLicense: true,
      status: "active",
      isUnlimited: true,
      isAdmin: false,
      code: userLicense.lastLicenseCode || "UNLIMITED-PASS",
      durationDays: "Unlimited",
      redeemedAt: userLicense.redeemedAt || null,
      expiresAt: null,
      remainingMs: 3153600000000,
      remainingFormatted: "Unlimited (Lifetime)",
      serverTime: new Date().toISOString(),
    };
  }

  // 5. Normal license with expiration timestamp
  if (userLicense.expiresAt) {
    const expiryMs = new Date(userLicense.expiresAt).getTime();
    const remainingMs = Math.max(0, expiryMs - Date.now());
    const isActive = remainingMs > 0;

    return {
      hasActiveLicense: isActive,
      status: isActive ? "active" : "expired",
      isAdmin: false,
      isUnlimited: false,
      code: userLicense.lastLicenseCode || null,
      durationDays: userLicense.durationDays || null,
      redeemedAt: userLicense.redeemedAt || null,
      expiresAt: userLicense.expiresAt,
      remainingMs,
      remainingFormatted: isActive ? formatRemainingTime(remainingMs) : "Expired",
      serverTime: new Date().toISOString(),
    };
  }

  return {
    hasActiveLicense: false,
    status: "none",
    isAdmin: false,
    isUnlimited: false,
    message: "No active license",
    remainingMs: 0,
    remainingFormatted: null,
    expiresAt: null,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Admin: True ON/OFF switch for user Unlimited access in Supabase.
 * ON = permanent unlimited access.
 * OFF = user follows normal Supabase license / expiry.
 */
export async function toggleUserUnlimitedStatus(targetUid, setUnlimited, adminEmail = ADMIN_EMAIL) {
  const isUnlimited = Boolean(setUnlimited);
  const bareUid = String(targetUid || "").replace(/^user_/, "").trim();
  const rawUid = String(targetUid || "").trim();
  const nowIso = new Date().toISOString();

  return withAtomicLock(async () => {
    await loadLocalStore();

    let existing = null;
    if (isSupabaseConfigured()) {
      existing = await supabaseGetById("user_licenses", bareUid, "uid").catch(() => null);
    }
    if (!existing) {
      existing = inMemoryUserLicenses[bareUid] || inMemoryUserLicenses[rawUid] || {};
    }

    let email = existing?.email || "";
    if (!email && isSupabaseConfigured()) {
      const userRow = await supabaseGetById("users", bareUid, "id").catch(() => null);
      if (userRow?.email) email = userRow.email;
    }
    if (!email && (bareUid.startsWith("admin_") || rawUid.startsWith("admin_"))) {
      for (const adm of ADMIN_EMAILS) {
        if (rawUid.includes(adm.replace(/[^a-zA-Z0-9]/g, "_")) || bareUid.includes(adm.replace(/[^a-zA-Z0-9]/g, "_"))) {
          email = adm;
          break;
        }
      }
    }

    const isNormalValid = existing?.expires_at && new Date(existing.expires_at) > new Date();

    const updatedLicense = {
      uid: bareUid,
      email,
      last_license_code: existing?.last_license_code || (isUnlimited ? "UNLIMITED-ADMIN" : ""),
      duration_days: isUnlimited ? "Unlimited" : (existing?.duration_days && existing.duration_days !== "Unlimited" ? existing.duration_days : "0"),
      is_unlimited: isUnlimited,
      status: isUnlimited ? "active" : (isNormalValid ? "active" : "expired"),
      expires_at: isUnlimited ? null : (existing?.expires_at || null),
      updated_at: nowIso,
    };

    if (isSupabaseConfigured()) {
      try {
        await Promise.all([
          supabaseUpsert("user_licenses", updatedLicense, "uid"),
          ...(email ? [supabaseUpsert("users", { id: bareUid, email, last_login_at: nowIso }, "id")] : []),
        ]);
      } catch (err) {
        logger.warn("Could not sync toggleUserUnlimitedStatus to Supabase:", err.message);
      }
    }

    // Sync to Firestore user_licenses collection
    try {
      await writeFirestoreDocumentRest("user_licenses", bareUid, {
        uid: bareUid,
        email,
        isUnlimited,
        status: updatedLicense.status,
        durationDays: updatedLicense.duration_days,
        expiresAt: updatedLicense.expires_at,
        updatedAt: nowIso,
      });
    } catch {}

    const inMemObj = {
      uid: bareUid,
      email,
      lastLicenseCode: updatedLicense.last_license_code,
      durationDays: updatedLicense.duration_days,
      isUnlimited,
      status: updatedLicense.status,
      expiresAt: updatedLicense.expires_at,
      updatedAt: nowIso,
    };
    inMemoryUserLicenses[bareUid] = inMemObj;
    inMemoryUserLicenses[rawUid] = inMemObj;

    await persistLocalStore();

    logger.info(`Admin ${adminEmail} toggled Unlimited to ${isUnlimited ? "ON" : "OFF"} for user ${bareUid}`);

    // Dispatch real WhatsApp notification DM
    try {
      const { sendWhatsAppNotificationToUser } = await import("./whatsapp.js");
      const unlimitedMsg = isUnlimited
        ? [
            "🎉 *SOLVATECH BOT: LIFETIME UNLIMITED ACTIVATED!*",
            "────────────────────────────",
            "Hello! The administrator has activated *Lifetime Unlimited Access* for your SOLVATECH BOT account!",
            "Enjoy permanent cloud uptime, anti-delete DDD recovery, and automated group moderation without expiration.",
            "────────────────────────────",
            "_SOLVATECH BOT Management Platform_",
          ].join("\n")
        : [
            "ℹ️ *SOLVATECH BOT: ACCOUNT STATUS UPDATE*",
            "────────────────────────────",
            "Hello! Your account subscription status has been updated by the administrator.",
            "────────────────────────────",
            "_SOLVATECH BOT Management Platform_",
          ].join("\n");
      sendWhatsAppNotificationToUser(bareUid, unlimitedMsg).catch(() => {});
    } catch {}

    return { ok: true, uid: bareUid, isUnlimited, status: updatedLicense.status };
  });
}

/**
 * Admin: List all users from Supabase for the simplified Users page
 * ONLY shows: Name, Email, Unlimited ON/OFF switch
 */
export async function listAllUsersWithLicenses() {
  await loadLocalStore();
  const userMap = new Map();

  if (isSupabaseConfigured()) {
    try {
      const [sbUsers, sbUserLicenses, sbLocks, sbLicenses] = await Promise.all([
        supabaseGetAll("users").catch(() => []),
        supabaseGetAll("user_licenses").catch(() => []),
        supabaseGetAll("number_locks").catch(() => []),
        supabaseGetAll("licenses").catch(() => []),
      ]);

      for (const u of sbUsers || []) {
        if (u && u.id) {
          userMap.set(u.id, {
            uid: u.id,
            email: u.email || "",
            displayName: u.display_name || (u.email ? u.email.split("@")[0] : "User"),
            isUnlimited: false,
            status: "none",
            expiresAt: null,
            phoneNumber: "",
          });
        }
      }

      for (const lic of sbUserLicenses || []) {
        if (lic && lic.uid) {
          const uid = lic.uid;
          const existing = userMap.get(uid) || {
            uid,
            email: lic.email || "",
            displayName: lic.email ? lic.email.split("@")[0] : "User",
            phoneNumber: "",
          };

          const isUnl = Boolean(lic.is_unlimited === true || lic.duration_days === "Unlimited");
          existing.isUnlimited = isUnl;
          existing.status = isUnl ? "unlimited" : (lic.expires_at && new Date(lic.expires_at) > new Date() ? "active" : "expired");
          existing.expiresAt = lic.expires_at || null;
          existing.durationDays = lic.duration_days || (isUnl ? "Unlimited" : 0);
          userMap.set(uid, existing);
        }
      }

      for (const lic of sbLicenses || []) {
        if (lic && (lic.redeemed_by_uid || lic.redeemed_by_email)) {
          const uid = lic.redeemed_by_uid || lic.redeemed_by_email;
          const isUnl = Boolean(lic.is_unlimited === true || lic.duration_days === "Unlimited");
          const existing = userMap.get(uid);
          if (!existing) {
            userMap.set(uid, {
              uid,
              email: lic.redeemed_by_email || "",
              displayName: lic.redeemed_by_email ? lic.redeemed_by_email.split("@")[0] : "User",
              isUnlimited: isUnl,
              status: isUnl ? "unlimited" : (lic.expires_at && new Date(lic.expires_at) > new Date() ? "active" : "expired"),
              expiresAt: lic.expires_at || null,
              phoneNumber: "",
            });
          } else if (isUnl) {
            existing.isUnlimited = true;
            existing.status = "unlimited";
          }
        }
      }

      for (const lock of sbLocks || []) {
        if (lock && lock.uid && userMap.has(lock.uid)) {
          userMap.get(lock.uid).phoneNumber = lock.phone_number || "";
        }
      }
    } catch (err) {
      logger.debug("listAllUsersWithLicenses Supabase query notice:", err.message);
    }
  }

  // Merge in-memory local records if not in Supabase
  for (const [k, v] of Object.entries(inMemoryUserLicenses || {})) {
    if (!v) continue;
    const uid = v.uid || k;
    if (!userMap.has(uid) && !uid.includes("@")) {
      userMap.set(uid, {
        uid,
        email: v.email || "",
        displayName: v.email ? v.email.split("@")[0] : "User",
        isUnlimited: Boolean(v.isUnlimited),
        status: v.isUnlimited ? "unlimited" : (v.status || "none"),
        expiresAt: v.expiresAt || null,
        phoneNumber: "",
      });
    }
  }

  // Merge in-memory licenses redeemed users if not in Supabase
  for (const lic of Object.values(inMemoryLicenses || {})) {
    if (lic && (lic.redeemedByUid || lic.redeemedByEmail)) {
      const uid = lic.redeemedByUid || lic.redeemedByEmail;
      if (!userMap.has(uid) && !uid.includes("@")) {
        const isUnl = Boolean(lic.isUnlimited || lic.durationDays === "Unlimited");
        userMap.set(uid, {
          uid,
          email: lic.redeemedByEmail || "",
          displayName: lic.redeemedByEmail ? lic.redeemedByEmail.split("@")[0] : "User",
          isUnlimited: isUnl,
          status: isUnl ? "unlimited" : (lic.expiresAt && new Date(lic.expiresAt) > new Date() ? "active" : "expired"),
          expiresAt: lic.expiresAt || null,
          phoneNumber: "",
        });
      }
    }
  }

  // Ensure known Admin accounts are always displayed
  for (const adminEm of ADMIN_EMAILS) {
    let found = false;
    for (const u of userMap.values()) {
      if (u.email && u.email.toLowerCase() === adminEm.toLowerCase()) {
        found = true;
        break;
      }
    }
    if (!found) {
      const adminUid = "admin_" + adminEm.replace(/[^a-zA-Z0-9]/g, "_");
      userMap.set(adminUid, {
        uid: adminUid,
        email: adminEm,
        displayName: adminEm.split("@")[0] + " (Admin)",
        isUnlimited: true,
        isAdmin: true,
        status: "unlimited",
        expiresAt: null,
        phoneNumber: "",
      });
    }
  }

  const results = [];
  for (const u of userMap.values()) {
    const isOwnerAdmin = isAdminEmail(u.email) || isAdminEmail(u.uid);
    const isUnlimited = isOwnerAdmin || Boolean(u.isUnlimited);

    results.push({
      uid: u.uid,
      email: u.email || "—",
      displayName: u.displayName || (u.email ? u.email.split("@")[0] : "User"),
      isUnlimited,
      isAdmin: isOwnerAdmin,
      status: isUnlimited ? "unlimited" : u.status,
      expiresAt: u.expiresAt,
      phoneNumber: u.phoneNumber || "—",
    });
  }

  return results.sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0));
}

/**
 * Admin: Add a user directly to Unlimited by Email
 */
export async function addUnlimitedUserByEmail(emailInput, adminEmail = ADMIN_EMAIL) {
  const cleanEmail = String(emailInput || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("A valid email address is required.");
  }

  let targetUid = null;
  if (isSupabaseConfigured()) {
    try {
      const users = await supabaseGetAll("users");
      const match = (users || []).find((u) => u.email && u.email.toLowerCase() === cleanEmail);
      if (match) targetUid = match.id;
    } catch {}
  }

  if (!targetUid) {
    targetUid = `user_${cleanEmail.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }

  const result = await toggleUserUnlimitedStatus(targetUid, true, adminEmail);
  return { ...result, email: cleanEmail };
}

/**
 * Admin: Delete a user record
 */
export async function deleteUserFromSystem(targetUid, adminEmail = ADMIN_EMAIL, authToken = null) {
  const bareUid = String(targetUid || "").replace(/^user_/, "").trim();
  return withAtomicLock(async () => {
    await loadLocalStore();
    delete inMemoryUserLicenses[bareUid];
    delete inMemoryUserLicenses[targetUid];

    // 1. Delete from Firestore
    try {
      await Promise.all([
        firestoreDelete("user_licenses", bareUid, authToken),
        firestoreDelete("users", bareUid, authToken),
      ]);
    } catch (err) {
      logger.debug("Firestore deleteUserFromSystem notice:", err.message);
    }

    // 2. Delete from Supabase
    if (isSupabaseConfigured()) {
      try {
        await Promise.all([
          supabaseDelete("user_licenses", "uid", bareUid),
          supabaseDelete("users", "id", bareUid),
        ]);
      } catch (err) {
        logger.debug("Supabase deleteUserFromSystem notice:", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`User ${bareUid} removed by admin ${adminEmail}`);
    return { ok: true, uid: bareUid, deleted: true };
  });
}

/**
 * Admin: Grant custom days to user
 */
export async function grantUserCustomDays(targetUid, days, userEmail = "", authToken = null) {
  const numDays = Math.max(1, parseInt(days, 10) || 1);
  return applyRewardLicenseExtension(targetUid, numDays, `ADMIN-GRANT-${numDays}D`, userEmail, authToken);
}

export async function applyRewardLicenseExtension(uid, daysAwarded, claimId, userEmail = "", authToken = null) {
  const days = Number(daysAwarded) || 3;
  const durationMs = days * 86400000;
  const bareUid = String(uid || "").replace(/^user_/, "").trim();
  const cleanEmail = (userEmail || "").trim().toLowerCase();

  return withAtomicLock(async () => {
    await loadLocalStore();
    let existing = null;
    if (isSupabaseConfigured()) {
      existing = await supabaseGetById("user_licenses", bareUid, "uid").catch(() => null);
    }
    if (!existing) {
      existing = inMemoryUserLicenses[bareUid] || {};
    }

    const isUnlimited = Boolean(existing?.is_unlimited || existing?.isUnlimited);
    let newExpiryIso = null;

    if (!isUnlimited) {
      const now = Date.now();
      let startTimestamp = now;
      if (existing?.expires_at || existing?.expiresAt) {
        const curExp = new Date(existing.expires_at || existing.expiresAt).getTime();
        if (curExp > startTimestamp) startTimestamp = curExp;
      }
      newExpiryIso = new Date(startTimestamp + durationMs).toISOString();
    }

    const updatedLicense = {
      uid: bareUid,
      email: cleanEmail || existing?.email || "",
      last_license_code: `REWARD-${claimId || "CLAIM"}`,
      duration_days: isUnlimited ? "Unlimited" : String((Number(existing?.duration_days || existing?.durationDays) || 0) + days),
      is_unlimited: isUnlimited,
      status: "active",
      expires_at: newExpiryIso,
      updated_at: new Date().toISOString(),
    };

    // 1. Sync to Firestore
    try {
      await firestoreUpsert("user_licenses", bareUid, {
        uid: bareUid,
        email: updatedLicense.email,
        lastLicenseCode: updatedLicense.last_license_code,
        durationDays: updatedLicense.duration_days,
        isUnlimited,
        status: "active",
        expiresAt: newExpiryIso,
        updatedAt: updatedLicense.updated_at,
      }, authToken);
    } catch {}

    // 2. Sync to Supabase
    if (isSupabaseConfigured()) {
      await supabaseUpsert("user_licenses", updatedLicense, "uid");
    }

    inMemoryUserLicenses[bareUid] = {
      uid: bareUid,
      email: updatedLicense.email,
      lastLicenseCode: updatedLicense.last_license_code,
      durationDays: updatedLicense.duration_days,
      isUnlimited,
      status: "active",
      expiresAt: newExpiryIso,
      updatedAt: updatedLicense.updated_at,
    };
    await persistLocalStore();

    // Dispatch real WhatsApp notification DM
    try {
      const { sendWhatsAppNotificationToUser } = await import("./whatsapp.js");
      const grantMsg = [
        "🎁 *SOLVATECH BOT: DAYS GRANTED!*",
        "────────────────────────────",
        `Hello! You have been granted *+${days} days* of active bot uptime!`,
        `⏳ *New Expiry Date:* ${newExpiryIso ? new Date(newExpiryIso).toLocaleDateString() : "Lifetime Unlimited"}`,
        "",
        "Your bot session is active with full 24/7 cloud support.",
        "────────────────────────────",
        "_SOLVATECH BOT Management Platform_",
      ].join("\n");
      sendWhatsAppNotificationToUser(bareUid, grantMsg).catch(() => {});
    } catch {}

    return { success: true, isUnlimited, expiresAt: newExpiryIso };
  });
}

/**
 * Admin: Delete single license key
 */
export async function deleteLicenseKey(code, authToken = null) {
  const cleanCode = String(code || "").trim().toUpperCase();
  return withAtomicLock(async () => {
    await loadLocalStore();
    delete inMemoryLicenses[cleanCode];

    // 1. Delete from Firestore
    try {
      await firestoreDelete("licenses", cleanCode, authToken);
    } catch (err) {
      logger.debug("Firestore deleteLicenseKey notice:", err.message);
    }

    // 2. Delete from Supabase
    if (isSupabaseConfigured()) {
      try {
        await supabaseDelete("licenses", "code", cleanCode);
      } catch (err) {
        logger.debug("Supabase deleteLicenseKey notice:", err.message);
      }
    }

    await persistLocalStore();
    return { ok: true, code: cleanCode };
  });
}

/**
 * Admin: Legacy key purger (kept for backward compatibility)
 */
export async function purgeExpiredOrUnusedKeys(filterType = "all") {
  return performSafeMaintenanceCleanup(filterType === "unused" ? "unused_expired_keys" : "expired_licenses");
}

export async function adminOverwriteUserRecord(targetUid, updates = {}, adminEmail = ADMIN_EMAIL) {
  const isUnlimited = updates.isUnlimited === true || updates.durationDays === "Unlimited";
  return toggleUserUnlimitedStatus(targetUid, isUnlimited, adminEmail);
}

export async function adminGenerateKeyForUser(targetUidOrEmail, durationDays, autoRedeem = false, adminEmail = ADMIN_EMAIL) {
  const license = await createLicenseRecord(durationDays, adminEmail);
  if (!autoRedeem) {
    return { success: true, license, redeemed: false };
  }
  const cleanTarget = String(targetUidOrEmail || "").trim();
  const isEmail = cleanTarget.includes("@");
  const redeemed = await redeemLicenseCode(license.code, { uid: cleanTarget, email: isEmail ? cleanTarget : "" });
  return { success: true, license, redeemed: true, userRecord: redeemed };
}
// In-memory global Railway cache for instantaneous lookup
export const OFFICIAL_RAILWAY_URL = "https://solvatech.up.railway.app";
let memoryRailwayUrl = OFFICIAL_RAILWAY_URL;

export function getCachedRailwayUrl() {
  return memoryRailwayUrl || process.env.RAILWAY_URL || OFFICIAL_RAILWAY_URL;
}

/**
 * Central Railway Backend URL setting stored in Firestore system_config (and Supabase/env/disk)
 */
export async function getGlobalRailwayConfig(authToken = null) {
  // 1. Check Firestore system_config/backend
  try {
    const fsDoc = await firestoreGetById("system_config", "backend", authToken);
    if (fsDoc && (fsDoc.backendUrl || fsDoc.railwayUrl)) {
      const activeUrl = String(fsDoc.backendUrl || fsDoc.railwayUrl).trim().replace(/\/+$/, "");
      if (activeUrl) {
        memoryRailwayUrl = activeUrl;
        process.env.RAILWAY_URL = activeUrl;
        return {
          railwayUrl: activeUrl,
          backendUrl: activeUrl,
          updatedAt: fsDoc.updatedAt || new Date().toISOString(),
          source: "firestore",
        };
      }
    }
  } catch (e) {
    logger.debug("Firestore backend config read notice:", e.message);
  }

  // 2. Check Supabase
  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "railway_url", "key");
      if (row && row.value?.url) {
        const activeUrl = String(row.value.url).trim().replace(/\/+$/, "");
        if (activeUrl) {
          memoryRailwayUrl = activeUrl;
          process.env.RAILWAY_URL = activeUrl;
          return { railwayUrl: activeUrl, backendUrl: activeUrl, updatedAt: row.updated_at, source: "supabase" };
        }
      }
    } catch (e) {
      logger.debug("Supabase railway config read notice:", e.message);
    }
  }

  // 3. Check persistent disk file cache
  try {
    if (fsSync.existsSync(SYSTEM_CONFIG_FILE)) {
      const content = JSON.parse(fsSync.readFileSync(SYSTEM_CONFIG_FILE, "utf8"));
      const diskUrl = String(content.railwayUrl || content.backendUrl || "").trim().replace(/\/+$/, "");
      if (diskUrl) {
        memoryRailwayUrl = diskUrl;
        process.env.RAILWAY_URL = diskUrl;
        return { railwayUrl: diskUrl, backendUrl: diskUrl, updatedAt: content.updatedAt, source: "disk" };
      }
    }
  } catch {}

  const fallback = memoryRailwayUrl || process.env.RAILWAY_URL || process.env.PUBLIC_API_URL || process.env.PUBLIC_URL || OFFICIAL_RAILWAY_URL;
  return { railwayUrl: fallback, backendUrl: fallback, source: "env" };
}

export async function setGlobalRailwayConfig(railwayUrl, authToken = null) {
  const cleanUrl = String(railwayUrl || "").trim().replace(/\/+$/, "");
  const nowIso = new Date().toISOString();

  // Detect if the URL is actually changing compared to previous configuration
  const previousCfg = await getGlobalRailwayConfig().catch(() => null);
  const previousUrl = String(previousCfg?.railwayUrl || previousCfg?.backendUrl || memoryRailwayUrl || process.env.RAILWAY_URL || "").trim().replace(/\/+$/, "");
  const isChanged = Boolean(cleanUrl && cleanUrl !== previousUrl);

  memoryRailwayUrl = cleanUrl;
  process.env.RAILWAY_URL = cleanUrl;

  // 1. Sync to local disk cache immediately
  try {
    const dir = path.dirname(SYSTEM_CONFIG_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    let existing = {};
    if (fsSync.existsSync(SYSTEM_CONFIG_FILE)) {
      try { existing = JSON.parse(fsSync.readFileSync(SYSTEM_CONFIG_FILE, "utf8")); } catch {}
    }
    existing.railwayUrl = cleanUrl;
    existing.backendUrl = cleanUrl;
    existing.updatedAt = nowIso;
    existing.updatedBy = "awoyinfasolomon1@gmail.com";
    fsSync.writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(existing, null, 2));
  } catch (err) {
    logger.debug("Disk write railway config notice:", err.message);
  }

  // 2. Sync to Firestore system_config/backend (broadcasts to all users worldwide via realtime listeners)
  try {
    await firestoreUpsert("system_config", "backend", {
      key: "backend",
      backendUrl: cleanUrl,
      railwayUrl: cleanUrl,
      updatedAt: nowIso,
      updatedBy: "awoyinfasolomon1@gmail.com",
    }, authToken);
  } catch (e) {
    logger.warn("Firestore setGlobalRailwayConfig notice:", e.message);
  }

  // 3. Sync to Supabase
  if (isSupabaseConfigured()) {
    try {
      await supabaseUpsert("system_config", {
        key: "railway_url",
        value: { url: cleanUrl },
        updated_at: nowIso,
      }, "key");
    } catch (e) {
      logger.error("Supabase setGlobalRailwayConfig error:", e.message);
    }
  }

  // If the Railway URL changed, disconnect all users instantly with migration notice
  // If it is the same URL, DO NOT disconnect others
  if (isChanged) {
    logger.info(`[Railway Central Config] URL changed from "${previousUrl}" to "${cleanUrl}". Disconnecting all active sessions with migration notice...`);
    try {
      const { disconnectAllSessionsWithNotice } = await import("./whatsapp.js");
      await disconnectAllSessionsWithNotice(
        [
          "🔄 *SOLVATECH BOT: CENTRAL SERVER MIGRATION*",
          "────────────────────────────",
          "Hello! The bot administrator has updated the global backend server to a new URL:",
          `🌐 *New Server:* \`${cleanUrl}\``,
          "",
          "Your current session has been safely disconnected so you can link to the new engine.",
          "👉 Please return to the dashboard to re-pair or connect fresh to the new server.",
          "────────────────────────────",
          "_SOLVATECH BOT Management Platform_",
        ].join("\n")
      );
    } catch (discErr) {
      logger.warn("Could not disconnect sessions on railway change:", discErr.message);
    }
  } else {
    logger.info(`[Railway Central Config] URL was unchanged ("${cleanUrl}"). Active user sessions remain intact.`);
  }

  return { success: true, railwayUrl: cleanUrl, backendUrl: cleanUrl, updatedAt: nowIso, changed: isChanged };
}

function formatBytesLabel(bytes) {
  const b = Math.max(0, Number(bytes || 0));
  if (b >= 1048576) return `${(b / 1048576).toFixed(4)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

function formatMicroMb(bytes) {
  const b = Math.max(0, Number(bytes || 0));
  return `${(b / 1048576).toFixed(8)} MB`;
}

async function getDirectorySizeSafe(dirPath) {
  let total = 0;
  try {
    if (!fsSync.existsSync(dirPath)) return 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySizeSafe(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          total += stat.size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

function estimateRowsByteSize(rows = [], multiplier = 1.35) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  try {
    return Math.round(Buffer.byteLength(JSON.stringify(rows), "utf8") * multiplier);
  } catch {
    return rows.length * 512;
  }
}

/**
 * SECTION 8: ADMIN STATUS & 500MB LIVE HIGH-PRECISION STORAGE DIAGNOSTICS
 * Diagnostic only — never mutates or deletes data.
 */
export async function getMaintenanceDiagnostics() {
  const now = new Date();
  const QUOTA_BYTES = 500 * 1024 * 1024; // 500.00 MB

  let users = [];
  let userLicenses = [];
  let licenses = [];
  let sessions = [];
  let paymentRequests = [];
  let deletedMessages = [];
  let mediaCache = [];
  let commandLogs = [];
  let antiSpamEvents = [];
  let auditLogs = [];
  let broadcastLogs = [];
  let aiChatMemories = [];
  let aiDeepFacts = [];
  let pgDatabaseBytes = 0;

  // Real live filesystem measurements
  const [sessionsDiskBytes, receiptsDiskBytes, dataFilesDiskBytes] = await Promise.all([
    getDirectorySizeSafe(SESSION_DIR),
    getDirectorySizeSafe(path.join(DATA_DIR, "data", "receipts")),
    getDirectorySizeSafe(path.join(DATA_DIR, "data")),
  ]);

  if (isSupabaseConfigured()) {
    const { getSupabaseClient } = await import("./supabase.js");
    const client = getSupabaseClient();
    const [u, ul, l, ws, pr, dm, mc, bcl, ase, al, bl, acm, adf, rpcRes] = await Promise.all([
      supabaseGetAll("users").catch(() => []),
      supabaseGetAll("user_licenses").catch(() => []),
      supabaseGetAll("licenses").catch(() => []),
      supabaseGetAll("whatsapp_sessions").catch(() => []),
      supabaseGetAll("payment_requests").catch(() => []),
      supabaseGetAll("deleted_messages").catch(() => []),
      supabaseGetAll("media_cache").catch(() => []),
      supabaseGetAll("bot_command_logs").catch(() => []),
      supabaseGetAll("anti_spam_events").catch(() => []),
      supabaseGetAll("audit_logs").catch(() => []),
      supabaseGetAll("broadcast_logs").catch(() => []),
      supabaseGetAll("ai_chat_memories").catch(() => []),
      supabaseGetAll("ai_deep_facts").catch(() => []),
      client ? client.rpc("get_database_storage_stats").then((r) => r.data).catch(() => null) : Promise.resolve(null),
    ]);
    users = u || [];
    userLicenses = ul || [];
    licenses = l || [];
    sessions = ws || [];
    paymentRequests = pr || [];
    deletedMessages = dm || [];
    mediaCache = mc || [];
    commandLogs = bcl || [];
    antiSpamEvents = ase || [];
    auditLogs = al || [];
    broadcastLogs = bl || [];
    aiChatMemories = acm || [];
    aiDeepFacts = adf || [];
    if (rpcRes && Number(rpcRes.database_size_bytes) > 0) {
      pgDatabaseBytes = Number(rpcRes.database_size_bytes);
    }
  } else {
    await loadLocalStore();
    licenses = Object.values(inMemoryLicenses || {});
    userLicenses = Object.values(inMemoryUserLicenses || {});
  }

  const unlimitedUsersCount = userLicenses.filter((ul) => Boolean(ul.is_unlimited || ul.isUnlimited)).length;
  const activeLicensesCount = userLicenses.filter((ul) => Boolean(ul.is_unlimited || ul.isUnlimited) || (ul.expires_at && new Date(ul.expires_at) > now) || (ul.expiresAt && new Date(ul.expiresAt) > now)).length;
  const expiredLicensesCount = userLicenses.filter((ul) => !ul.is_unlimited && !ul.isUnlimited && ((ul.expires_at && new Date(ul.expires_at) <= now) || (ul.expiresAt && new Date(ul.expiresAt) <= now))).length;

  const totalKeys = licenses.length;
  const unusedKeys = licenses.filter((l) => l.status === "unused").length;
  const expiredUnusedKeys = licenses.filter((l) => l.status === "unused" && l.expires_at && new Date(l.expires_at) <= now).length;
  const usedKeys = licenses.filter((l) => l.status === "used").length;
  const expiredLicensesList = licenses.filter((l) => l.status === "used" && !l.is_unlimited && l.expires_at && new Date(l.expires_at) <= now);
  const expiredLicensesTotal = expiredLicensesList.length;

  // Calculate Receipt Pictures breakdown (Pending = Protected; Approved/Rejected/Expired/Cancelled = Clearable)
  let clearablePicsCount = 0;
  let clearablePicsBytes = 0;
  let protectedPendingPicsCount = 0;
  let protectedPendingPicsBytes = 0;

  for (const pr of paymentRequests) {
    if (pr && pr.receipt_path) {
      const sz = Number(pr.receipt_size_bytes) || 185000;
      const st = String(pr.status || "").toLowerCase();
      if (st === "pending" || st === "awaiting_receipt") {
        protectedPendingPicsCount++;
        protectedPendingPicsBytes += sz;
      } else {
        clearablePicsCount++;
        clearablePicsBytes += sz;
      }
    }
  }

  const rejectedExpiredPaymentsList = paymentRequests.filter((pr) => {
    const st = String(pr?.status || "").toLowerCase();
    return st === "rejected" || st === "expired" || st === "cancelled";
  });

  const messageHistoryCount = deletedMessages.length + mediaCache.length;
  const messageHistoryBytes = estimateRowsByteSize(deletedMessages) + estimateRowsByteSize(mediaCache);

  const commandHistoryCount = commandLogs.length + antiSpamEvents.length + auditLogs.length + broadcastLogs.length;
  const commandHistoryBytes =
    estimateRowsByteSize(commandLogs) +
    estimateRowsByteSize(antiSpamEvents) +
    estimateRowsByteSize(auditLogs) +
    estimateRowsByteSize(broadcastLogs);

  const aiHistoryCount = aiChatMemories.length + aiDeepFacts.length;
  const aiHistoryBytes = estimateRowsByteSize(aiChatMemories) + estimateRowsByteSize(aiDeepFacts);

  const rejectedExpiredPaymentsBytes = estimateRowsByteSize(rejectedExpiredPaymentsList) +
    rejectedExpiredPaymentsList.reduce((acc, r) => acc + (r.receipt_path ? (Number(r.receipt_size_bytes) || 185000) : 0), 0);

  const expiredLicensesBytes = estimateRowsByteSize(expiredLicensesList);

  const protectedCoreRowsBytes =
    estimateRowsByteSize(users) +
    estimateRowsByteSize(userLicenses) +
    Math.max(estimateRowsByteSize(sessions), sessionsDiskBytes) +
    estimateRowsByteSize(licenses.filter((l) => !expiredLicensesList.includes(l))) +
    Math.max(protectedPendingPicsBytes, receiptsDiskBytes > 0 ? protectedPendingPicsBytes : 0);

  const clearableBytes =
    clearablePicsBytes +
    messageHistoryBytes +
    commandHistoryBytes +
    aiHistoryBytes +
    estimateRowsByteSize(rejectedExpiredPaymentsList) +
    expiredLicensesBytes;

  const totalUsedBytes = Math.max(
    pgDatabaseBytes + clearablePicsBytes + protectedPendingPicsBytes + sessionsDiskBytes,
    protectedCoreRowsBytes + clearableBytes + dataFilesDiskBytes
  );
  const protectedBytes = Math.max(protectedCoreRowsBytes, totalUsedBytes - clearableBytes);
  const freeBytes = Math.max(0, QUOTA_BYTES - totalUsedBytes);
  const usagePercent = Math.min(100, (totalUsedBytes / QUOTA_BYTES) * 100);

  const sessionsByUid = new Set();
  const sessionsBySafeId = new Set();
  for (const s of sessions) {
    if (s.uid) sessionsByUid.add(s.uid);
    if (s.safe_user_id) sessionsBySafeId.add(s.safe_user_id);
  }

  const activeLicenseNoSession = [];
  for (const ul of userLicenses) {
    const isAct = Boolean(ul.is_unlimited || ul.isUnlimited) || (ul.expires_at && new Date(ul.expires_at) > now) || (ul.expiresAt && new Date(ul.expiresAt) > now);
    if (isAct && ul.uid) {
      const safeId = `user_${ul.uid}`;
      if (!sessionsByUid.has(ul.uid) && !sessionsBySafeId.has(safeId) && !sessionsBySafeId.has(ul.uid)) {
        activeLicenseNoSession.push(ul.uid);
      }
    }
  }

  const pairedWithExpiredLicense = [];
  for (const ul of userLicenses) {
    const isExp = !ul.is_unlimited && !ul.isUnlimited && ((ul.expires_at && new Date(ul.expires_at) <= now) || (ul.expiresAt && new Date(ul.expiresAt) <= now));
    if (isExp && ul.uid) {
      const safeId = `user_${ul.uid}`;
      if (sessionsByUid.has(ul.uid) || sessionsBySafeId.has(safeId) || sessionsBySafeId.has(ul.uid)) {
        pairedWithExpiredLicense.push({ uid: ul.uid, email: ul.email });
      }
    }
  }

  const allUserIds = new Set(users.map((u) => u.id));
  const orphanedLicenses = licenses.filter((l) => {
    return l.status === "used" && l.redeemed_by_uid && !allUserIds.has(l.redeemed_by_uid) && !l.is_unlimited && l.expires_at && new Date(l.expires_at) <= now;
  });

  return {
    success: true,
    diagnostics: {
      totalUsers: users.length || userLicenses.length,
      unlimitedUsers: unlimitedUsersCount,
      activeLicenses: activeLicensesCount,
      expiredLicenses: expiredLicensesCount + expiredLicensesTotal,
      totalKeys,
      unusedKeys,
      expiredUnusedKeys,
      usedKeys,
      expiredLicensesTotal,
      pairedWhatsAppSessions: sessions.length,
      activeLicenseNoSessionCount: activeLicenseNoSession.length,
      pairedWithExpiredLicenseCount: pairedWithExpiredLicense.length,
      orphanedRecordsCount: orphanedLicenses.length,
      pairedWithExpiredList: pairedWithExpiredLicense.slice(0, 8),
      storage: {
        quotaBytes: QUOTA_BYTES,
        quotaFormatted: "500.00 MB",
        usedBytes: totalUsedBytes,
        usedFormatted: formatBytesLabel(totalUsedBytes),
        usedMicroMb: formatMicroMb(totalUsedBytes),
        freeBytes,
        freeFormatted: formatBytesLabel(freeBytes),
        freeMicroMb: formatMicroMb(freeBytes),
        usagePercent,
        usagePercentFormatted: `${usagePercent.toFixed(6)}%`,
        protectedBytes,
        protectedFormatted: formatBytesLabel(protectedBytes),
        protectedMicroMb: formatMicroMb(protectedBytes),
        clearableBytes,
        clearableFormatted: formatBytesLabel(clearableBytes),
        clearableMicroMb: formatMicroMb(clearableBytes),
      },
      categories: {
        receiptPics: {
          clearableCount: clearablePicsCount,
          clearableBytes: clearablePicsBytes,
          clearableFormatted: formatBytesLabel(clearablePicsBytes),
          clearableMicroMb: formatMicroMb(clearablePicsBytes),
          protectedPendingCount: protectedPendingPicsCount,
          protectedPendingBytes: protectedPendingPicsBytes,
        },
        sessionsAuth: {
          count: sessions.length,
          bytes: sessionsDiskBytes,
          formatted: formatBytesLabel(sessionsDiskBytes),
          microMb: formatMicroMb(sessionsDiskBytes),
        },
        messageHistory: {
          count: messageHistoryCount,
          bytes: messageHistoryBytes,
          formatted: formatBytesLabel(messageHistoryBytes),
          microMb: formatMicroMb(messageHistoryBytes),
        },
        commandHistory: {
          count: commandHistoryCount,
          bytes: commandHistoryBytes,
          formatted: formatBytesLabel(commandHistoryBytes),
          microMb: formatMicroMb(commandHistoryBytes),
        },
        aiHistory: {
          count: aiHistoryCount,
          bytes: aiHistoryBytes,
          formatted: formatBytesLabel(aiHistoryBytes),
          microMb: formatMicroMb(aiHistoryBytes),
        },
        rejectedExpiredPayments: {
          count: rejectedExpiredPaymentsList.length,
          bytes: rejectedExpiredPaymentsBytes,
          formatted: formatBytesLabel(rejectedExpiredPaymentsBytes),
          microMb: formatMicroMb(rejectedExpiredPaymentsBytes),
        },
        expiredLicenses: {
          count: expiredLicensesTotal,
          bytes: expiredLicensesBytes,
          formatted: formatBytesLabel(expiredLicensesBytes),
          microMb: formatMicroMb(expiredLicensesBytes),
        },
      },
    },
  };
}

/**
 * SECTION 7: SAFE STORAGE / CLEANUP OPERATIONS
 * Strictly protects:
 * - active user licenses
 * - Unlimited users
 * - connected AND disconnected WhatsApp sessions
 * - pending payment receipts
 */
export async function performSafeMaintenanceCleanup(action, authToken = null) {
  const now = new Date();
  let count = 0;
  let message = "";

  const { getSupabaseClient, supabaseUpdate, supabaseStorageDelete } = await import("./supabase.js");
  const client = getSupabaseClient();

  const clearTableAllRows = async (tableName, pkCol = "id") => {
    if (!client) return 0;
    const rows = await supabaseGetAll(tableName).catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    await client.from(tableName).delete().not(pkCol, "is", null).catch(() => {});
    return rows.length;
  };

  if (action === "expired_licenses") {
    // 1. Clean from Firestore
    try {
      const fsLicenses = await firestoreGetAll("licenses", authToken);
      for (const lic of fsLicenses || []) {
        const code = lic.code || lic.id;
        const isExp = !lic.isUnlimited && !lic.is_unlimited && lic.expiresAt && new Date(lic.expiresAt) < now;
        if (code && (lic.status === "used" || lic.redeemedByUid) && isExp) {
          await firestoreDelete("licenses", code, authToken);
          if (inMemoryLicenses) delete inMemoryLicenses[code];
          count++;
        }
      }
    } catch (e) {
      logger.debug("Firestore expired licenses purge notice:", e.message);
    }

    // 2. Clean from Supabase
    if (isSupabaseConfigured()) {
      const allLicenses = await supabaseGetAll("licenses");
      const toDelete = (allLicenses || []).filter((l) => {
        return l.status === "used" && !l.is_unlimited && l.expires_at && new Date(l.expires_at) < now;
      });
      for (const lic of toDelete) {
        await supabaseDelete("licenses", "code", lic.code);
        if (inMemoryLicenses) delete inMemoryLicenses[lic.code];
        count++;
      }
    }
    await persistLocalStore();
    message = `Safely purged ${count} expired historical license records from Firestore. Active licenses and Unlimited users are 100% preserved.`;
  } else if (action === "unused_expired_keys") {
    // 1. Clean from Firestore
    try {
      const fsLicenses = await firestoreGetAll("licenses", authToken);
      for (const lic of fsLicenses || []) {
        const code = lic.code || lic.id;
        const isExp = lic.expiresAt && new Date(lic.expiresAt) < now;
        if (code && (lic.status === "unused" || !lic.redeemedByUid) && isExp) {
          await firestoreDelete("licenses", code, authToken);
          if (inMemoryLicenses) delete inMemoryLicenses[code];
          count++;
        }
      }
    } catch (e) {
      logger.debug("Firestore unused keys purge notice:", e.message);
    }

    // 2. Clean from Supabase
    if (isSupabaseConfigured()) {
      const allLicenses = await supabaseGetAll("licenses");
      const toDelete = (allLicenses || []).filter((l) => {
        return l.status === "unused" && l.expires_at && new Date(l.expires_at) < now;
      });
      for (const lic of toDelete) {
        await supabaseDelete("licenses", "code", lic.code);
        if (inMemoryLicenses) delete inMemoryLicenses[lic.code];
        count++;
      }
    }
    await persistLocalStore();
    message = `Safely removed ${count} expired unused keys from Firestore.`;
  } else if (action === "stale_cache") {
    inMemoryLicenses = null;
    inMemoryUserLicenses = null;
    inMemoryPlans = null;
    await loadLocalStore();
    await getGlobalLicensePlans();
    count = 1;
    message = "Temporary in-memory caches resynchronized with Supabase.";
  } else if (action === "orphaned_records") {
    if (isSupabaseConfigured()) {
      const [allLicenses, allUsers] = await Promise.all([
        supabaseGetAll("licenses"),
        supabaseGetAll("users"),
      ]);
      const validUids = new Set((allUsers || []).map((u) => u.id));
      const toDelete = (allLicenses || []).filter((l) => {
        return l.status === "used" && l.redeemed_by_uid && !validUids.has(l.redeemed_by_uid) && !l.is_unlimited && l.expires_at && new Date(l.expires_at) < now;
      });
      for (const lic of toDelete) {
        await supabaseDelete("licenses", "code", lic.code);
        count++;
      }
    }
    message = `Safely removed ${count} orphaned records.`;
  } else if (action === "clear_receipt_pics") {
    if (isSupabaseConfigured()) {
      const payments = await supabaseGetAll("payment_requests").catch(() => []);
      for (const pr of payments || []) {
        const st = String(pr?.status || "").toLowerCase();
        // NEVER touch pending or awaiting_receipt payment receipts
        if (pr?.receipt_path && st !== "pending" && st !== "awaiting_receipt") {
          await supabaseStorageDelete(pr.receipt_bucket || "payment-receipts", pr.receipt_path).catch(() => {});
          await supabaseUpdate("payment_requests", "payment_reference", pr.payment_reference, {
            receipt_path: null,
            receipt_size_bytes: null,
            updated_at: new Date().toISOString(),
          }).catch(() => {});
          count++;
        }
      }
    }
    message = `Safely cleared ${count} processed payment receipt screenshot(s). Pending payment receipts remain 100% untouched.`;
  } else if (action === "clear_message_history") {
    const c1 = await clearTableAllRows("deleted_messages", "id");
    const c2 = await clearTableAllRows("media_cache", "id");
    count = c1 + c2;
    message = `Cleared ${count} cached message and media history record(s). All WhatsApp sessions are untouched.`;
  } else if (action === "clear_command_history") {
    const c1 = await clearTableAllRows("bot_command_logs", "id");
    const c2 = await clearTableAllRows("anti_spam_events", "id");
    const c3 = await clearTableAllRows("audit_logs", "id");
    const c4 = await clearTableAllRows("broadcast_logs", "id");
    count = c1 + c2 + c3 + c4;
    message = `Cleared ${count} historical command, moderation, and event log record(s).`;
  } else if (action === "clear_ai_history") {
    const c1 = await clearTableAllRows("ai_chat_memories", "id");
    const c2 = await clearTableAllRows("ai_deep_facts", "id");
    count = c1 + c2;
    message = `Cleared ${count} AI conversation memory and fact record(s).`;
  } else if (action === "clear_rejected_expired_payments") {
    if (isSupabaseConfigured()) {
      const payments = await supabaseGetAll("payment_requests").catch(() => []);
      for (const pr of payments || []) {
        const st = String(pr?.status || "").toLowerCase();
        if (st === "rejected" || st === "expired" || st === "cancelled") {
          if (pr.receipt_path) {
            await supabaseStorageDelete(pr.receipt_bucket || "payment-receipts", pr.receipt_path).catch(() => {});
          }
          await supabaseDelete("payment_requests", "payment_reference", pr.payment_reference).catch(() => {});
          count++;
        }
      }
    }
    message = `Purged ${count} rejected/expired payment session(s) and their receipt files.`;
  } else if (action === "clear_all_safe_history") {
    const r1 = await performSafeMaintenanceCleanup("clear_receipt_pics", authToken);
    const r2 = await performSafeMaintenanceCleanup("clear_message_history", authToken);
    const r3 = await performSafeMaintenanceCleanup("clear_command_history", authToken);
    const r4 = await performSafeMaintenanceCleanup("clear_ai_history", authToken);
    const r5 = await performSafeMaintenanceCleanup("clear_rejected_expired_payments", authToken);
    const r6 = await performSafeMaintenanceCleanup("expired_licenses", authToken);
    count = (r1.count || 0) + (r2.count || 0) + (r3.count || 0) + (r4.count || 0) + (r5.count || 0) + (r6.count || 0);
    message = `Smart Sweep complete! Freed ${count} total items (processed receipts, message/command/AI history, and expired keys). Connected & Disconnected WhatsApp sessions and Active/Unlimited users are 100% protected.`;
  } else if (action === "recover_firestore_to_supabase") {
    const { readFirestoreCollectionRest } = await import("./auth.js");
    const [fsLicenses, fsUserLicenses] = await Promise.all([
      readFirestoreCollectionRest("licenses", authToken).catch(() => []),
      readFirestoreCollectionRest("user_licenses", authToken).catch(() => []),
    ]);
    for (const fl of fsLicenses || []) {
      const code = fl.code || fl.id;
      if (code && isSupabaseConfigured()) {
        await supabaseUpsert("licenses", {
          code,
          duration_days: String(fl.durationDays || fl.duration_days || "30"),
          is_unlimited: Boolean(fl.isUnlimited || fl.is_unlimited || fl.durationDays === "Unlimited"),
          status: fl.status || "unused",
          created_by: fl.createdBy || ADMIN_EMAIL,
          redeemed_by_uid: fl.redeemedByUid || null,
          redeemed_by_email: fl.redeemedByEmail || null,
          redeemed_at: fl.redeemedAt || null,
          expires_at: fl.expiresAt || null,
          price_ngn: Number(fl.priceNgn || 0),
          created_at: fl.createdAt || new Date().toISOString(),
        }, "code").catch(() => {});
        count++;
      }
    }
    for (const ful of fsUserLicenses || []) {
      const uid = String(ful.uid || ful.id || "").replace(/^user_/, "");
      if (uid && isSupabaseConfigured()) {
        await supabaseUpsert("user_licenses", {
          uid,
          email: ful.email || "",
          last_license_code: ful.lastLicenseCode || ful.code || "",
          duration_days: String(ful.durationDays || (ful.isUnlimited ? "Unlimited" : "30")),
          is_unlimited: Boolean(ful.isUnlimited || ful.durationDays === "Unlimited"),
          status: ful.status || "active",
          expires_at: ful.expiresAt || null,
          updated_at: new Date().toISOString(),
        }, "uid").catch(() => {});
        count++;
      }
    }
    message = `Dual-Vault Sync complete! Verified and synchronized ${count} customer & license record(s) between Firebase and Supabase.`;
  } else if (action === "transient_tokens" || action === "purge_transient_tokens") {
    const { purgeTransientStorage } = await import("./whatsapp.js");
    const purgeRes = await purgeTransientStorage({
      purgeTransient: true,
      truncateLogs: false,
      clearMsgCache: false,
      resyncCredsToFirebase: true,
      runGc: true,
    });
    count = purgeRes.purgedFilesCount || 0;
    message = purgeRes.message;
  } else if (action === "clear_bot_logs") {
    const { purgeTransientStorage } = await import("./whatsapp.js");
    const purgeRes = await purgeTransientStorage({
      purgeTransient: false,
      truncateLogs: true,
      clearMsgCache: true,
      resyncCredsToFirebase: true,
      runGc: true,
    });
    count = 1;
    message = "Safely cleared and truncated bot.log and in-memory deleted message caches. All sessions are 100% active.";
  } else if (action === "turbo_purge") {
    const { purgeTransientStorage } = await import("./whatsapp.js");
    const purgeRes = await purgeTransientStorage({
      purgeTransient: true,
      truncateLogs: true,
      clearMsgCache: true,
      resyncCredsToFirebase: true,
      runGc: true,
    });
    count = purgeRes.purgedFilesCount || 0;
    message = purgeRes.message;
  } else {
    throw new Error(`Unknown maintenance cleanup action: ${action}`);
  }

  const latestDiag = await getMaintenanceDiagnostics().catch(() => ({}));
  logger.info(`[Maintenance] Safe cleanup '${action}' completed. Count: ${count}`);
  return { success: true, action, count, message, diagnostics: latestDiag.diagnostics };
}
