import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { getFirebaseServerFirestore, writeFirestoreDocumentRest, readFirestoreCollectionRest, ADMIN_EMAIL, isAdminEmail } from "./auth.js";

export { ADMIN_EMAIL };

// Local persistent file fallback (ensures durability on disk if Firestore REST is unreachable)
const LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-licenses.json");
const USER_LICENSES_FILE = path.join(DATA_DIR, "data", "solvatech-user-licenses.json");

// In-memory cache & write locks to prevent race conditions during redemptions
let inMemoryLicenses = null;
let inMemoryUserLicenses = null;
let licenseOperationQueue = Promise.resolve();

/**
 * Generates an unguessable, cryptographically random license code.
 * Format: SOLVA-XXXX-XXXX-XXXX (Base32 alphabet excluding easily confusable chars)
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

/**
 * Synchronizes queue execution to guarantee atomic operations
 */
function withAtomicLock(fn) {
  const next = licenseOperationQueue.then(() => fn()).catch((err) => {
    logger.error("License atomic operation error", err.stack || err.message);
    throw err;
  });
  licenseOperationQueue = next.then(() => {}).catch(() => {});
  return next;
}

/**
 * Reads data from local JSON fallback
 */
async function loadLocalStore() {
  if (!inMemoryLicenses) {
    try {
      if (fsSync.existsSync(LICENSES_FILE)) {
        const raw = await fs.readFile(LICENSES_FILE, "utf8");
        inMemoryLicenses = JSON.parse(raw);
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
        const raw = await fs.readFile(USER_LICENSES_FILE, "utf8");
        inMemoryUserLicenses = JSON.parse(raw);
      } else {
        inMemoryUserLicenses = {};
      }
    } catch {
      inMemoryUserLicenses = {};
    }
  }
}

/**
 * Persists local cache to disk
 */
async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LICENSES_FILE), { recursive: true });
    await fs.writeFile(LICENSES_FILE, JSON.stringify(inMemoryLicenses || {}, null, 2));
    await fs.writeFile(USER_LICENSES_FILE, JSON.stringify(inMemoryUserLicenses || {}, null, 2));
  } catch (err) {
    logger.error("Failed to persist local license store", err.message);
  }
}

/**
 * Formats a duration in milliseconds into a readable human string
 * e.g., "3 Days 6 Hours 20 Minutes left"
 */
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
 * Admin: Generates a new license record
 */
export async function createLicenseRecord(durationDays, createdByEmail, authToken = null) {
  const days = parseInt(durationDays, 10);
  if (isNaN(days) || days <= 0 || days > 365) {
    throw new Error("Invalid duration. Duration must be between 1 and 365 days.");
  }

  return withAtomicLock(async () => {
    await loadLocalStore();

    const code = generateCryptographicCode();
    const nowIso = new Date().toISOString();

    const licenseData = {
      code,
      durationDays: days,
      createdAt: nowIso,
      createdBy: createdByEmail || ADMIN_EMAIL,
      status: "unused", // 'unused' | 'used'
      redeemedByUid: null,
      redeemedByEmail: null,
      redeemedAt: null,
      expiresAt: null,
    };

    // Store in Firestore REST API directly with caller's ID token or API key
    await writeFirestoreDocumentRest("licenses", code, licenseData, authToken);

    // Also attempt Client SDK write
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "licenses", code), licenseData);
      } catch (err) {
        logger.debug("Firestore client SDK write notice", err.message);
      }
    }

    inMemoryLicenses[code] = licenseData;
    await persistLocalStore();

    return licenseData;
  });
}

/**
 * Admin: Lists all licenses (newest first)
 */
export async function listAllLicenses() {
  await loadLocalStore();
  
  // Two-way sync with Firestore
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs, doc, setDoc } = await import("firebase/firestore");
      const snap = await getDocs(collection(db, "licenses"));
      const firestoreCodes = new Set();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.code) {
          firestoreCodes.add(data.code);
          inMemoryLicenses[data.code] = { 
            ...(inMemoryLicenses[data.code] || {}), 
            ...data 
          };
        }
      });

      // Self-healing: push any local-only licenses up to Firestore
      for (const [code, licenseData] of Object.entries(inMemoryLicenses || {})) {
        if (!firestoreCodes.has(code)) {
          try {
            await setDoc(doc(db, "licenses", code), licenseData);
          } catch (syncErr) {
            logger.debug("Could not push local license to Firestore during sync", syncErr.message);
          }
        }
      }

      await persistLocalStore();
    } catch (err) {
      logger.warn("Firestore licenses read/sync notice", err.message);
    }
  }

  return Object.values(inMemoryLicenses || {}).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Atomically redeems a license code for a verified Firebase user.
 * 
 * Guarantees:
 * - Reject invalid codes
 * - Reject already-used codes
 * - Atomic execution: exactly ONE concurrent request succeeds
 * - Never allows used code to become unused
 * - Calculates expiry server-side
 * - Extends existing active license duration if user already has one, or starts from now
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
  const email = verifiedUser.email || "";

  return withAtomicLock(async () => {
    await loadLocalStore();

    let cleanCode = rawClean;
    let license = inMemoryLicenses[cleanCode];

    // Flexible fallback: match code by stripping dashes/spaces
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

    // Check Firestore for authoritative record if not found locally or to sync
    const db = getFirebaseServerFirestore();
    if (db && !license) {
      try {
        const { doc, getDoc, collection, getDocs } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "licenses", cleanCode));
        if (docSnap.exists()) {
          license = docSnap.data();
          cleanCode = docSnap.id;
          inMemoryLicenses[cleanCode] = license;
        } else {
          // Query licenses collection in case formatting differs in document ID
          const snap = await getDocs(collection(db, "licenses"));
          snap.forEach((d) => {
            const dKeyStripped = d.id.replace(/[^A-Z0-9]/g, "");
            if (dKeyStripped === strippedCode || dKeyStripped.replace(/^SOLVA/, "") === strippedCode.replace(/^SOLVA/, "")) {
              cleanCode = d.id;
              license = d.data();
              inMemoryLicenses[cleanCode] = license;
            }
          });
        }
      } catch (err) {
        logger.debug("Firestore getDoc error", err.message);
      }
    }

    if (!license) {
      const err = new Error("Invalid license code. Please check the characters and try again.");
      err.code = "LICENSE_NOT_FOUND";
      throw err;
    }

    if (license.status === "used" || license.redeemedByUid) {
      const err = new Error("This license code has already been redeemed and cannot be used again.");
      err.code = "LICENSE_ALREADY_USED";
      throw err;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const durationDays = Number(license.durationDays) || 1;
    const durationMs = durationDays * 24 * 60 * 60 * 1000;

    // Check user's current license to handle extensions cleanly
    let existingUserLicense = inMemoryUserLicenses[uid];
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "user_licenses", uid));
        if (uSnap.exists()) {
          existingUserLicense = uSnap.data();
          inMemoryUserLicenses[uid] = existingUserLicense;
        }
      } catch (err) {
        logger.debug("Firestore user license check notice", err.message);
      }
    }

    let startTimestamp = now.getTime();
    if (existingUserLicense && existingUserLicense.expiresAt) {
      const currentExpiry = new Date(existingUserLicense.expiresAt).getTime();
      if (currentExpiry > startTimestamp) {
        // Extend existing valid license
        startTimestamp = currentExpiry;
      }
    }

    const expiryDate = new Date(startTimestamp + durationMs);
    const expiryIso = expiryDate.toISOString();

    // Update license record permanently
    license.status = "used";
    license.redeemedByUid = uid;
    license.redeemedByEmail = email;
    license.redeemedAt = nowIso;
    license.expiresAt = expiryIso;

    // Update user active license record
    const userLicenseRecord = {
      uid,
      email,
      lastLicenseCode: cleanCode,
      durationDays,
      redeemedAt: nowIso,
      expiresAt: expiryIso,
      status: "active",
    };

    inMemoryLicenses[cleanCode] = license;
    inMemoryUserLicenses[uid] = userLicenseRecord;

    // Sync to Firestore REST API atomically with caller's ID token
    await Promise.all([
      writeFirestoreDocumentRest("licenses", cleanCode, license, authToken),
      writeFirestoreDocumentRest("user_licenses", uid, userLicenseRecord, authToken),
      writeFirestoreDocumentRest("users", uid, { activeLicense: userLicenseRecord }, authToken),
    ]);

    // Also attempt Client SDK write
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "licenses", cleanCode), license),
          setDoc(doc(db, "user_licenses", uid), userLicenseRecord),
          setDoc(doc(db, "users", uid), { activeLicense: userLicenseRecord }, { merge: true }),
        ]);
      } catch (err) {
        logger.debug("Could not sync redemption via Firestore SDK", err.message);
      }
    }

    await persistLocalStore();

    // Record purchase for referral attribution (official qualifying amount derived from duration)
    try {
      const { recordPurchaseForReferral } = await import("./referral.js");
      await recordPurchaseForReferral(
        uid,
        durationDays,
        cleanCode,
        Boolean(license.isReward || license.isFree),
        email,
        authToken
      );
    } catch (refErr) {
      logger.warn("Referral purchase attribution notice", refErr.message);
    }

    const remainingMs = Math.max(0, expiryDate.getTime() - Date.now());

    return {
      success: true,
      message: `License successfully redeemed! Added ${durationDays} day(s).`,
      license: {
        code: cleanCode,
        durationDays,
        redeemedAt: nowIso,
        expiresAt: expiryIso,
        remainingMs,
        remainingFormatted: formatRemainingTime(remainingMs),
      },
    };
  });
}

/**
 * Gets a user's current license status derived server-side.
 * Admin account (awoyinfasolomon1@gmail.com) has automatic unlimited access.
 */
export async function getUserLicenseStatus(uid, email = "") {
  const isAdmin = isAdminEmail(email) || isAdminEmail(uid);

  if (isAdmin) {
    return {
      hasActiveLicense: true,
      status: "active",
      isAdmin: true,
      code: "ADMIN-UNLIMITED",
      durationDays: "Unlimited",
      redeemedAt: new Date().toISOString(),
      expiresAt: null,
      remainingMs: 3153600000000,
      remainingFormatted: "Unlimited (Admin Access)",
      serverTime: new Date().toISOString(),
    };
  }

  if (!uid && !email) return { hasActiveLicense: false, status: "none", isAdmin: false };

  await loadLocalStore();

  const rawUid = String(uid || "").trim();
  const bareUid = rawUid.replace(/^user_/, "");
  const safeUid = rawUid.startsWith("user_") ? rawUid : `user_${rawUid}`;
  const cleanEmail = String(email || "").trim().toLowerCase();

  let userLicense =
    inMemoryUserLicenses[rawUid] ||
    inMemoryUserLicenses[bareUid] ||
    inMemoryUserLicenses[safeUid] ||
    (cleanEmail ? inMemoryUserLicenses[cleanEmail] : null);

  if (!userLicense && cleanEmail) {
    userLicense = Object.values(inMemoryUserLicenses || {}).find(
      (u) => u?.email && u.email.trim().toLowerCase() === cleanEmail
    );
  }

  if (!userLicense) {
    userLicense = Object.values(inMemoryUserLicenses || {}).find(
      (u) => u?.uid === rawUid || u?.uid === bareUid || u?.uid === safeUid
    );
  }

  const db = getFirebaseServerFirestore();
  if (!userLicense) {
    try {
      // 1. Try REST API lookup first
      const [restLic, restUser] = await Promise.all([
        readFirestoreDocumentRest("user_licenses", bareUid || rawUid).catch(() => null),
        readFirestoreDocumentRest("users", bareUid || rawUid).catch(() => null),
      ]);
      if (restLic) {
        userLicense = restLic;
      } else if (restUser?.activeLicense) {
        userLicense = restUser.activeLicense;
      } else if (restUser?.isUnlimited) {
        userLicense = { isUnlimited: true, status: "active", durationDays: "Unlimited", email: restUser.email || cleanEmail };
      }

      // 2. Try Firestore Client SDK if still not found
      if (!userLicense && db) {
        const { doc, getDoc, collection, query, where, getDocs } = await import("firebase/firestore");
        if (bareUid || rawUid) {
          const uSnap = await getDoc(doc(db, "user_licenses", bareUid || rawUid));
          if (uSnap.exists()) {
            userLicense = uSnap.data();
          } else {
            const userSnap = await getDoc(doc(db, "users", bareUid || rawUid));
            if (userSnap.exists() && userSnap.data()?.activeLicense) {
              userLicense = userSnap.data().activeLicense;
            } else if (userSnap.exists() && userSnap.data()?.isUnlimited) {
              userLicense = { isUnlimited: true, status: "active", durationDays: "Unlimited", email: userSnap.data().email || cleanEmail };
            }
          }
        }
        if (!userLicense && cleanEmail) {
          const q = query(collection(db, "user_licenses"), where("email", "==", cleanEmail));
          const snap = await getDocs(q);
          if (!snap.empty) {
            userLicense = snap.docs[0].data();
          }
        }
      }

      if (userLicense) {
        inMemoryUserLicenses[rawUid] = userLicense;
        if (bareUid) inMemoryUserLicenses[bareUid] = userLicense;
        if (safeUid) inMemoryUserLicenses[safeUid] = userLicense;
        if (cleanEmail) inMemoryUserLicenses[cleanEmail] = userLicense;
      }
    } catch (err) {
      logger.debug("Firestore getUserLicenseStatus lookup note", err.message);
    }
  }

  if (!userLicense || (!userLicense.expiresAt && !userLicense.isUnlimited)) {
    return {
      hasActiveLicense: false,
      status: "no_license",
      isAdmin: false,
      message: "No active license",
      remainingMs: 0,
      remainingFormatted: null,
      expiresAt: null,
      serverTime: new Date().toISOString(),
    };
  }

  const isUnlimited = Boolean(userLicense.isUnlimited || userLicense.durationDays === "Unlimited");
  if (isUnlimited) {
    const savedDays = userLicense.savedNormalDays || (userLicense.savedRemainingMs ? Math.ceil(userLicense.savedRemainingMs / 86400000) : null);
    const remainingFormatted = savedDays && savedDays > 0 ? `Unlimited (${savedDays}d normal preserved)` : "Unlimited (Lifetime)";
    return {
      hasActiveLicense: true,
      status: "active",
      isUnlimited: true,
      isAdmin: false,
      code: userLicense.lastLicenseCode || "UNLIMITED-PASS",
      durationDays: "Unlimited",
      redeemedAt: userLicense.redeemedAt || null,
      expiresAt: userLicense.expiresAt || new Date(Date.now() + 100 * 365 * 86400000).toISOString(),
      remainingMs: 3153600000000,
      remainingFormatted,
      preservedNotice: savedDays && savedDays > 0 ? `Preserved: ${savedDays} normal days left` : "",
      savedNormalDays: userLicense.savedNormalDays || null,
      serverTime: new Date().toISOString(),
    };
  }

  const nowMs = Date.now();
  const expiryMs = new Date(userLicense.expiresAt).getTime();
  const remainingMs = Math.max(0, expiryMs - nowMs);
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

/**
 * Extends a user's license by a specific number of free reward days.
 * Does NOT generate referral credit (₦0 sales, no recursion).
 */
export async function applyRewardLicenseExtension(uid, daysAwarded, claimId, userEmail = "", authToken = null) {
  const days = Number(daysAwarded) || 3;
  const durationMs = days * 24 * 60 * 60 * 1000;

  return withAtomicLock(async () => {
    await loadLocalStore();

    const cleanEmail = (userEmail || "").trim().toLowerCase();
    const rawUid = String(uid || "").trim();
    const bareUid = rawUid.replace(/^user_/, "");
    const safeUid = rawUid.startsWith("user_") ? rawUid : `user_${rawUid}`;

    let existing =
      inMemoryUserLicenses[rawUid] ||
      inMemoryUserLicenses[bareUid] ||
      inMemoryUserLicenses[safeUid] ||
      (cleanEmail ? inMemoryUserLicenses[cleanEmail] : null);

    if (!existing && cleanEmail) {
      existing = Object.values(inMemoryUserLicenses || {}).find(
        (lic) => lic?.email && lic.email.toLowerCase() === cleanEmail
      );
    }

    const db = getFirebaseServerFirestore();
    if (!existing) {
      try {
        const [restLic, restUser] = await Promise.all([
          readFirestoreDocumentRest("user_licenses", bareUid || rawUid).catch(() => null),
          readFirestoreDocumentRest("users", bareUid || rawUid).catch(() => null),
        ]);
        if (restLic) {
          existing = restLic;
        } else if (restUser?.activeLicense) {
          existing = restUser.activeLicense;
        } else if (restUser?.isUnlimited) {
          existing = { isUnlimited: true, status: "active", durationDays: "Unlimited", email: restUser.email || cleanEmail };
        }

        if (!existing && db) {
          const { doc, getDoc } = await import("firebase/firestore");
          const uSnap = await getDoc(doc(db, "user_licenses", bareUid || rawUid));
          if (uSnap.exists()) {
            existing = uSnap.data();
          }
        }
      } catch (err) {
        logger.debug("Firestore user license lookup notice", err.message);
      }
    }

    const isCurrentlyUnlimited = Boolean(
      existing?.isUnlimited ||
      existing?.durationDays === "Unlimited" ||
      Number(existing?.durationDays) >= 9999
    );

    let updatedLicense;

    if (isCurrentlyUnlimited) {
      // User is already unlimited: Keep unlimited active and add days to preserved normal days!
      const currentSavedDays = Number(existing?.savedNormalDays) || 0;
      const newSavedDays = currentSavedDays + days;
      const newSavedMs = (existing?.savedRemainingMs || 0) + durationMs;
      const preservedNotice = `Preserved: ${newSavedDays} normal days left`;

      updatedLicense = {
        ...existing,
        uid: bareUid || rawUid,
        email: cleanEmail || existing?.email || "",
        isUnlimited: true,
        durationDays: "Unlimited",
        status: "active",
        expiresAt: existing?.expiresAt || new Date(Date.now() + 100 * 365 * 86400000).toISOString(),
        savedNormalDays: newSavedDays,
        savedRemainingMs: newSavedMs,
        preservedNotice,
        lastRewardClaimId: claimId,
        updatedAt: new Date().toISOString(),
      };
    } else {
      const now = Date.now();
      let startTimestamp = now;
      if (existing && existing.expiresAt) {
        const currentExpiry = new Date(existing.expiresAt).getTime();
        if (currentExpiry > startTimestamp) {
          // Extend existing active license
          startTimestamp = currentExpiry;
        }
      }

      const newExpiryDate = new Date(startTimestamp + durationMs);
      const newExpiryIso = newExpiryDate.toISOString();
      const existingDays = Number(existing?.durationDays);
      const totalDays = (isNaN(existingDays) ? 0 : existingDays) + days;

      updatedLicense = {
        ...existing,
        uid: bareUid || rawUid,
        email: cleanEmail || existing?.email || "",
        lastLicenseCode: `REWARD-${claimId || "CLAIM"}`,
        durationDays: totalDays,
        redeemedAt: existing?.redeemedAt || new Date().toISOString(),
        expiresAt: newExpiryIso,
        status: "active",
        isUnlimited: false,
        lastRewardClaimId: claimId,
        isReward: true,
        updatedAt: new Date().toISOString(),
      };
    }

    inMemoryUserLicenses[rawUid] = updatedLicense;
    if (bareUid) inMemoryUserLicenses[bareUid] = updatedLicense;
    if (safeUid) inMemoryUserLicenses[safeUid] = updatedLicense;
    if (cleanEmail) inMemoryUserLicenses[cleanEmail] = updatedLicense;

    const userEmailToSave = userEmail || existing?.email || "";
    const userDocPatch = {
      isUnlimited: updatedLicense.isUnlimited,
      activeLicense: updatedLicense,
      ...(userEmailToSave ? { email: userEmailToSave, displayName: userEmailToSave.split("@")[0] } : {}),
      updatedAt: new Date().toISOString(),
    };

    // Sync to Firestore REST API atomically
    await Promise.all([
      writeFirestoreDocumentRest("user_licenses", uid, updatedLicense, authToken),
      writeFirestoreDocumentRest("users", uid, userDocPatch, authToken),
    ]);

    // Also attempt Client SDK write
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "user_licenses", uid), updatedLicense, { merge: true }),
          setDoc(doc(db, "users", uid), userDocPatch, { merge: true }),
        ]);
      } catch (err) {
        logger.debug("Firestore SDK sync notice for reward extension", err.message);
      }
    }

    await persistLocalStore();

    return {
      previousExpiresAt: existing?.expiresAt || null,
      newExpiresAt: updatedLicense.expiresAt,
      isUnlimited: updatedLicense.isUnlimited,
      updatedLicense,
    };
  });
}

const SYSTEM_CONFIG_FILE = path.join(DATA_DIR, "data", "solvatech-system-config.json");
let inMemorySystemConfig = null;

export async function getGlobalRailwayConfig() {
  if (!inMemorySystemConfig) {
    try {
      if (fsSync.existsSync(SYSTEM_CONFIG_FILE)) {
        inMemorySystemConfig = JSON.parse(await fs.readFile(SYSTEM_CONFIG_FILE, "utf8"));
      } else {
        inMemorySystemConfig = { railwayUrl: process.env.RAILWAY_STATIC_URL || process.env.PUBLIC_API_URL || "" };
      }
    } catch {
      inMemorySystemConfig = { railwayUrl: "" };
    }
  }
  const db = getFirebaseServerFirestore();
  if (db && !inMemorySystemConfig.railwayUrl) {
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const cfgSnap = await getDoc(doc(db, "system_config", "railway"));
      if (cfgSnap.exists()) {
        inMemorySystemConfig.railwayUrl = cfgSnap.data().url || "";
      }
    } catch {}
  }
  return inMemorySystemConfig || { railwayUrl: "" };
}

export async function setGlobalRailwayConfig(railwayUrl, authToken = null) {
  const cleanUrl = String(railwayUrl || "").trim().replace(/\/+$/, "");
  inMemorySystemConfig = { railwayUrl: cleanUrl, updatedAt: new Date().toISOString() };
  try {
    await fs.mkdir(path.dirname(SYSTEM_CONFIG_FILE), { recursive: true });
    await fs.writeFile(SYSTEM_CONFIG_FILE, JSON.stringify(inMemorySystemConfig, null, 2));
  } catch {}

  await writeFirestoreDocumentRest("system_config", "railway", { url: cleanUrl, updatedAt: new Date().toISOString() }, authToken).catch(() => {});
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "system_config", "railway"), { url: cleanUrl, updatedAt: new Date().toISOString() }, { merge: true });
    } catch {}
  }
  return inMemorySystemConfig;
}

/**
 * Admin: List all registered users with their license and number lock statuses
 */
export async function listAllUsersWithLicenses(authToken = null) {
  await loadLocalStore();
  const userMap = new Map();

  // 1. Fetch from Firestore REST API (reliable server-side)
  try {
    const [restUsers, restLicenses, restLocks] = await Promise.all([
      readFirestoreCollectionRest("users", authToken).catch(() => []),
      readFirestoreCollectionRest("user_licenses", authToken).catch(() => []),
      readFirestoreCollectionRest("user_number_locks", authToken).catch(() => []),
    ]);

    for (const u of restUsers) {
      if (u.id) {
        userMap.set(u.id, {
          uid: u.id,
          email: u.email || "",
          displayName: u.displayName || u.email?.split("@")[0] || "User",
          createdAt: u.createdAt || null,
          lastLoginAt: u.lastLoginAt || null,
          phoneNumber: u.phoneNumber || "",
          isUnlimited: Boolean(u.isUnlimited || u.activeLicense?.isUnlimited),
          activeLicense: u.activeLicense || null,
        });
      }
    }

    for (const lic of restLicenses) {
      if (lic.id) {
        const uid = lic.id;
        const existing = userMap.get(uid) || {
          uid,
          email: lic.email || "",
          displayName: lic.email?.split("@")[0] || "User",
          phoneNumber: "",
        };
        existing.activeLicense = lic;
        if (lic.isUnlimited || lic.durationDays === "Unlimited") {
          existing.isUnlimited = true;
        }
        userMap.set(uid, existing);
      }
    }

    for (const lock of restLocks) {
      if (lock.id && userMap.has(lock.id)) {
        userMap.get(lock.id).phoneNumber = lock.phoneNumber || userMap.get(lock.id).phoneNumber;
      }
    }
  } catch (err) {
    logger.debug("listAllUsersWithLicenses REST query note", err.message);
  }

  // 2. Fetch from Client SDK if available
  const db = getFirebaseServerFirestore();
  if (db) {
    try {
      const { collection, getDocs } = await import("firebase/firestore");
      const [usersSnap, userLicensesSnap, locksSnap] = await Promise.all([
        getDocs(collection(db, "users")).catch(() => ({ forEach: () => {} })),
        getDocs(collection(db, "user_licenses")).catch(() => ({ forEach: () => {} })),
        getDocs(collection(db, "user_number_locks")).catch(() => ({ forEach: () => {} })),
      ]);

      usersSnap.forEach((d) => {
        const u = d.data() || {};
        const existing = userMap.get(d.id) || { uid: d.id };
        userMap.set(d.id, {
          ...existing,
          uid: d.id,
          email: u.email || existing.email || "",
          displayName: u.displayName || existing.displayName || u.email?.split("@")[0] || "User",
          createdAt: u.createdAt || existing.createdAt || null,
          lastLoginAt: u.lastLoginAt || existing.lastLoginAt || null,
          phoneNumber: u.phoneNumber || existing.phoneNumber || "",
          isUnlimited: Boolean(existing.isUnlimited || u.isUnlimited || u.activeLicense?.isUnlimited),
          activeLicense: existing.activeLicense || u.activeLicense || null,
        });
      });

      userLicensesSnap.forEach((d) => {
        const lic = d.data() || {};
        const uid = d.id;
        const existing = userMap.get(uid) || { uid, email: lic.email || "", displayName: lic.email?.split("@")[0] || "User" };
        existing.activeLicense = lic;
        if (lic.isUnlimited === true) {
          existing.isUnlimited = true;
        } else if (lic.isUnlimited === false) {
          existing.isUnlimited = false;
        } else if (lic.durationDays === "Unlimited" || lic.status === "unlimited") {
          existing.isUnlimited = true;
        }
        userMap.set(uid, existing);
      });

      locksSnap.forEach((d) => {
        const lock = d.data() || {};
        const uid = d.id;
        if (userMap.has(uid)) {
          userMap.get(uid).phoneNumber = lock.phoneNumber || userMap.get(uid).phoneNumber;
        }
      });
    } catch (err) {
      logger.debug("listAllUsersWithLicenses Firestore query notice", err.message);
    }
  }

  // 3. Merge in-memory & local JSON records with email deduplication
  if (inMemoryUserLicenses) {
    for (const [key, lic] of Object.entries(inMemoryUserLicenses)) {
      if (!lic) continue;
      const isKeyEmail = key.includes("@");
      const cleanLicEmail = (lic.email || (isKeyEmail ? key : "")).trim().toLowerCase();

      // Find if this user already exists in userMap by UID or by email
      let matchedUid = null;
      if (userMap.has(key)) {
        matchedUid = key;
      } else if (cleanLicEmail) {
        for (const [existingUid, userEntry] of userMap.entries()) {
          if (userEntry.email && userEntry.email.trim().toLowerCase() === cleanLicEmail) {
            matchedUid = existingUid;
            break;
          }
        }
      }

      if (matchedUid) {
        const existingUser = userMap.get(matchedUid);
        if (lic.isUnlimited === true) {
          existingUser.isUnlimited = true;
        } else if (lic.isUnlimited === false) {
          existingUser.isUnlimited = false;
        } else if (lic.durationDays === "Unlimited" && lic.isUnlimited !== false) {
          existingUser.isUnlimited = true;
        }
        if (!existingUser.activeLicense || lic.isUnlimited === true || (existingUser.isUnlimited && lic.durationDays === "Unlimited")) {
          existingUser.activeLicense = lic;
        } else if (lic.isUnlimited === false) {
          existingUser.activeLicense = lic;
        }
        if (!existingUser.email && cleanLicEmail) {
          existingUser.email = cleanLicEmail;
        }
      } else {
        // Only add if not an email alias key
        const userUid = lic.uid || key;
        userMap.set(userUid, {
          uid: userUid,
          email: cleanLicEmail,
          displayName: cleanLicEmail ? cleanLicEmail.split("@")[0] : "User",
          activeLicense: lic,
          isUnlimited: Boolean(lic.isUnlimited === true || (lic.isUnlimited !== false && lic.durationDays === "Unlimited")),
          phoneNumber: "",
        });
      }
    }
  }

  const nowMs = Date.now();
  const results = [];

  for (const [uid, u] of userMap.entries()) {
    const isOwnerAdmin = isAdminEmail(u.email) || isAdminEmail(uid);
    const lic = u.activeLicense || {};
    const isExplicitlyRevoked = u.isUnlimited === false || lic.isUnlimited === false;
    const isUnlimited = isOwnerAdmin || (!isExplicitlyRevoked && Boolean(
      u.isUnlimited ||
      lic.isUnlimited ||
      (lic.durationDays === "Unlimited" && lic.isUnlimited !== false) ||
      (u.durationDays === "Unlimited" && u.isUnlimited !== false) ||
      (lic.status === "unlimited" && lic.isUnlimited !== false) ||
      (u.status === "unlimited" && u.isUnlimited !== false)
    ));

    let status = "none";
    let remainingMs = 0;
    let remainingFormatted = "No license";
    let expiresAt = lic.expiresAt || null;

    let preservedNotice = "";
    if (isUnlimited) {
      status = "unlimited";
      const savedDays = lic.savedNormalDays || (lic.savedRemainingMs ? Math.ceil(lic.savedRemainingMs / 86400000) : null);
      if (savedDays && savedDays > 0) {
        preservedNotice = `Preserved: ${savedDays} normal days left`;
        remainingFormatted = `Unlimited (${savedDays}d normal preserved)`;
      } else {
        remainingFormatted = "Unlimited (Lifetime)";
      }
      remainingMs = 3153600000000;
    } else if (expiresAt) {
      const expMs = new Date(expiresAt).getTime();
      remainingMs = Math.max(0, expMs - nowMs);
      if (remainingMs > 0) {
        status = "active";
        remainingFormatted = formatRemainingTime(remainingMs);
      } else {
        status = "expired";
        remainingFormatted = "Expired";
      }
    }

    results.push({
      uid,
      email: u.email || "—",
      displayName: u.displayName || u.email?.split("@")[0] || "User",
      phoneNumber: u.phoneNumber || "—",
      status,
      isUnlimited,
      isAdmin: isOwnerAdmin,
      durationDays: isUnlimited ? "Unlimited" : (lic.durationDays === "Unlimited" ? 0 : lic.durationDays || 0),
      expiresAt,
      remainingFormatted,
      preservedNotice,
      savedNormalDays: lic.savedNormalDays || null,
      savedNormalExpiresAt: lic.savedNormalExpiresAt || null,
      savedRemainingMs: lic.savedRemainingMs || 0,
      lastLoginAt: u.lastLoginAt || null,
      createdAt: u.createdAt || null,
    });
  }

  return results.sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0));
}

/**
 * Admin: Toggle Unlimited Status for a specific user, preserving normal days
 */
export async function toggleUserUnlimitedStatus(targetUid, setUnlimited, adminEmail = ADMIN_EMAIL, authToken = null) {
  return withAtomicLock(async () => {
    await loadLocalStore();
    const isUnlimited = Boolean(setUnlimited);

    let existing = inMemoryUserLicenses[targetUid] || {};
    // Also check by email if available
    if (!existing.email && inMemoryUserLicenses) {
      for (const [k, v] of Object.entries(inMemoryUserLicenses)) {
        if (v && (v.uid === targetUid || k === targetUid)) {
          existing = { ...v, ...existing };
          break;
        }
      }
    }

    // Fallback: check Firestore if existing has no data
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const snap = await getDoc(doc(db, "user_licenses", targetUid));
        if (snap.exists()) {
          existing = { ...snap.data(), ...existing };
        } else {
          const uSnap = await getDoc(doc(db, "users", targetUid));
          if (uSnap.exists() && uSnap.data().activeLicense) {
            existing = { ...uSnap.data().activeLicense, ...existing };
          }
        }
      } catch {}
    }

    const nowIso = new Date().toISOString();
    let updatedLicense;

    if (isUnlimited) {
      // Preserve standard license days before granting unlimited
      let savedNormalExpiresAt = existing.savedNormalExpiresAt || null;
      let savedNormalDays = existing.savedNormalDays || null;
      let savedRemainingMs = existing.savedRemainingMs || 0;

      if (!existing.isUnlimited && existing.expiresAt && existing.durationDays !== "Unlimited") {
        const expTime = new Date(existing.expiresAt).getTime();
        const diffMs = expTime - Date.now();
        if (diffMs > 0) {
          savedNormalExpiresAt = existing.expiresAt;
          savedNormalDays = existing.durationDays || Math.ceil(diffMs / 86400000);
          savedRemainingMs = diffMs;
        }
      }

      const expiryIso = new Date(Date.now() + 100 * 365 * 86400000).toISOString();
      updatedLicense = {
        ...existing,
        uid: targetUid,
        email: existing.email || "",
        isUnlimited: true,
        status: "active",
        durationDays: "Unlimited",
        expiresAt: expiryIso,
        savedNormalExpiresAt,
        savedNormalDays,
        savedRemainingMs,
        updatedAt: nowIso,
        unlimitedGrantedBy: adminEmail,
      };
    } else {
      // Revert back to preserved normal days if they have not finished!
      let restoredExpiresAt = null;
      let restoredStatus = "none";
      let restoredDurationDays = 0;

      if (existing.savedRemainingMs && existing.savedRemainingMs > 0) {
        restoredExpiresAt = new Date(Date.now() + existing.savedRemainingMs).toISOString();
        restoredStatus = "active";
        restoredDurationDays = Number(existing.savedNormalDays) || Math.ceil(existing.savedRemainingMs / 86400000);
      } else if (existing.savedNormalExpiresAt) {
        const expMs = new Date(existing.savedNormalExpiresAt).getTime();
        if (expMs > Date.now()) {
          restoredExpiresAt = existing.savedNormalExpiresAt;
          restoredStatus = "active";
          restoredDurationDays = Number(existing.savedNormalDays) || Math.ceil((expMs - Date.now()) / 86400000);
        } else {
          restoredExpiresAt = existing.savedNormalExpiresAt;
          restoredStatus = "expired";
          restoredDurationDays = Number(existing.savedNormalDays) || 0;
        }
      } else {
        restoredExpiresAt = nowIso;
        restoredStatus = "expired";
        restoredDurationDays = 0;
      }

      updatedLicense = {
        ...existing,
        uid: targetUid,
        email: existing.email || "",
        isUnlimited: false,
        status: restoredStatus,
        durationDays: restoredDurationDays, // strictly numeric, NEVER "Unlimited"
        expiresAt: restoredExpiresAt,
        savedNormalExpiresAt: null,
        savedNormalDays: null,
        savedRemainingMs: 0,
        updatedAt: nowIso,
        unlimitedRevokedBy: adminEmail,
      };
    }

    inMemoryUserLicenses[targetUid] = updatedLicense;
    if (updatedLicense.email) {
      inMemoryUserLicenses[updatedLicense.email.toLowerCase()] = updatedLicense;
    }
    for (const [k, v] of Object.entries(inMemoryUserLicenses)) {
      if (v && (v.uid === targetUid || (updatedLicense.email && v.email?.toLowerCase() === updatedLicense.email.toLowerCase()))) {
        inMemoryUserLicenses[k] = updatedLicense;
      }
    }

    const emailToSave = updatedLicense.email || existing.email || "";
    const userDocPatch = {
      isUnlimited,
      durationDays: isUnlimited ? "Unlimited" : updatedLicense.durationDays,
      status: updatedLicense.status,
      licenseStatus: isUnlimited ? "lifetime" : updatedLicense.status,
      activeLicense: updatedLicense,
      ...(emailToSave ? { email: emailToSave, displayName: emailToSave.split("@")[0] } : {}),
      updatedAt: nowIso,
    };

    await Promise.all([
      writeFirestoreDocumentRest("user_licenses", targetUid, updatedLicense, authToken),
      writeFirestoreDocumentRest("users", targetUid, userDocPatch, authToken),
    ]);

    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await Promise.all([
          setDoc(doc(db, "user_licenses", targetUid), updatedLicense, { merge: true }),
          setDoc(doc(db, "users", targetUid), userDocPatch, { merge: true }),
        ]);
      } catch (err) {
        logger.debug("Firestore toggleUserUnlimitedStatus notice", err.message);
      }
    }

    await persistLocalStore();
    return { ok: true, uid: targetUid, isUnlimited, updatedLicense };
  });
}

/**
 * Admin: Completely delete / remove a user from the system and all license records
 */
export async function deleteUserFromSystem(targetUid, adminEmail = ADMIN_EMAIL, authToken = null) {
  return withAtomicLock(async () => {
    await loadLocalStore();
    const existing = inMemoryUserLicenses[targetUid] || {};
    const emailToDelete = (existing.email || "").toLowerCase();

    // 1. Delete from in-memory and local store
    delete inMemoryUserLicenses[targetUid];
    if (emailToDelete) {
      delete inMemoryUserLicenses[emailToDelete];
    }
    for (const [k, v] of Object.entries(inMemoryUserLicenses)) {
      if (v && (v.uid === targetUid || (emailToDelete && v.email?.toLowerCase() === emailToDelete))) {
        delete inMemoryUserLicenses[k];
      }
    }

    // 2. Unlink phone number lock if any
    try {
      const { unlinkNumberFromUser } = await import("./number-lock.js");
      await unlinkNumberFromUser(targetUid, adminEmail, authToken);
    } catch {}

    // 3. Delete from Firestore
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, deleteDoc } = await import("firebase/firestore");
        await Promise.all([
          deleteDoc(doc(db, "user_licenses", targetUid)).catch(() => {}),
          deleteDoc(doc(db, "users", targetUid)).catch(() => {}),
          deleteDoc(doc(db, "whatsapp_sessions", targetUid)).catch(() => {}),
        ]);
      } catch (err) {
        logger.debug("Firestore deleteUserFromSystem notice", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`User ${targetUid} (${emailToDelete || "no email"}) removed from system by admin ${adminEmail}`);
    return { ok: true, uid: targetUid, deleted: true };
  });
}

/**
 * Admin: Add a user directly to Unlimited by Email (manually)
 */
export async function addUnlimitedUserByEmail(emailInput, adminEmail = ADMIN_EMAIL, authToken = null) {
  const cleanEmail = String(emailInput || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("A valid email address is required.");
  }

  // Find user by email in local store or Firestore
  let targetUid = null;
  await loadLocalStore();

  for (const [uid, lic] of Object.entries(inMemoryUserLicenses)) {
    if (lic.email && lic.email.toLowerCase() === cleanEmail) {
      targetUid = uid;
      break;
    }
  }

  if (!targetUid) {
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { collection, query, where, getDocs } = await import("firebase/firestore");
        const q = query(collection(db, "users"), where("email", "==", cleanEmail));
        const snap = await getDocs(q);
        if (!snap.empty) {
          targetUid = snap.docs[0].id;
        }
      } catch {}
    }
  }

  // If user has not signed in yet, use email slug as temporary UID
  if (!targetUid) {
    targetUid = `user_${cleanEmail.replace(/[^a-zA-Z0-9]/g, "_")}`;
    // Seed initial user record
    inMemoryUserLicenses[targetUid] = {
      uid: targetUid,
      email: cleanEmail,
      createdAt: new Date().toISOString(),
    };
  } else if (!inMemoryUserLicenses[targetUid]) {
    inMemoryUserLicenses[targetUid] = {
      uid: targetUid,
      email: cleanEmail,
      createdAt: new Date().toISOString(),
    };
  } else {
    inMemoryUserLicenses[targetUid].email = cleanEmail;
  }

  const result = await toggleUserUnlimitedStatus(targetUid, true, adminEmail, authToken);
  return { ...result, email: cleanEmail };
}

/**
 * Admin: Grant custom days directly to any user
 */
export async function grantUserCustomDays(targetUid, days, userEmail = "", authToken = null) {
  const numDays = Math.max(1, parseInt(days, 10) || 1);
  return applyRewardLicenseExtension(targetUid, numDays, `ADMIN-GRANT-${numDays}D`, userEmail, authToken);
}

/**
 * Admin: Delete single license key from database
 */
export async function deleteLicenseKey(code, authToken = null) {
  const cleanCode = String(code || "").trim().toUpperCase();
  return withAtomicLock(async () => {
    await loadLocalStore();
    if (inMemoryLicenses[cleanCode]) {
      delete inMemoryLicenses[cleanCode];
    }

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, deleteDoc } = await import("firebase/firestore");
        await deleteDoc(doc(db, "licenses", cleanCode));
      } catch (err) {
        logger.debug("Firestore deleteLicenseKey notice", err.message);
      }
    }

    await persistLocalStore();
    return { ok: true, code: cleanCode };
  });
}

/**
 * Admin: Recycling bin - Purge expired or unused keys to clear cache / bugs
 */
export async function purgeExpiredOrUnusedKeys(filterType = "all", authToken = null) {
  return withAtomicLock(async () => {
    await loadLocalStore();
    const deletedCodes = [];
    const nowMs = Date.now();

    for (const [code, lic] of Object.entries(inMemoryLicenses || {})) {
      let shouldDelete = false;
      const isUsed = lic.status === "used" || Boolean(lic.redeemedAt);
      const isExpired = lic.expiresAt && new Date(lic.expiresAt).getTime() < nowMs;

      if (filterType === "unused" && !isUsed) {
        shouldDelete = true;
      } else if (filterType === "expired" && (isExpired || (isUsed && lic.expiresAt && new Date(lic.expiresAt).getTime() < nowMs))) {
        shouldDelete = true;
      } else if (filterType === "all") {
        if (!isUsed || isExpired) shouldDelete = true;
      }

      if (shouldDelete) {
        delete inMemoryLicenses[code];
        deletedCodes.push(code);
      }
    }

    const db = getFirebaseServerFirestore();
    if (db && deletedCodes.length > 0) {
      try {
        const { doc, deleteDoc } = await import("firebase/firestore");
        for (const code of deletedCodes) {
          await deleteDoc(doc(db, "licenses", code)).catch(() => {});
        }
      } catch (err) {
        logger.debug("Firestore purgeExpiredOrUnusedKeys notice", err.message);
      }
    }

    await persistLocalStore();
    return { ok: true, count: deletedCodes.length, deletedCodes };
  });
}


