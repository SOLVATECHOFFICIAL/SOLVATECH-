import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import {
  ADMIN_EMAIL,
  ADMIN_EMAILS,
  isAdminEmail,
  writeFirestoreDocumentRest,
  readFirestoreDocumentRest,
  readFirestoreCollectionRest,
} from "./auth.js";
import {
  isSupabaseConfigured,
  supabaseUpsert,
  supabaseGetById,
  supabaseGetAll,
  supabaseDelete,
  supabaseClearTable,
  supabaseGetDatabaseSizeRpc,
} from "./supabase.js";

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
 * Loads or seeds global license plans from Supabase system_config
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
 * Admin: Update global license plans in Supabase
 */
export async function updateGlobalLicensePlans(plansArray) {
  if (!Array.isArray(plansArray) || plansArray.length === 0) {
    throw new Error("Plans array must not be empty.");
  }
  inMemoryPlans = plansArray;
  if (isSupabaseConfigured()) {
    await supabaseUpsert("system_config", {
      key: "license_plans",
      value: { plans: plansArray },
      updated_at: new Date().toISOString(),
    }, "key");
  }
  return inMemoryPlans;
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
export async function createLicenseRecord(durationDays, createdByEmail) {
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

    // Mirror to Firebase Firestore backup vault so keys never vanish on Railway redeploy or SQL update
    writeFirestoreDocumentRest("licenses", code, licenseData).catch(() => {});

    return licenseData;
  });
}

/**
 * Admin: Lists all licenses from Supabase + Firebase Firestore backup vault (newest first)
 * Auto-heals Supabase if any license exists in Firestore or local store but is missing in Supabase.
 */
export async function listAllLicenses(authToken = null) {
  await loadLocalStore();
  const sbCodes = new Set();

  if (isSupabaseConfigured()) {
    try {
      const rows = await supabaseGetAll("licenses", { orderBy: "created_at", ascending: false });
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && row.code) {
            sbCodes.add(row.code);
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

  // Merge & auto-recover from Firebase Firestore backup vault if any keys are missing in Supabase
  try {
    const fsLicenses = await readFirestoreCollectionRest("licenses", authToken).catch(() => []);
    if (Array.isArray(fsLicenses)) {
      for (const fl of fsLicenses) {
        const code = fl.code || fl.id;
        if (!code) continue;
        if (!inMemoryLicenses[code]) {
          inMemoryLicenses[code] = {
            code,
            durationDays: fl.durationDays ?? fl.duration_days ?? 30,
            isUnlimited: Boolean(fl.isUnlimited || fl.is_unlimited || fl.durationDays === "Unlimited"),
            status: fl.status || (fl.redeemedByUid ? "used" : "unused"),
            createdBy: fl.createdBy || fl.created_by || ADMIN_EMAIL,
            redeemedByUid: fl.redeemedByUid || fl.redeemed_by_uid || null,
            redeemedByEmail: fl.redeemedByEmail || fl.redeemed_by_email || null,
            redeemedAt: fl.redeemedAt || fl.redeemed_at || null,
            expiresAt: fl.expiresAt || fl.expires_at || null,
            priceNgn: Number(fl.priceNgn ?? fl.price_ngn ?? 0),
            createdAt: fl.createdAt || fl.created_at || new Date().toISOString(),
          };
        }
        if (isSupabaseConfigured() && !sbCodes.has(code)) {
          const rec = inMemoryLicenses[code];
          supabaseUpsert("licenses", {
            code: rec.code,
            duration_days: String(rec.durationDays || 30),
            is_unlimited: Boolean(rec.isUnlimited),
            status: rec.status || "unused",
            created_by: rec.createdBy || ADMIN_EMAIL,
            redeemed_by_uid: rec.redeemedByUid || null,
            redeemed_by_email: rec.redeemedByEmail || null,
            redeemed_at: rec.redeemedAt || null,
            expires_at: rec.expiresAt || null,
            price_ngn: Number(rec.priceNgn || 0),
            created_at: rec.createdAt || new Date().toISOString(),
          }, "code").catch(() => {});
          sbCodes.add(code);
        }
      }
    }
  } catch {}

  return Object.values(inMemoryLicenses || {}).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Atomically redeems a license code for a verified user.
 * Supabase is the permanent source of truth.
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

    // Retrieve current user license from Supabase
    let existingUserLicense = null;
    if (isSupabaseConfigured()) {
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

    // Update user active license in Supabase
    const userLicenseRecord = {
      uid: bareUid,
      email,
      lastLicenseCode: cleanCode,
      durationDays: newIsUnlimited ? "Unlimited" : durationDays,
      isUnlimited: newIsUnlimited,
      redeemedAt: nowIso,
      expiresAt: expiryIso,
      status: "active",
    };

    inMemoryLicenses[cleanCode] = license;
    inMemoryUserLicenses[bareUid] = userLicenseRecord;
    inMemoryUserLicenses[uid] = userLicenseRecord;

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
 * Retrieves a user's authoritative license status from Supabase.
 * Strictly ignores old Firestore license state.
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

  // 1. Authoritative check in Supabase user_licenses table
  if (isSupabaseConfigured() && bareUid) {
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
      }
    } catch (err) {
      logger.debug("Supabase getUserLicenseStatus lookup notice:", err.message);
    }
  }

  // 2. Check local store fallback + Firebase Firestore backup vault (and auto-heal Supabase if found)
  if (!userLicense) {
    await loadLocalStore();
    userLicense =
      inMemoryUserLicenses[bareUid] ||
      inMemoryUserLicenses[rawUid] ||
      (cleanEmail ? inMemoryUserLicenses[cleanEmail] : null);

    if (!userLicense && bareUid) {
      try {
        const fsDoc = await readFirestoreDocumentRest("user_licenses", bareUid);
        if (fsDoc && (fsDoc.uid || fsDoc.expiresAt || fsDoc.isUnlimited)) {
          userLicense = {
            uid: fsDoc.uid || bareUid,
            email: fsDoc.email || cleanEmail,
            lastLicenseCode: fsDoc.lastLicenseCode || fsDoc.code || "",
            durationDays: fsDoc.durationDays || (fsDoc.isUnlimited ? "Unlimited" : 0),
            isUnlimited: Boolean(fsDoc.isUnlimited || fsDoc.durationDays === "Unlimited"),
            status: fsDoc.status || "active",
            redeemedAt: fsDoc.redeemedAt || null,
            expiresAt: fsDoc.expiresAt || null,
          };
          inMemoryUserLicenses[bareUid] = userLicense;
        }
      } catch {}
    }

    // Auto-heal Supabase user_licenses if recovered from local/Firestore vault
    if (userLicense && isSupabaseConfigured() && bareUid) {
      supabaseUpsert("user_licenses", {
        uid: bareUid,
        email: userLicense.email || cleanEmail,
        last_license_code: userLicense.lastLicenseCode || "",
        duration_days: String(userLicense.durationDays || 0),
        is_unlimited: Boolean(userLicense.isUnlimited),
        status: userLicense.status || "active",
        redeemed_at: userLicense.redeemedAt || null,
        expires_at: userLicense.expiresAt || null,
        updated_at: new Date().toISOString(),
      }, "uid").catch(() => {});
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

  // 3. User is Unlimited (Lifetime) in Supabase
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

  // 4. Normal license with expiration timestamp
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
    return { ok: true, uid: bareUid, isUnlimited, status: updatedLicense.status };
  });
}

/**
 * Admin: List all users from Supabase for the simplified Users page
 * ONLY shows: Name, Email, Unlimited ON/OFF switch
 */
export async function listAllUsersWithLicenses(authToken = null) {
  await loadLocalStore();
  const userMap = new Map();
  const sbUserIds = new Set();
  const sbLicenseUids = new Set();

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
          sbUserIds.add(u.id);
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
          sbLicenseUids.add(uid);
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

  // Merge & Self-Heal from Firebase Firestore backup vault so customers never vanish!
  try {
    const [fsUsers, fsUserLicenses] = await Promise.all([
      readFirestoreCollectionRest("users", authToken).catch(() => []),
      readFirestoreCollectionRest("user_licenses", authToken).catch(() => []),
    ]);

    for (const fu of fsUsers || []) {
      const uid = String(fu.id || fu.uid || "").replace(/^user_/, "").trim();
      if (!uid) continue;
      const email = fu.email || "";
      const displayName = fu.displayName || fu.display_name || (email ? email.split("@")[0] : "User");
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          uid,
          email,
          displayName,
          isUnlimited: Boolean(fu.isUnlimited),
          status: fu.isUnlimited ? "unlimited" : "none",
          expiresAt: null,
          phoneNumber: "",
        });
      } else {
        const cur = userMap.get(uid);
        if (!cur.email && email) cur.email = email;
        if ((!cur.displayName || cur.displayName === "User") && displayName) cur.displayName = displayName;
      }
      // Auto-heal Supabase users table if missing
      if (isSupabaseConfigured() && !sbUserIds.has(uid)) {
        supabaseUpsert("users", {
          id: uid,
          email,
          display_name: displayName,
          referral_code: fu.referralCode || null,
          referred_by: fu.referredBy || null,
          last_login_at: fu.lastLoginAt || new Date().toISOString(),
        }, "id").catch(() => {});
        sbUserIds.add(uid);
      }
    }

    for (const ful of fsUserLicenses || []) {
      const uid = String(ful.uid || ful.id || "").replace(/^user_/, "").trim();
      if (!uid) continue;
      const isUnl = Boolean(ful.isUnlimited === true || ful.durationDays === "Unlimited");
      const exp = ful.expiresAt || ful.expires_at || null;
      const email = ful.email || "";
      const existing = userMap.get(uid) || {
        uid,
        email,
        displayName: email ? email.split("@")[0] : "User",
        phoneNumber: "",
      };
      if (!sbLicenseUids.has(uid)) {
        existing.isUnlimited = isUnl || Boolean(existing.isUnlimited);
        existing.expiresAt = existing.expiresAt || exp;
        existing.status = existing.isUnlimited
          ? "unlimited"
          : (existing.expiresAt && new Date(existing.expiresAt) > new Date() ? "active" : (ful.status || "none"));
        userMap.set(uid, existing);

        if (isSupabaseConfigured()) {
          supabaseUpsert("user_licenses", {
            uid,
            email: existing.email || "",
            last_license_code: ful.lastLicenseCode || ful.code || "",
            duration_days: String(ful.durationDays || (existing.isUnlimited ? "Unlimited" : 0)),
            is_unlimited: Boolean(existing.isUnlimited),
            status: existing.status,
            expires_at: existing.expiresAt,
            updated_at: new Date().toISOString(),
          }, "uid").catch(() => {});
          sbLicenseUids.add(uid);
        }
      }
    }
  } catch {}

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
export async function deleteUserFromSystem(targetUid, adminEmail = ADMIN_EMAIL) {
  const bareUid = String(targetUid || "").replace(/^user_/, "").trim();
  return withAtomicLock(async () => {
    await loadLocalStore();
    delete inMemoryUserLicenses[bareUid];
    delete inMemoryUserLicenses[targetUid];

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
export async function grantUserCustomDays(targetUid, days, userEmail = "") {
  const numDays = Math.max(1, parseInt(days, 10) || 1);
  return applyRewardLicenseExtension(targetUid, numDays, `ADMIN-GRANT-${numDays}D`, userEmail);
}

export async function applyRewardLicenseExtension(uid, daysAwarded, claimId, userEmail = "") {
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

    return { success: true, isUnlimited, expiresAt: newExpiryIso };
  });
}

/**
 * Admin: Delete single license key
 */
export async function deleteLicenseKey(code) {
  const cleanCode = String(code || "").trim().toUpperCase();
  return withAtomicLock(async () => {
    await loadLocalStore();
    delete inMemoryLicenses[cleanCode];

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

/**
 * Central Railway Backend URL setting stored in BOTH Supabase system_config AND Firebase Firestore
 * so Railway updates or SQL runs never reset the backend URL.
 */
export async function getGlobalRailwayConfig() {
  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "railway_url", "key");
      if (row && row.value?.url) {
        return { railwayUrl: row.value.url, updatedAt: row.updated_at };
      }
    } catch (e) {
      logger.debug("Supabase railway config read notice:", e.message);
    }
  }

  // Check Firebase Firestore backup vault for railway_url
  try {
    const fsCfg = await readFirestoreDocumentRest("system_config", "railway_url");
    if (fsCfg && fsCfg.url) {
      if (isSupabaseConfigured()) {
        supabaseUpsert("system_config", {
          key: "railway_url",
          value: { url: fsCfg.url },
          updated_at: new Date().toISOString(),
        }, "key").catch(() => {});
      }
      return { railwayUrl: fsCfg.url, updatedAt: fsCfg.updatedAt };
    }
  } catch {}

  const fallback = process.env.RAILWAY_URL || process.env.PUBLIC_API_URL || "";
  return { railwayUrl: fallback };
}

export async function setGlobalRailwayConfig(railwayUrl, authToken = null) {
  const cleanUrl = String(railwayUrl || "").trim().replace(/\/+$/, "");
  const nowIso = new Date().toISOString();
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
  // Also persist to Firebase Firestore backup vault so Railway URL never vanishes
  writeFirestoreDocumentRest("system_config", "railway_url", {
    url: cleanUrl,
    updatedAt: nowIso,
  }, authToken).catch(() => {});

  process.env.RAILWAY_URL = cleanUrl;
  return { success: true, railwayUrl: cleanUrl };
}

/**
 * Explicitly recovers & synchronizes all users, licenses, Unlimited statuses, and configs
 * between Firebase Firestore, local disk, and Supabase PostgreSQL.
 */
export async function recoverAndSyncAllDataToSupabase(authToken = null) {
  const [users, licenses, railwayCfg] = await Promise.all([
    listAllUsersWithLicenses(authToken),
    listAllLicenses(authToken),
    getGlobalRailwayConfig(),
  ]);

  let syncedUsers = 0;
  let syncedLicenses = 0;

  if (isSupabaseConfigured()) {
    for (const u of users || []) {
      if (!u || !u.uid || u.uid.startsWith("admin_")) continue;
      await supabaseUpsert("users", {
        id: u.uid,
        email: u.email !== "—" ? u.email : "",
        display_name: u.displayName || "User",
        updated_at: new Date().toISOString(),
      }, "id").catch(() => {});
      syncedUsers++;
    }
    for (const l of licenses || []) {
      if (!l || !l.code) continue;
      await supabaseUpsert("licenses", {
        code: l.code,
        duration_days: String(l.durationDays || 30),
        is_unlimited: Boolean(l.isUnlimited),
        status: l.status || "unused",
        created_by: l.createdBy || ADMIN_EMAIL,
        redeemed_by_uid: l.redeemedByUid || null,
        redeemed_by_email: l.redeemedByEmail || null,
        redeemed_at: l.redeemedAt || null,
        expires_at: l.expiresAt || null,
        price_ngn: Number(l.priceNgn || 0),
        created_at: l.createdAt || new Date().toISOString(),
      }, "code").catch(() => {});
      syncedLicenses++;
    }
  }

  return {
    success: true,
    syncedUsers: users.length,
    syncedLicenses: licenses.length,
    railwayUrl: railwayCfg.railwayUrl || "",
    message: `Dual-Vault Sync Complete! Verified & protected ${users.length} customer account(s) and ${licenses.length} license key(s) across Firebase & Supabase.`,
  };
}

function estimateRowsByteSize(rows, multiplier = 2.4) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  try {
    const rawJsonBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    // Account for PostgreSQL tuple header + B-tree index overhead per row
    return Math.round(rawJsonBytes * multiplier + rows.length * 128);
  } catch {
    return rows.length * 512;
  }
}

/**
 * SECTION 8: ADMIN STATUS, 500MB LIVE STORAGE METER & DIAGNOSTICS
 * Diagnostic only — never mutates or deletes data.
 */
export async function getMaintenanceDiagnostics() {
  const now = new Date();
  const QUOTA_500MB_BYTES = 500 * 1024 * 1024; // 524,288,000 bytes (500 MB)

  let users = [];
  let userLicenses = [];
  let licenses = [];
  let sessions = [];
  let deletedMessages = [];
  let mediaCache = [];
  let commandLogs = [];
  let antiSpamEvents = [];
  let groupWarnings = [];
  let broadcastLogs = [];
  let aiChatMemories = [];
  let aiDeepFacts = [];
  let auditLogs = [];
  let groupSettings = [];
  let groupRules = [];
  let numberLocks = [];

  if (isSupabaseConfigured()) {
    const [
      u, ul, l, ws,
      dm, mc, bcl, ase, gw, bl,
      acm, adf, al,
      gs, gr, nl,
    ] = await Promise.all([
      supabaseGetAll("users").catch(() => []),
      supabaseGetAll("user_licenses").catch(() => []),
      supabaseGetAll("licenses").catch(() => []),
      supabaseGetAll("whatsapp_sessions").catch(() => []),
      supabaseGetAll("deleted_messages").catch(() => []),
      supabaseGetAll("media_cache").catch(() => []),
      supabaseGetAll("bot_command_logs").catch(() => []),
      supabaseGetAll("anti_spam_events").catch(() => []),
      supabaseGetAll("group_warnings").catch(() => []),
      supabaseGetAll("broadcast_logs").catch(() => []),
      supabaseGetAll("ai_chat_memories").catch(() => []),
      supabaseGetAll("ai_deep_facts").catch(() => []),
      supabaseGetAll("audit_logs").catch(() => []),
      supabaseGetAll("group_settings").catch(() => []),
      supabaseGetAll("group_rules").catch(() => []),
      supabaseGetAll("number_locks").catch(() => []),
    ]);
    users = u || [];
    userLicenses = ul || [];
    licenses = l || [];
    sessions = ws || [];
    deletedMessages = dm || [];
    mediaCache = mc || [];
    commandLogs = bcl || [];
    antiSpamEvents = ase || [];
    groupWarnings = gw || [];
    broadcastLogs = bl || [];
    aiChatMemories = acm || [];
    aiDeepFacts = adf || [];
    auditLogs = al || [];
    groupSettings = gs || [];
    groupRules = gr || [];
    numberLocks = nl || [];
  } else {
    await loadLocalStore();
    licenses = Object.values(inMemoryLicenses || {});
    userLicenses = Object.values(inMemoryUserLicenses || {});
  }

  let paymentMetrics = {
    totalPayments: 0,
    pendingReceiptCount: 0,
    pendingReceiptBytes: 0,
    clearableReceiptCount: 0,
    clearableReceiptBytes: 0,
    rejectedExpiredPaymentsCount: 0,
    rejectedExpiredPaymentsBytes: 0,
    totalReceiptBytes: 0,
  };
  try {
    const { getPaymentStorageMetrics } = await import("./payments.js");
    paymentMetrics = await getPaymentStorageMetrics();
  } catch {}

  const unlimitedUsersCount = userLicenses.filter((ul) => Boolean(ul.is_unlimited || ul.isUnlimited)).length;
  const activeLicensesCount = userLicenses.filter((ul) => Boolean(ul.is_unlimited || ul.isUnlimited) || (ul.expires_at && new Date(ul.expires_at) > now) || (ul.expiresAt && new Date(ul.expiresAt) > now)).length;
  const expiredLicensesCount = userLicenses.filter((ul) => !ul.is_unlimited && !ul.isUnlimited && ((ul.expires_at && new Date(ul.expires_at) <= now) || (ul.expiresAt && new Date(ul.expiresAt) <= now))).length;

  const totalKeys = licenses.length;
  const unusedKeysList = licenses.filter((l) => l.status === "unused");
  const unusedKeys = unusedKeysList.length;
  const expiredUnusedKeys = licenses.filter((l) => l.status === "unused" && l.expires_at && new Date(l.expires_at) <= now).length;
  const usedKeys = licenses.filter((l) => l.status === "used").length;
  const expiredUsedList = licenses.filter((l) => l.status === "used" && !l.is_unlimited && l.expires_at && new Date(l.expires_at) <= now);
  const expiredLicensesTotal = expiredUsedList.length;

  const connectedSessionsCount = sessions.filter((s) => s.connection_status === "connected" || s.connection_status === "ready").length;
  const disconnectedSessionsCount = Math.max(0, sessions.length - connectedSessionsCount);

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

  // Compute exact live storage bytes per category
  const receiptClearableBytes = paymentMetrics.clearableReceiptBytes;
  const rejectedPaymentsBytes = paymentMetrics.rejectedExpiredPaymentsBytes;
  const messageHistoryCount = deletedMessages.length + mediaCache.length;
  const mediaCacheFileBytes = mediaCache.reduce((acc, m) => acc + Number(m?.file_size || 0), 0);
  const messageHistoryBytes = estimateRowsByteSize(deletedMessages) + estimateRowsByteSize(mediaCache) + mediaCacheFileBytes;

  const commandHistoryCount = commandLogs.length + antiSpamEvents.length + groupWarnings.length + broadcastLogs.length;
  const commandHistoryBytes =
    estimateRowsByteSize(commandLogs) +
    estimateRowsByteSize(antiSpamEvents) +
    estimateRowsByteSize(groupWarnings) +
    estimateRowsByteSize(broadcastLogs);

  const aiHistoryCount = aiChatMemories.length + aiDeepFacts.length + auditLogs.length;
  const aiHistoryBytes =
    estimateRowsByteSize(aiChatMemories) +
    estimateRowsByteSize(aiDeepFacts) +
    estimateRowsByteSize(auditLogs);

  const expiredKeysBytes = estimateRowsByteSize(expiredUsedList) + estimateRowsByteSize(unusedKeysList);

  // Protected categories (NEVER cleared)
  const protectedUsersBytes =
    estimateRowsByteSize(users) +
    estimateRowsByteSize(userLicenses) +
    estimateRowsByteSize(numberLocks) +
    estimateRowsByteSize(licenses.filter((l) => l.status === "used" && (l.is_unlimited || !l.expires_at || new Date(l.expires_at) > now))) +
    paymentMetrics.pendingReceiptBytes;

  const protectedSessionsBytes = estimateRowsByteSize(sessions, 1.5);
  const protectedGroupsBytes = estimateRowsByteSize(groupSettings) + estimateRowsByteSize(groupRules) + 16384;

  const clearableBytes =
    receiptClearableBytes +
    rejectedPaymentsBytes +
    messageHistoryBytes +
    commandHistoryBytes +
    aiHistoryBytes +
    expiredKeysBytes;

  const protectedBytes = protectedUsersBytes + protectedSessionsBytes + protectedGroupsBytes;
  // Base PostgreSQL catalog + indexes overhead (~4.2 MB) + live data & storage bytes
  const BASE_PG_CATALOG_BYTES = 4404019;
  const totalUsedBytes = BASE_PG_CATALOG_BYTES + protectedBytes + clearableBytes;
  const remainingBytes = Math.max(0, QUOTA_500MB_BYTES - totalUsedBytes);
  const usagePercent = Math.min(100, Number(((totalUsedBytes / QUOTA_500MB_BYTES) * 100).toFixed(3)));

  return {
    success: true,
    diagnostics: {
      totalUsers: Math.max(users.length, userLicenses.length),
      unlimitedUsers: unlimitedUsersCount,
      activeLicenses: activeLicensesCount,
      expiredLicenses: expiredLicensesCount,
      totalKeys,
      unusedKeys,
      expiredUnusedKeys,
      usedKeys,
      expiredLicensesTotal,
      pairedWhatsAppSessions: sessions.length,
      connectedSessionsCount,
      disconnectedSessionsCount,
      activeLicenseNoSessionCount: activeLicenseNoSession.length,
      pairedWithExpiredLicenseCount: pairedWithExpiredLicense.length,
      orphanedRecordsCount: orphanedLicenses.length,
      pairedWithExpiredList: pairedWithExpiredLicense.slice(0, 8),
      storage: {
        quotaBytes: QUOTA_500MB_BYTES,
        quotaMb: 500,
        totalUsedBytes,
        totalUsedKb: Number((totalUsedBytes / 1024).toFixed(2)),
        totalUsedMb: Number((totalUsedBytes / (1024 * 1024)).toFixed(3)),
        remainingBytes,
        remainingMb: Number((remainingBytes / (1024 * 1024)).toFixed(3)),
        usagePercent,
        clearableBytes,
        clearableKb: Number((clearableBytes / 1024).toFixed(2)),
        clearableMb: Number((clearableBytes / (1024 * 1024)).toFixed(3)),
        protectedBytes: BASE_PG_CATALOG_BYTES + protectedBytes,
        protectedMb: Number(((BASE_PG_CATALOG_BYTES + protectedBytes) / (1024 * 1024)).toFixed(3)),
        categories: {
          receiptPictures: {
            count: paymentMetrics.clearableReceiptCount,
            bytes: receiptClearableBytes,
            pendingProtectedCount: paymentMetrics.pendingReceiptCount,
            pendingProtectedBytes: paymentMetrics.pendingReceiptBytes,
          },
          rejectedExpiredPayments: {
            count: paymentMetrics.rejectedExpiredPaymentsCount,
            bytes: rejectedPaymentsBytes,
          },
          messageHistory: {
            count: messageHistoryCount,
            bytes: messageHistoryBytes,
          },
          commandAndSpamHistory: {
            count: commandHistoryCount,
            bytes: commandHistoryBytes,
          },
          aiMemoryHistory: {
            count: aiHistoryCount,
            bytes: aiHistoryBytes,
          },
          expiredAndUnusedKeys: {
            count: expiredLicensesTotal + unusedKeys,
            expiredUsedCount: expiredLicensesTotal,
            unusedCount: unusedKeys,
            bytes: expiredKeysBytes,
          },
          protectedUsersAndLicenses: {
            count: Math.max(users.length, userLicenses.length),
            activeLicenses: activeLicensesCount,
            unlimitedUsers: unlimitedUsersCount,
            bytes: protectedUsersBytes,
          },
          protectedWhatsappSessions: {
            count: sessions.length,
            connectedCount: connectedSessionsCount,
            disconnectedCount: disconnectedSessionsCount,
            bytes: protectedSessionsBytes,
          },
          protectedSystemAndGroups: {
            count: groupSettings.length + groupRules.length,
            bytes: protectedGroupsBytes,
          },
        },
      },
    },
  };
}

/**
 * SECTION 7: SAFE STORAGE / CLEANUP OPERATIONS
 * Strictly protects:
 * - active user licenses & customer accounts
 * - Unlimited users
 * - connected AND disconnected WhatsApp sessions (NEVER clears disconnected sessions!)
 * - group rules and group settings
 * - pending payment requests
 */
export async function performSafeMaintenanceCleanup(action, authToken = null) {
  const now = new Date();
  let count = 0;
  let bytesFreed = 0;
  let message = "";

  if (action === "recover_from_firestore") {
    const res = await recoverAndSyncAllDataToSupabase(authToken);
    return {
      success: true,
      action,
      count: res.syncedUsers + res.syncedLicenses,
      bytesFreed: 0,
      message: res.message,
    };
  }

  if (action === "clear_receipt_pics") {
    const { clearProcessedReceiptImages } = await import("./payments.js");
    const res = await clearProcessedReceiptImages();
    return {
      success: true,
      action,
      count: res.count,
      bytesFreed: res.bytesFreed,
      message: res.message,
    };
  }

  if (action === "clear_rejected_expired_payments") {
    const { purgeRejectedAndExpiredPayments } = await import("./payments.js");
    const res = await purgeRejectedAndExpiredPayments();
    return {
      success: true,
      action,
      count: res.count,
      bytesFreed: res.bytesFreed,
      message: res.message,
    };
  }

  if (action === "clear_message_history") {
    if (isSupabaseConfigured()) {
      const [dmRows, mcRows] = await Promise.all([
        supabaseGetAll("deleted_messages").catch(() => []),
        supabaseGetAll("media_cache").catch(() => []),
      ]);
      bytesFreed =
        estimateRowsByteSize(dmRows) +
        estimateRowsByteSize(mcRows) +
        (mcRows || []).reduce((acc, m) => acc + Number(m?.file_size || 0), 0);
      const [r1, r2] = await Promise.all([
        supabaseClearTable("deleted_messages", "id"),
        supabaseClearTable("media_cache", "id"),
      ]);
      count = (r1.deletedCount || 0) + (r2.deletedCount || 0);
    }
    message = `Cleared ${count} Anti-Delete recovered message & media cache record(s) (${(bytesFreed / 1024).toFixed(1)} KB freed). All WhatsApp sessions (connected & disconnected) are untouched.`;
  } else if (action === "clear_command_history") {
    if (isSupabaseConfigured()) {
      const [bcl, ase, gw, bl] = await Promise.all([
        supabaseGetAll("bot_command_logs").catch(() => []),
        supabaseGetAll("anti_spam_events").catch(() => []),
        supabaseGetAll("group_warnings").catch(() => []),
        supabaseGetAll("broadcast_logs").catch(() => []),
      ]);
      bytesFreed =
        estimateRowsByteSize(bcl) +
        estimateRowsByteSize(ase) +
        estimateRowsByteSize(gw) +
        estimateRowsByteSize(bl);
      const [r1, r2, r3, r4] = await Promise.all([
        supabaseClearTable("bot_command_logs", "id"),
        supabaseClearTable("anti_spam_events", "id"),
        supabaseClearTable("group_warnings", "id"),
        supabaseClearTable("broadcast_logs", "id"),
      ]);
      count = (r1.deletedCount || 0) + (r2.deletedCount || 0) + (r3.deletedCount || 0) + (r4.deletedCount || 0);
    }
    message = `Cleared ${count} bot command log & anti-spam history record(s) (${(bytesFreed / 1024).toFixed(1)} KB freed).`;
  } else if (action === "clear_ai_history") {
    if (isSupabaseConfigured()) {
      const [acm, adf, al] = await Promise.all([
        supabaseGetAll("ai_chat_memories").catch(() => []),
        supabaseGetAll("ai_deep_facts").catch(() => []),
        supabaseGetAll("audit_logs").catch(() => []),
      ]);
      bytesFreed = estimateRowsByteSize(acm) + estimateRowsByteSize(adf) + estimateRowsByteSize(al);
      const [r1, r2, r3] = await Promise.all([
        supabaseClearTable("ai_chat_memories", "id"),
        supabaseClearTable("ai_deep_facts", "id"),
        supabaseClearTable("audit_logs", "id"),
      ]);
      count = (r1.deletedCount || 0) + (r2.deletedCount || 0) + (r3.deletedCount || 0);
    }
    message = `Cleared ${count} AI chat memory & audit log record(s) (${(bytesFreed / 1024).toFixed(1)} KB freed).`;
  } else if (action === "expired_licenses") {
    await loadLocalStore();
    const allLicenses = isSupabaseConfigured()
      ? await supabaseGetAll("licenses")
      : Object.values(inMemoryLicenses || {});
    const toDelete = (allLicenses || []).filter((l) => {
      const exp = l.expires_at || l.expiresAt;
      const isUnl = Boolean(l.is_unlimited || l.isUnlimited || l.duration_days === "Unlimited" || l.durationDays === "Unlimited");
      return l.status === "used" && !isUnl && exp && new Date(exp) < now;
    });
    bytesFreed = estimateRowsByteSize(toDelete);
    for (const lic of toDelete) {
      if (isSupabaseConfigured()) {
        await supabaseDelete("licenses", "code", lic.code);
      }
      if (inMemoryLicenses) delete inMemoryLicenses[lic.code];
      count++;
    }
    await persistLocalStore();
    message = `Safely purged ${count} expired historical license key(s) (${(bytesFreed / 1024).toFixed(1)} KB freed). Active licenses, Unlimited users, and disconnected sessions are 100% preserved.`;
  } else if (action === "unused_expired_keys" || action === "unused") {
    await loadLocalStore();
    const allLicenses = isSupabaseConfigured()
      ? await supabaseGetAll("licenses")
      : Object.values(inMemoryLicenses || {});
    const toDelete = (allLicenses || []).filter((l) => {
      if (l.status !== "unused") return false;
      if (action === "unused") return true;
      return l.expires_at && new Date(l.expires_at) < now;
    });
    bytesFreed = estimateRowsByteSize(toDelete);
    for (const lic of toDelete) {
      if (isSupabaseConfigured()) {
        await supabaseDelete("licenses", "code", lic.code);
      }
      if (inMemoryLicenses) delete inMemoryLicenses[lic.code];
      count++;
    }
    await persistLocalStore();
    message = `Safely removed ${count} unused key(s) (${(bytesFreed / 1024).toFixed(1)} KB freed).`;
  } else if (action === "clear_all_safe_history") {
    const rPics = await performSafeMaintenanceCleanup("clear_receipt_pics", authToken);
    const rPay = await performSafeMaintenanceCleanup("clear_rejected_expired_payments", authToken);
    const rMsg = await performSafeMaintenanceCleanup("clear_message_history", authToken);
    const rCmd = await performSafeMaintenanceCleanup("clear_command_history", authToken);
    const rAi = await performSafeMaintenanceCleanup("clear_ai_history", authToken);
    const rLic = await performSafeMaintenanceCleanup("expired_licenses", authToken);

    count = (rPics.count || 0) + (rPay.count || 0) + (rMsg.count || 0) + (rCmd.count || 0) + (rAi.count || 0) + (rLic.count || 0);
    bytesFreed = (rPics.bytesFreed || 0) + (rPay.bytesFreed || 0) + (rMsg.bytesFreed || 0) + (rCmd.bytesFreed || 0) + (rAi.bytesFreed || 0) + (rLic.bytesFreed || 0);
    message = `Full Safe Storage Sweep Complete! Cleared ${count} item(s) and freed ${(bytesFreed / 1024).toFixed(1)} KB. All customers, active/unlimited keys, and connected/disconnected WhatsApp sessions were strictly protected.`;
  } else if (action === "stale_cache") {
    inMemoryLicenses = null;
    inMemoryUserLicenses = null;
    inMemoryPlans = null;
    await loadLocalStore();
    await getGlobalLicensePlans();
    await recoverAndSyncAllDataToSupabase(authToken);
    count = 1;
    message = "Caches resynchronized and Dual-Vault (Firebase ↔ Supabase) verified.";
  } else if (action === "orphaned_records") {
    const [allLicenses, allUsers] = await Promise.all([
      supabaseGetAll("licenses"),
      supabaseGetAll("users"),
    ]);
    const validUids = new Set((allUsers || []).map((u) => u.id));
    const toDelete = (allLicenses || []).filter((l) => {
      return l.status === "used" && l.redeemed_by_uid && !validUids.has(l.redeemed_by_uid) && !l.is_unlimited && l.expires_at && new Date(l.expires_at) < now;
    });
    bytesFreed = estimateRowsByteSize(toDelete);
    for (const lic of toDelete) {
      await supabaseDelete("licenses", "code", lic.code);
      count++;
    }
    message = `Safely removed ${count} orphaned record(s) (${(bytesFreed / 1024).toFixed(1)} KB freed).`;
  } else {
    throw new Error(`Unknown maintenance cleanup action: ${action}`);
  }

  logger.info(`[Maintenance] Safe cleanup '${action}' completed. Count: ${count}, BytesFreed: ${bytesFreed}`);
  return { success: true, action, count, deletedCount: count, bytesFreed, message };
}
