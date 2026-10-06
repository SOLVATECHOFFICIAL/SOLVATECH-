import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { isSupabaseConfigured, supabaseUpsert, supabaseGetById, supabaseGetAll, supabaseDelete } from "./supabase.js";
import { firestoreUpsert, firestoreGetById, firestoreDelete } from "./firestore-sync.js";

const LOCKS_FILE = path.join(DATA_DIR, "data", "solvatech-number-locks.json");

// In-memory cache & queue
let inMemoryLocks = null;
let lockQueue = Promise.resolve();

function withAtomicLock(fn) {
  const next = lockQueue.then(() => fn()).catch((err) => {
    logger.error("Number lock operation error", err.stack || err.message);
    throw err;
  });
  lockQueue = next.then(() => {}).catch(() => {});
  return next;
}

export function cleanPhone(num) {
  if (!num) return "";
  return String(num).replace(/\D/g, "");
}

async function loadLocalStore() {
  if (!inMemoryLocks) {
    try {
      if (fsSync.existsSync(LOCKS_FILE)) {
        const raw = await fs.readFile(LOCKS_FILE, "utf8");
        inMemoryLocks = JSON.parse(raw);
      } else {
        inMemoryLocks = { locks: {}, userLocks: {} };
      }
    } catch {
      inMemoryLocks = { locks: {}, userLocks: {} };
    }
  }
  if (!inMemoryLocks.locks) inMemoryLocks.locks = {};
  if (!inMemoryLocks.userLocks) inMemoryLocks.userLocks = {};
}

async function persistLocalStore() {
  try {
    await fs.mkdir(path.dirname(LOCKS_FILE), { recursive: true });
    await fs.writeFile(LOCKS_FILE, JSON.stringify(inMemoryLocks, null, 2));
  } catch (err) {
    logger.error("Failed to persist number locks store", err.message);
  }
}

const ADMIN_EMAILS = [
  (process.env.ADMIN_EMAIL || "awoyinfasolomon1@gmail.com").trim().toLowerCase(),
];

function isAdminEmail(email) {
  if (!email || typeof email !== "string") return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * Checks if a phone number can be paired by a given Firebase UID
 */
export async function checkNumberLock(rawPhone, uid, userEmail = "") {
  if (!uid) return { allowed: true };
  const phone = cleanPhone(rawPhone);

  // Platform admins are never locked out of any number
  if (isAdminEmail(userEmail)) {
    return { allowed: true, lockedNumber: phone };
  }

  return withAtomicLock(async () => {
    await loadLocalStore();

    // 1. Sync from Firebase Firestore (Primary Source of Truth)
    try {
      if (phone) {
        const fsLock = await firestoreGetById("number_locks", phone);
        if (fsLock && fsLock.phoneNumber) {
          inMemoryLocks.locks[phone] = {
            phoneNumber: fsLock.phoneNumber,
            uid: fsLock.uid,
            userEmail: fsLock.userEmail,
            lockedAt: fsLock.lockedAt,
          };
          if (fsLock.uid) inMemoryLocks.userLocks[fsLock.uid] = phone;
        }
      }
    } catch (fsErr) {
      logger.debug("Firebase checkNumberLock notice:", fsErr.message);
    }

    // 2. Sync with Supabase if configured
    if (isSupabaseConfigured()) {
      try {
        if (phone) {
          const lockRow = await supabaseGetById("number_locks", phone, "phone_number");
          if (lockRow) {
            inMemoryLocks.locks[phone] = {
              phoneNumber: lockRow.phone_number,
              uid: lockRow.uid,
              userEmail: lockRow.user_email,
              lockedAt: lockRow.locked_at,
            };
            if (lockRow.uid) inMemoryLocks.userLocks[lockRow.uid] = phone;
          }
        }
      } catch (err) {
        logger.debug("Supabase checkNumberLock notice:", err.message);
      }
    }

    if (phone) {
      const existingLock = inMemoryLocks.locks[phone];
      if (existingLock) {
        const isSameAccount = existingLock.uid === uid ||
          (userEmail && existingLock.userEmail && existingLock.userEmail.toLowerCase() === userEmail.toLowerCase()) ||
          isAdminEmail(userEmail) ||
          isAdminEmail(existingLock.userEmail);

        if (isSameAccount) {
          return { allowed: true, alreadyLockedToUser: true, lockedNumber: phone };
        }

        return {
          allowed: false,
          reason: "NUMBER_LOCKED_TO_ANOTHER_ACCOUNT",
          message: `The WhatsApp number (+${phone}) is permanently locked to another SOLVATECH account.`,
          lockedUid: existingLock.uid,
        };
      }
    }

    // Check if user's UID is already locked to a DIFFERENT number
    const existingUserLock = inMemoryLocks.userLocks[uid];

    if (existingUserLock && phone && cleanPhone(existingUserLock) !== phone) {
      if (isAdminEmail(userEmail)) {
        return { allowed: true, lockedNumber: phone };
      }
      return {
        allowed: false,
        reason: "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER",
        message: `Your account is permanently locked to WhatsApp number (+${existingUserLock}). You cannot pair a different phone number.`,
        lockedNumber: existingUserLock,
      };
    }

    return { allowed: true, alreadyLockedToUser: Boolean(existingUserLock), lockedNumber: existingUserLock || null };
  });
}

/**
 * Permanently locks a WhatsApp phone number to a Firebase UID
 */
export async function lockNumberToUser(rawPhone, uid, userEmail = "") {
  if (!rawPhone || !uid) return null;
  const phone = cleanPhone(rawPhone);
  if (!phone) return null;

  return withAtomicLock(async () => {
    await loadLocalStore();

    const existingLock = inMemoryLocks.locks[phone];
    if (existingLock && existingLock.uid === uid) {
      return existingLock; // Already locked to this user
    }

    const lockData = {
      phoneNumber: phone,
      uid,
      userEmail,
      lockedAt: new Date().toISOString(),
    };

    inMemoryLocks.locks[phone] = lockData;
    inMemoryLocks.userLocks[uid] = phone;

    // 1. Save straight to Firebase Firestore (Primary Source of Truth)
    try {
      await firestoreUpsert("number_locks", phone, lockData);
      await firestoreUpsert("user_number_locks", uid, {
        userId: uid,
        uid,
        phoneNumber: phone,
        userEmail,
        lockedAt: lockData.lockedAt,
      });
      logger.debug(`[Direct Firebase] Synced number lock straight to Firestore for +${phone}`);
    } catch (fbErr) {
      logger.debug("Firebase number lock write notice:", fbErr.message);
    }

    // 2. Also sync to Supabase if configured
    if (isSupabaseConfigured()) {
      try {
        await supabaseUpsert("number_locks", {
          phone_number: phone,
          uid,
          user_email: userEmail,
          locked_at: lockData.lockedAt,
        }, "phone_number");
      } catch (err) {
        logger.warn("Could not sync number lock to Supabase:", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`Permanently locked WhatsApp number +${phone} to user ${uid} (${userEmail})`);
    return lockData;
  });
}

/**
 * Gets locked number for a Firebase UID if any
 */
export async function getLockedNumberForUid(uid) {
  if (!uid) return null;
  await loadLocalStore();

  if (!inMemoryLocks.userLocks[uid]) {
    try {
      const fsUserLock = await firestoreGetById("user_number_locks", uid);
      if (fsUserLock && fsUserLock.phoneNumber) {
        inMemoryLocks.userLocks[uid] = fsUserLock.phoneNumber;
        return fsUserLock.phoneNumber;
      }
    } catch {}
  }

  if (isSupabaseConfigured() && !inMemoryLocks.userLocks[uid]) {
    try {
      const { getSupabaseClient } = await import("./supabase.js");
      const client = getSupabaseClient();
      if (client) {
        const { data } = await client.from("number_locks").select("phone_number").eq("uid", uid).maybeSingle();
        if (data && data.phone_number) {
          inMemoryLocks.userLocks[uid] = data.phone_number;
          return data.phone_number;
        }
      }
    } catch (err) {
      logger.debug("Supabase getLockedNumberForUid notice:", err.message);
    }
  }
  return inMemoryLocks.userLocks[uid] || null;
}

/**
 * Unlinks a locked number from a user's account, freeing both the account and the number.
 */
export async function unlinkNumberFromUser(uid, optionalPhone = "") {
  if (!uid) return { ok: false, error: "Missing user ID" };
  return withAtomicLock(async () => {
    await loadLocalStore();
    const phone = cleanPhone(optionalPhone || inMemoryLocks.userLocks[uid]);

    if (phone && inMemoryLocks.locks[phone]) {
      delete inMemoryLocks.locks[phone];
    }
    delete inMemoryLocks.userLocks[uid];

    // Delete straight from Firebase Firestore
    try {
      if (phone) await firestoreDelete("number_locks", phone);
      await firestoreDelete("user_number_locks", uid);
    } catch (fbErr) {
      logger.debug("Firebase number lock delete notice:", fbErr.message);
    }

    if (isSupabaseConfigured()) {
      try {
        if (phone) {
          await supabaseDelete("number_locks", "phone_number", phone);
        }
        await supabaseDelete("number_locks", "uid", uid);
      } catch (err) {
        logger.debug("Supabase unlink notice:", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`Unlinked phone number ${phone || "all"} from user ${uid}`);
    return { ok: true, unlinkedPhone: phone };
  });
}

/**
 * Unlinks any phone number directly (useful when resetting or releasing locked number)
 */
export async function unlinkPhoneNumber(rawPhone) {
  const phone = cleanPhone(rawPhone);
  if (!phone) return { ok: false, error: "Missing phone number" };

  return withAtomicLock(async () => {
    await loadLocalStore();
    const existing = inMemoryLocks.locks[phone];
    const uid = existing?.uid;

    delete inMemoryLocks.locks[phone];
    if (uid && inMemoryLocks.userLocks[uid] === phone) {
      delete inMemoryLocks.userLocks[uid];
    }

    // Delete straight from Firebase Firestore
    try {
      if (phone) await firestoreDelete("number_locks", phone);
      if (uid) await firestoreDelete("user_number_locks", uid);
    } catch (fbErr) {
      logger.debug("Firebase unlinkPhoneNumber notice:", fbErr.message);
    }

    if (isSupabaseConfigured()) {
      try {
        await supabaseDelete("number_locks", "phone_number", phone);
        if (uid) {
          await supabaseDelete("number_locks", "uid", uid);
        }
      } catch (err) {
        logger.debug("Supabase unlinkPhoneNumber notice:", err.message);
      }
    }

    await persistLocalStore();
    logger.info(`Directly released number lock for +${phone}`);
    return { ok: true, phone, releasedUid: uid };
  });
}

/**
 * Read-only helper: Returns all number locks for admin visibility
 */
export async function getAllNumberLocks() {
  await loadLocalStore();
  if (isSupabaseConfigured()) {
    try {
      const rows = await supabaseGetAll("number_locks");
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && row.phone_number) {
            inMemoryLocks.locks[row.phone_number] = {
              phoneNumber: row.phone_number,
              uid: row.uid,
              userEmail: row.user_email,
              lockedAt: row.locked_at,
            };
            if (row.uid) inMemoryLocks.userLocks[row.uid] = row.phone_number;
          }
        }
      }
    } catch (err) {
      logger.debug("Supabase getAllNumberLocks notice:", err.message);
    }
  }
  return inMemoryLocks.locks || {};
}

