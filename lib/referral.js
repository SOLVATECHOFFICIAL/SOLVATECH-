import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFirebaseServerFirestore, writeFirestoreDocumentRest } from "./auth.js";
import { applyRewardLicenseExtension } from "./license.js";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const LOCAL_STORE_FILE = path.join(DATA_DIR, "referrals-store.json");

/**
 * Official system price schedule for SOLVATECH BOT licenses.
 * Values are determined server-side from duration to prevent manipulation.
 */
export const OFFICIAL_LICENSE_PRICES = {
  1: 200,     // 1 day = ₦200
  3: 500,     // 3 days = ₦500
  7: 1000,    // 7 days = ₦1,000
  14: 2000,   // 14 days = ₦2,000
  30: 4000,   // 30 days = ₦4,000
  60: 8000,   // 2 months = ₦8,000
  90: 12000,  // 3 months = ₦12,000
  180: 24000, // 6 months = ₦24,000
  365: 48000, // 12 months = ₦48,000
};

/**
 * Maps license duration in days to the official qualifying purchase price in NGN.
 */
export function getOfficialLicensePrice(durationDays) {
  const days = parseInt(durationDays, 10);
  if (isNaN(days) || days <= 0) return 0;
  if (OFFICIAL_LICENSE_PRICES[days]) {
    return OFFICIAL_LICENSE_PRICES[days];
  }

  // Tolerant mappings for standard calendar month durations
  if (days >= 28 && days <= 31) return 4000;
  if (days >= 58 && days <= 62) return 8000;
  if (days >= 88 && days <= 93) return 12000;
  if (days >= 175 && days <= 186) return 24000;
  if (days >= 360 && days <= 366) return 48000;

  // Linear pro-rate for custom day presets (base rate: ₦4,000 / 30 days)
  return Math.round(days * (4000 / 30));
}

/**
 * Generates an unguessable 7-character uppercase alphanumeric referral code (e.g. GER373G).
 * Excludes easily ambiguous characters (0, O, 1, I).
 */
export function generateReferralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(7);
  let code = "";
  for (let i = 0; i < 7; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

/**
 * Formats a referral link using the standard query parameter format:
 * https://solvatech.name.ng/?ref=REFERRAL_CODE
 * Example: https://solvatech.name.ng/?ref=T6JTKUY
 */
export function formatReferralLink(code) {
  if (!code) return "https://solvatech.name.ng/";
  const clean = String(code).trim().toUpperCase().replace(/^REF-/, "");
  return `https://solvatech.name.ng/?ref=${clean}`;
}

// In-memory fallback and concurrency lock
let referralOperationQueue = Promise.resolve();
function withReferralLock(fn) {
  const op = referralOperationQueue.then(fn, fn);
  referralOperationQueue = op.catch(() => {});
  return op;
}

let inMemoryReferralData = {
  users: {},
  purchases: {},
  rewards: {},
  claims: {},
};

let storeLoaded = false;
async function loadReferralStore() {
  if (storeLoaded) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(LOCAL_STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      inMemoryReferralData = {
        users: parsed.users || {},
        purchases: parsed.purchases || {},
        rewards: parsed.rewards || {},
        claims: parsed.claims || {},
      };
    }
  } catch (_e) {
    // Fresh store
  } finally {
    storeLoaded = true;
  }
}

async function persistReferralStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(LOCAL_STORE_FILE, JSON.stringify(inMemoryReferralData, null, 2), "utf-8");
  } catch (err) {
    logger.debug("Local referral store persist notice", err.message);
  }
}

/**
 * Ensures a user account in Firestore has a permanent referral code and link,
 * and attributes an unalterable referrer if candidateReferrerCode is provided.
 *
 * Rules:
 * - Each user gets a unique, permanent referralCode (and referralLink: https://solvatech.name.ng/CODE).
 * - Attribution is PERMANENT. Once referredBy is set, it can never be replaced.
 * - Self-referral is strictly forbidden.
 */
export async function ensureUserReferralData(uid, email = "", candidateReferrerCode = "", authToken = null) {
  if (!uid) return null;

  return withReferralLock(async () => {
    await loadReferralStore();

    let localUser = inMemoryReferralData.users[uid] || {};
    let firestoreData = {};

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) {
          firestoreData = snap.data() || {};
        }
      } catch (err) {
        logger.debug("Firestore get user notice in ensureUserReferralData", err.message);
      }
    }

    const merged = { ...localUser, ...firestoreData };
    let referralCode = merged.referralCode;
    let referredBy = merged.referredBy || null;
    let referredByCode = merged.referredByCode || null;
    let referredAt = merged.referredAt || null;

    let needsUpdate = false;
    const updates = {};

    // 1. Assign permanent unique referral code if missing or format outdated
    if (!referralCode) {
      referralCode = generateReferralCode();
      updates.referralCode = referralCode;
      updates.referralLink = formatReferralLink(referralCode);
      needsUpdate = true;
    } else if (!merged.referralLink || !merged.referralLink.includes("?ref=")) {
      updates.referralLink = formatReferralLink(referralCode);
      needsUpdate = true;
    }

    // 2. Permanent attribution: Only set if user has NO existing referrer
    if (!referredBy && candidateReferrerCode && typeof candidateReferrerCode === "string") {
      const cleanCandidate = candidateReferrerCode.trim().toUpperCase().replace(/^REF-/, "");
      if (cleanCandidate && cleanCandidate !== referralCode && cleanCandidate !== referralCode.replace(/^REF-/, "")) {
        let foundReferrerUid = null;

        // Check local store first
        for (const [rUid, rData] of Object.entries(inMemoryReferralData.users)) {
          const rCode = (rData.referralCode || "").toUpperCase().replace(/^REF-/, "");
          if (rCode === cleanCandidate && rUid !== uid) {
            foundReferrerUid = rUid;
            break;
          }
        }

        // Check Firestore users collection if not found in local store
        if (!foundReferrerUid && db) {
          try {
            const { collection, getDocs } = await import("firebase/firestore");
            const snap = await getDocs(collection(db, "users"));
            snap.forEach((docSnap) => {
              if (docSnap.id === uid) return; // Prevent self-referral
              const d = docSnap.data() || {};
              const dCode = (d.referralCode || "").toUpperCase().replace(/^REF-/, "");
              if (dCode === cleanCandidate) {
                foundReferrerUid = docSnap.id;
              }
            });
          } catch (err) {
            logger.debug("Firestore lookup for referrer notice", err.message);
          }
        }

        if (foundReferrerUid && foundReferrerUid !== uid) {
          referredBy = foundReferrerUid;
          referredByCode = cleanCandidate;
          referredAt = new Date().toISOString();

          updates.referredBy = referredBy;
          updates.referredByUid = referredBy;
          updates.referredByCode = referredByCode;
          updates.referredAt = referredAt;
          needsUpdate = true;
          logger.info(`User ${uid} permanently attributed to referrer ${foundReferrerUid} (${cleanCandidate})`);
        } else if (cleanCandidate) {
          // Preserve candidate code permanently even if referrer doc is being indexed or resolved asynchronously
          referredByCode = cleanCandidate;
          referredAt = new Date().toISOString();
          updates.referredByCode = cleanCandidate;
          updates.referredAt = referredAt;
          needsUpdate = true;
          logger.info(`User ${uid} preserved referredByCode ${cleanCandidate}`);
        }
      }
    }

    const finalRecord = {
      uid,
      email: email || merged.email || "",
      referralCode: updates.referralCode || referralCode,
      referralLink: formatReferralLink(updates.referralCode || referralCode),
      referredBy,
      referredByUid: referredBy,
      referredByCode,
      referredAt,
      qualifyingSalesNgn: Number(merged.qualifyingSalesNgn || 0),
      earnedDaysTotal: Number(merged.earnedDaysTotal || 0),
      claimedDaysTotal: Number(merged.claimedDaysTotal || 0),
      updatedAt: new Date().toISOString(),
    };

    inMemoryReferralData.users[uid] = finalRecord;

    if (needsUpdate) {
      // Sync to Firestore REST API atomically
      await writeFirestoreDocumentRest("users", uid, updates, authToken);

      // Sync to Firestore Client SDK
      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          await setDoc(doc(db, "users", uid), updates, { merge: true });
        } catch (err) {
          logger.debug("Firestore SDK sync user referral data notice", err.message);
        }
      }

      await persistReferralStore();
    }

    return finalRecord;
  });
}

/**
 * Records a qualifying paid license purchase for referral credit.
 *
 * Requirements:
 * - Server determines qualifying amount from duration (1d=₦200, 3d=₦500, 7d=₦1,000, etc.).
 * - Free/reward licenses contribute ₦0.
 * - Deduplicates by purchase ID to prevent double counting.
 * - Adds qualifying sales to permanent referrer.
 * - Automatically generates 3 Free Days reward for every complete ₦1,000 reached.
 * - Preserves leftover progress toward next ₦1,000.
 */
export async function recordPurchaseForReferral(
  buyerUid,
  durationDays,
  licenseCode,
  isRewardOrFree = false,
  buyerEmail = "",
  authToken = null
) {
  if (!buyerUid || !licenseCode) return { processed: false, reason: "Missing buyerUid or licenseCode" };

  const cleanLicenseCode = String(licenseCode).trim().toUpperCase();
  const purchaseId = `PURCH-${cleanLicenseCode.replace(/[^A-Z0-9]/g, "")}`;

  return withReferralLock(async () => {
    await loadReferralStore();

    // 1. Prevent double counting: Check if purchase was already recorded
    if (inMemoryReferralData.purchases[purchaseId]) {
      logger.info(`Referral purchase ${purchaseId} already recorded locally. Skipping to prevent double counting.`);
      return { alreadyCounted: true, purchaseId };
    }

    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const pSnap = await getDoc(doc(db, "referral_purchases", purchaseId));
        if (pSnap.exists()) {
          inMemoryReferralData.purchases[purchaseId] = pSnap.data();
          logger.info(`Referral purchase ${purchaseId} already recorded in Firestore. Skipping.`);
          return { alreadyCounted: true, purchaseId };
        }
      } catch (err) {
        logger.debug("Firestore purchase check notice", err.message);
      }
    }

    // 2. Determine qualifying price: Free/reward licenses contribute ₦0
    const amountNgn = isRewardOrFree ? 0 : getOfficialLicensePrice(durationDays);

    // 3. Look up buyer's permanent referrer
    let buyerData = inMemoryReferralData.users[buyerUid] || {};
    if (!buyerData.referredBy && db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const bSnap = await getDoc(doc(db, "users", buyerUid));
        if (bSnap.exists()) {
          buyerData = bSnap.data() || {};
          inMemoryReferralData.users[buyerUid] = buyerData;
        }
      } catch (err) {
        logger.debug("Firestore buyer lookup notice", err.message);
      }
    }

    let referrerUid = buyerData.referredBy || null;
    if (!referrerUid && buyerData.referredByCode) {
      const cleanRef = String(buyerData.referredByCode).trim().toUpperCase().replace(/^REF-/, "");
      for (const [rUid, rData] of Object.entries(inMemoryReferralData.users)) {
        const rCode = (rData.referralCode || "").toUpperCase().replace(/^REF-/, "");
        if (rCode === cleanRef && rUid !== buyerUid) {
          referrerUid = rUid;
          buyerData.referredBy = rUid;
          if (inMemoryReferralData.users[buyerUid]) {
            inMemoryReferralData.users[buyerUid].referredBy = rUid;
          }
          break;
        }
      }
      if (!referrerUid && db) {
        try {
          const { collection, getDocs } = await import("firebase/firestore");
          const snap = await getDocs(collection(db, "users"));
          snap.forEach((docSnap) => {
            if (docSnap.id === buyerUid) return;
            const d = docSnap.data() || {};
            const dCode = (d.referralCode || "").toUpperCase().replace(/^REF-/, "");
            if (dCode === cleanRef) {
              referrerUid = docSnap.id;
              buyerData.referredBy = docSnap.id;
            }
          });
        } catch (err) {
          logger.debug("Firestore buyer referrer resolution notice", err.message);
        }
      }
    }
    const isQualifying = Boolean(referrerUid && amountNgn > 0 && !isRewardOrFree);

    const purchaseRecord = {
      purchaseId,
      buyerUid,
      buyerEmail: buyerEmail || buyerData.email || "",
      referrerUid,
      licenseCode: cleanLicenseCode,
      durationDays: Number(durationDays) || 0,
      amountNgn,
      isQualifying,
      createdAt: new Date().toISOString(),
      processed: true,
    };

    inMemoryReferralData.purchases[purchaseId] = purchaseRecord;

    // Write purchase record to Firestore
    await writeFirestoreDocumentRest("referral_purchases", purchaseId, purchaseRecord, authToken);
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "referral_purchases", purchaseId), purchaseRecord);
      } catch (err) {
        logger.debug("Firestore SDK purchase write notice", err.message);
      }
    }

    // 4. If qualifying, atomically update referrer's qualifying sales & generate rewards
    if (isQualifying && referrerUid) {
      let referrerData = inMemoryReferralData.users[referrerUid] || {};
      if (db) {
        try {
          const { doc, getDoc } = await import("firebase/firestore");
          const rSnap = await getDoc(doc(db, "users", referrerUid));
          if (rSnap.exists()) {
            referrerData = { ...referrerData, ...rSnap.data() };
          }
        } catch (err) {
          logger.debug("Firestore referrer lookup notice", err.message);
        }
      }

      const prevSales = Number(referrerData.qualifyingSalesNgn || 0);
      const newSales = prevSales + amountNgn;

      const prevRewardCount = Math.floor(prevSales / 1000);
      const newRewardCount = Math.floor(newSales / 1000);
      const newlyEarnedRewards = Math.max(0, newRewardCount - prevRewardCount);

      const updatedReferrer = {
        ...referrerData,
        qualifyingSalesNgn: newSales,
        earnedDaysTotal: newRewardCount * 3,
        updatedAt: new Date().toISOString(),
      };

      inMemoryReferralData.users[referrerUid] = updatedReferrer;

      // Persist updated referrer stats to Firestore
      await writeFirestoreDocumentRest("users", referrerUid, {
        qualifyingSalesNgn: newSales,
        earnedDaysTotal: newRewardCount * 3,
        updatedAt: updatedReferrer.updatedAt,
      }, authToken);

      if (db) {
        try {
          const { doc, setDoc } = await import("firebase/firestore");
          await setDoc(
            doc(db, "users", referrerUid),
            {
              qualifyingSalesNgn: newSales,
              earnedDaysTotal: newRewardCount * 3,
              updatedAt: updatedReferrer.updatedAt,
            },
            { merge: true }
          );
        } catch (err) {
          logger.debug("Firestore SDK referrer update notice", err.message);
        }
      }

      // 5. Generate discrete reward records for each ₦1,000 threshold reached
      if (newlyEarnedRewards > 0) {
        for (let r = prevRewardCount + 1; r <= newRewardCount; r++) {
          const threshold = r * 1000;
          const rewardId = `REW-${referrerUid}-${threshold}`;
          const rewardRecord = {
            rewardId,
            referrerUid,
            thresholdNgn: threshold,
            freeDays: 3,
            createdAt: new Date().toISOString(),
            status: "earned",
            claimedAt: null,
            claimId: null,
          };

          inMemoryReferralData.rewards[rewardId] = rewardRecord;

          await writeFirestoreDocumentRest("referral_rewards", rewardId, rewardRecord, authToken);
          if (db) {
            try {
              const { doc, setDoc } = await import("firebase/firestore");
              await setDoc(doc(db, "referral_rewards", rewardId), rewardRecord);
            } catch (err) {
              logger.debug("Firestore SDK reward write notice", err.message);
            }
          }
        }
        logger.info(`Referrer ${referrerUid} earned ${newlyEarnedRewards * 3} free days from ₦${newSales} total sales!`);
      }
    }

    await persistReferralStore();

    return {
      success: true,
      purchaseId,
      amountNgn,
      isQualifying,
      referrerUid,
    };
  });
}

/**
 * Claims available referral reward free days (in 3-day increments).
 *
 * Guarantees:
 * - Atomic execution.
 * - Deducts from available entitlement.
 * - Extends user's active license duration cleanly (or starts from now if no active license).
 * - Never creates recursive referral sales (₦0, marked isReward: true).
 * - Permanent claim record stored in Firebase.
 */
export async function claimReferralReward(uid, userEmail = "", authToken = null) {
  if (!uid) throw new Error("Authenticated user UID is required.");

  return withReferralLock(async () => {
    await loadReferralStore();

    let userData = inMemoryReferralData.users[uid] || {};
    const db = getFirebaseServerFirestore();
    if (db) {
      try {
        const { doc, getDoc } = await import("firebase/firestore");
        const uSnap = await getDoc(doc(db, "users", uid));
        if (uSnap.exists()) {
          userData = { ...userData, ...uSnap.data() };
          inMemoryReferralData.users[uid] = userData;
        }
      } catch (err) {
        logger.debug("Firestore user fetch notice in claimReferralReward", err.message);
      }
    }

    const qualifyingSales = Number(userData.qualifyingSalesNgn || 0);
    const earnedDaysTotal = Math.floor(qualifyingSales / 1000) * 3;
    const claimedDaysTotal = Number(userData.claimedDaysTotal || 0);
    const availableDays = Math.max(0, earnedDaysTotal - claimedDaysTotal);

    if (availableDays < 3) {
      const err = new Error("No referral reward available to claim. You need at least 3 earned free days.");
      err.code = "NO_REWARD_AVAILABLE";
      throw err;
    }

    const daysAwarded = 3;
    const newClaimedTotal = claimedDaysTotal + daysAwarded;
    const claimId = `CLAIM-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

    // Apply license extension using existing license system (preserves active expiry)
    const extensionResult = await applyRewardLicenseExtension(
      uid,
      daysAwarded,
      claimId,
      userEmail || userData.email || "",
      authToken
    );

    // Update user's claimed days total in store and Firestore
    userData.claimedDaysTotal = newClaimedTotal;
    userData.updatedAt = new Date().toISOString();
    inMemoryReferralData.users[uid] = userData;

    await writeFirestoreDocumentRest("users", uid, {
      claimedDaysTotal: newClaimedTotal,
      updatedAt: userData.updatedAt,
    }, authToken);

    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "users", uid), {
          claimedDaysTotal: newClaimedTotal,
          updatedAt: userData.updatedAt,
        }, { merge: true });
      } catch (err) {
        logger.debug("Firestore SDK user claimedDaysTotal update notice", err.message);
      }
    }

    // Record persistent claim document in referral_claims
    const claimRecord = {
      claimId,
      userUid: uid,
      userEmail: userEmail || userData.email || "",
      daysAwarded,
      claimedAt: new Date().toISOString(),
      previousExpiresAt: extensionResult.previousExpiresAt,
      newExpiresAt: extensionResult.newExpiresAt,
      status: "completed",
    };

    inMemoryReferralData.claims[claimId] = claimRecord;

    await writeFirestoreDocumentRest("referral_claims", claimId, claimRecord, authToken);
    if (db) {
      try {
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "referral_claims", claimId), claimRecord);
      } catch (err) {
        logger.debug("Firestore SDK claim record write notice", err.message);
      }
    }

    // Mark the earliest unclaimed reward record as claimed
    for (const [rId, reward] of Object.entries(inMemoryReferralData.rewards)) {
      if (reward.referrerUid === uid && reward.status === "earned") {
        reward.status = "claimed";
        reward.claimedAt = new Date().toISOString();
        reward.claimId = claimId;

        await writeFirestoreDocumentRest("referral_rewards", rId, reward, authToken);
        if (db) {
          try {
            const { doc, setDoc } = await import("firebase/firestore");
            await setDoc(doc(db, "referral_rewards", rId), reward, { merge: true });
          } catch (err) {
            logger.debug("Firestore SDK reward claim update notice", err.message);
          }
        }
        break;
      }
    }

    await persistReferralStore();

    logger.info(`User ${uid} successfully claimed 3 free days reward (Claim ID: ${claimId}).`);

    return {
      success: true,
      claimId,
      daysAwarded,
      newExpiresAt: extensionResult.newExpiresAt,
      availableDaysRemaining: availableDays - daysAwarded,
      claimedDaysTotal: newClaimedTotal,
      message: "Successfully claimed 3 Free Days! Your bot license has been extended.",
    };
  });
}

/**
 * Retrieves referral metrics, progress, and activity history for a user.
 */
export async function getReferralStats(uid) {
  if (!uid) return null;

  await loadReferralStore();

  let userData = inMemoryReferralData.users[uid] || {};
  const db = getFirebaseServerFirestore();

  if (db) {
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const uSnap = await getDoc(doc(db, "users", uid));
      if (uSnap.exists()) {
        userData = { ...userData, ...uSnap.data() };
        inMemoryReferralData.users[uid] = userData;
      }
    } catch (err) {
      logger.debug("Firestore user fetch notice in getReferralStats", err.message);
    }
  }

  const referralCode = userData.referralCode || generateReferralCode();
  const referralLink = formatReferralLink(referralCode);
  const qualifyingSalesNgn = Number(userData.qualifyingSalesNgn || 0);
  const earnedDaysTotal = Math.floor(qualifyingSalesNgn / 1000) * 3;
  const claimedDaysTotal = Number(userData.claimedDaysTotal || 0);
  const availableDays = Math.max(0, earnedDaysTotal - claimedDaysTotal);

  const progressNgn = qualifyingSalesNgn % 1000;
  const neededForNextRewardNgn = 1000 - progressNgn;

  // Count customers referred
  let referredCount = 0;
  for (const u of Object.values(inMemoryReferralData.users)) {
    if (u.referredBy === uid) referredCount++;
  }

  // Get recent purchases where referrerUid === uid
  const recentPurchases = [];
  for (const p of Object.values(inMemoryReferralData.purchases)) {
    if (p.referrerUid === uid) {
      const maskedBuyer = p.buyerUid ? `User ...${String(p.buyerUid).slice(-4)}` : "Referred User";
      recentPurchases.push({
        purchaseId: p.purchaseId,
        buyer: maskedBuyer,
        buyerUid: p.buyerUid,
        buyerEmailMasked: p.buyerEmailMasked || maskedBuyer,
        durationDays: p.durationDays,
        amountNgn: p.amountNgn,
        qualifyingAmountNgn: p.amountNgn,
        isQualifying: p.isQualifying,
        createdAt: p.createdAt,
      });
    }
  }

  // Sort descending by date
  recentPurchases.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  // Recent claims for this user
  const recentClaims = [];
  for (const c of Object.values(inMemoryReferralData.claims)) {
    if (c.userUid === uid) {
      recentClaims.push(c);
    }
  }
  recentClaims.sort((a, b) => new Date(b.claimedAt || 0).getTime() - new Date(a.claimedAt || 0).getTime());

  return {
    referralCode,
    referralLink,
    referredBy: userData.referredBy || null,
    referredByCode: userData.referredByCode || null,
    referredAt: userData.referredAt || null,
    qualifyingSalesNgn,
    earnedDaysTotal,
    claimedDaysTotal,
    availableDays,
    progressNgn,
    neededForNextRewardNgn,
    referredCount,
    purchases: recentPurchases.slice(0, 20),
    claims: recentClaims.slice(0, 10),
  };
}

/**
 * Retrieves aggregate referral records for the administrator console.
 */
export async function getAdminReferralAudit() {
  await loadReferralStore();

  const referrersMap = {};
  let totalQualifyingSalesNgn = 0;
  let totalReferredCustomers = 0;

  for (const [uUid, uData] of Object.entries(inMemoryReferralData.users)) {
    if (uData.referredBy) {
      totalReferredCustomers++;
    }
    const sales = Number(uData.qualifyingSalesNgn || 0);
    const earned = Math.floor(sales / 1000) * 3;
    const claimed = Number(uData.claimedDaysTotal || 0);
    const available = Math.max(0, earned - claimed);

    if (sales > 0 || uData.referralCode) {
      referrersMap[uUid] = {
        uid: uUid,
        email: uData.email || "—",
        referralCode: uData.referralCode || "—",
        qualifyingSalesNgn: sales,
        earnedDaysTotal: earned,
        claimedDaysTotal: claimed,
        availableDays: available,
        referredCount: 0,
        referredUsersCount: 0,
      };
      totalQualifyingSalesNgn += sales;
    }
  }

  // Count referred users per referrer
  for (const u of Object.values(inMemoryReferralData.users)) {
    if (u.referredBy && referrersMap[u.referredBy]) {
      referrersMap[u.referredBy].referredCount++;
      referrersMap[u.referredBy].referredUsersCount++;
    }
  }

  const referrersList = Object.values(referrersMap).sort(
    (a, b) => b.qualifyingSalesNgn - a.qualifyingSalesNgn
  );

  const purchasesList = Object.values(inMemoryReferralData.purchases).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );

  const totalRewardsGeneratedCount = Math.floor(totalQualifyingSalesNgn / 1000);
  const totalRewardsEarnedDays = totalRewardsGeneratedCount * 3;
  let totalRewardsClaimedDays = 0;
  for (const c of Object.values(inMemoryReferralData.claims)) {
    totalRewardsClaimedDays += Number(c.daysAwarded || 0);
  }

  return {
    summary: {
      totalReferrers: referrersList.length,
      totalReferredCustomers,
      totalQualifyingSalesNgn,
      totalRewardsGeneratedCount,
      totalRewardsEarnedDays,
      totalRewardsClaimedDays,
      totalRewardsAvailableDays: Math.max(0, totalRewardsEarnedDays - totalRewardsClaimedDays),
    },
    referrers: referrersList,
    recentPurchases: purchasesList.slice(0, 50),
  };
}
