import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSupabaseConfigured, supabaseUpsert, supabaseGetById, supabaseGetAll } from "./supabase.js";
import { applyRewardLicenseExtension, getOfficialLicensePrice } from "./license.js";
import { logger } from "./logger.js";

export { getOfficialLicensePrice };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const LOCAL_STORE_FILE = path.join(DATA_DIR, "referrals-store.json");

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
 * https://solvatech.up.railway.app/?ref=REFERRAL_CODE
 */
export function formatReferralLink(code) {
  if (!code) return "https://solvatech.up.railway.app/";
  const clean = String(code).trim().toUpperCase().replace(/^REF-/, "");
  return `https://solvatech.up.railway.app/?ref=${clean}`;
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
 * Ensures a user account in Supabase has a permanent referral code and link,
 * and attributes an unalterable referrer if candidateReferrerCode is provided.
 */
export async function ensureUserReferralData(uid, email = "", candidateReferrerCode = "", _authToken = null) {
  if (!uid) return null;

  return withReferralLock(async () => {
    await loadReferralStore();

    let localUser = inMemoryReferralData.users[uid] || {};
    let dbUserData = {};

    if (isSupabaseConfigured()) {
      try {
        const uSnap = await supabaseGetById("users", uid, "id");
        if (uSnap) {
          dbUserData = {
            referralCode: uSnap.referral_code,
            referredBy: uSnap.referred_by,
            qualifyingSalesNgn: Number(uSnap.qualifying_sales_ngn || 0),
            claimedDaysTotal: Number(uSnap.claimed_days_total || 0),
            email: uSnap.email,
          };
        }
      } catch (err) {
        logger.debug("Supabase get user notice in ensureUserReferralData", err.message);
      }
    }

    const merged = { ...localUser, ...dbUserData };
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

        // Check Supabase users if not found in local store
        if (!foundReferrerUid && isSupabaseConfigured()) {
          try {
            const allUsers = await supabaseGetAll("users");
            for (const d of (allUsers || [])) {
              if (d.id === uid) continue;
              const dCode = (d.referral_code || "").toUpperCase().replace(/^REF-/, "");
              if (dCode === cleanCandidate) {
                foundReferrerUid = d.id;
                break;
              }
            }
          } catch (err) {
            logger.debug("Supabase lookup for referrer notice", err.message);
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
          referredByCode = cleanCandidate;
          referredAt = new Date().toISOString();
          updates.referredByCode = cleanCandidate;
          updates.referredAt = referredAt;
          needsUpdate = true;
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

    // Sync to Supabase if configured
    if (isSupabaseConfigured()) {
      try {
        await supabaseUpsert("users", {
          id: uid,
          email: finalRecord.email || "",
          display_name: finalRecord.displayName || (finalRecord.email ? finalRecord.email.split("@")[0] : "User"),
          referral_code: finalRecord.referralCode,
          referred_by: finalRecord.referredBy,
          qualifying_sales_ngn: finalRecord.qualifyingSalesNgn,
          claimed_days_total: finalRecord.claimedDaysTotal,
          last_login_at: new Date().toISOString(),
        }, "id");
      } catch (sbErr) {
        logger.debug("Supabase user referral data notice:", sbErr.message);
      }
    }

    if (needsUpdate) {
      await persistReferralStore();
    }

    return finalRecord;
  });
}

/**
 * Records a qualifying paid license purchase for referral credit in Supabase.
 */
export async function recordPurchaseForReferral(
  buyerUid,
  durationDays,
  licenseCode,
  isRewardOrFree = false,
  buyerEmail = "",
  _authToken = null
) {
  if (!buyerUid || !licenseCode) return { processed: false, reason: "Missing buyerUid or licenseCode" };

  const cleanLicenseCode = String(licenseCode).trim().toUpperCase();
  const purchaseId = `PURCH-${cleanLicenseCode.replace(/[^A-Z0-9]/g, "")}`;

  return withReferralLock(async () => {
    await loadReferralStore();

    if (inMemoryReferralData.purchases[purchaseId]) {
      return { alreadyCounted: true, purchaseId };
    }

    if (isSupabaseConfigured()) {
      try {
        const pSnap = await supabaseGetById("referral_purchases", purchaseId, "purchase_id");
        if (pSnap) {
          inMemoryReferralData.purchases[purchaseId] = pSnap;
          return { alreadyCounted: true, purchaseId };
        }
      } catch (err) {}
    }

    const amountNgn = isRewardOrFree ? 0 : getOfficialLicensePrice(durationDays);

    let buyerData = inMemoryReferralData.users[buyerUid] || {};
    if (!buyerData.referredBy && isSupabaseConfigured()) {
      try {
        const bSnap = await supabaseGetById("users", buyerUid, "id");
        if (bSnap) {
          buyerData = {
            referredBy: bSnap.referred_by,
            email: bSnap.email,
          };
          inMemoryReferralData.users[buyerUid] = { ...inMemoryReferralData.users[buyerUid], ...buyerData };
        }
      } catch (err) {}
    }

    const referrerUid = buyerData.referredBy || null;
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

    if (isSupabaseConfigured()) {
      try {
        await supabaseUpsert("referral_purchases", {
          purchase_id: purchaseId,
          buyer_uid: buyerUid,
          buyer_email: purchaseRecord.buyerEmail,
          referrer_uid: referrerUid,
          license_code: cleanLicenseCode,
          duration_days: String(durationDays),
          amount_ngn: amountNgn,
          is_qualifying: isQualifying,
          created_at: purchaseRecord.createdAt,
        }, "purchase_id");
      } catch (sbErr) {
        logger.debug("Supabase purchase write notice:", sbErr.message);
      }
    }

    if (isQualifying && referrerUid) {
      let referrerData = inMemoryReferralData.users[referrerUid] || {};
      if (isSupabaseConfigured()) {
        try {
          const rSnap = await supabaseGetById("users", referrerUid, "id");
          if (rSnap) {
            referrerData = {
              ...referrerData,
              qualifyingSalesNgn: Number(rSnap.qualifying_sales_ngn || 0),
            };
          }
        } catch (err) {}
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

      if (isSupabaseConfigured()) {
        try {
          await supabaseUpsert("users", {
            id: referrerUid,
            qualifying_sales_ngn: newSales,
            updated_at: updatedReferrer.updatedAt,
          }, "id");
        } catch (err) {}
      }

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

          if (isSupabaseConfigured()) {
            try {
              await supabaseUpsert("referral_rewards", {
                reward_id: rewardId,
                referrer_uid: referrerUid,
                threshold_ngn: threshold,
                free_days: 3,
                status: "earned",
                created_at: rewardRecord.createdAt,
              }, "reward_id");
            } catch (err) {}
          }
        }
        logger.info(`Referrer ${referrerUid} earned ${newlyEarnedRewards * 3} free days from ₦${newSales} sales`);
      }
    }

    await persistReferralStore();
    return { success: true, purchaseId, amountNgn, isQualifying, referrerUid };
  });
}

/**
 * Claims available referral reward free days in Supabase.
 */
export async function claimReferralReward(uid, userEmail = "", _authToken = null) {
  if (!uid) throw new Error("Authenticated user UID is required.");

  return withReferralLock(async () => {
    await loadReferralStore();

    let userData = inMemoryReferralData.users[uid] || {};
    if (isSupabaseConfigured()) {
      try {
        const uSnap = await supabaseGetById("users", uid, "id");
        if (uSnap) {
          userData = {
            ...userData,
            qualifyingSalesNgn: Number(uSnap.qualifying_sales_ngn || 0),
            claimedDaysTotal: Number(uSnap.claimed_days_total || 0),
            email: uSnap.email,
          };
          inMemoryReferralData.users[uid] = userData;
        }
      } catch (err) {}
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

    const extensionResult = await applyRewardLicenseExtension(
      uid,
      daysAwarded,
      claimId,
      userEmail || userData.email || ""
    );

    userData.claimedDaysTotal = newClaimedTotal;
    userData.updatedAt = new Date().toISOString();
    inMemoryReferralData.users[uid] = userData;

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

    if (isSupabaseConfigured()) {
      try {
        await Promise.all([
          supabaseUpsert("referral_claims", {
            claim_id: claimId,
            user_uid: uid,
            user_email: userEmail || userData.email || "",
            days_awarded: daysAwarded,
            claimed_at: claimRecord.claimedAt,
            previous_expires_at: claimRecord.previousExpiresAt,
            new_expires_at: claimRecord.newExpiresAt,
            status: "completed",
          }, "claim_id"),
          supabaseUpsert("users", {
            id: uid,
            claimed_days_total: newClaimedTotal,
            last_login_at: new Date().toISOString(),
          }, "id"),
        ]);
      } catch (sbErr) {
        logger.debug("Supabase claim record write notice:", sbErr.message);
      }
    }

    await persistReferralStore();
    logger.info(`User ${uid} claimed 3 free days reward (Claim ID: ${claimId})`);

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
 * Retrieves referral metrics and activity history for a user from Supabase.
 */
export async function getReferralStats(uid) {
  if (!uid) return null;

  await loadReferralStore();
  let userData = inMemoryReferralData.users[uid] || {};

  if (isSupabaseConfigured()) {
    try {
      const uSnap = await supabaseGetById("users", uid, "id");
      if (uSnap) {
        userData = {
          ...userData,
          referralCode: uSnap.referral_code,
          referredBy: uSnap.referred_by,
          qualifyingSalesNgn: Number(uSnap.qualifying_sales_ngn || 0),
          claimedDaysTotal: Number(uSnap.claimed_days_total || 0),
          email: uSnap.email,
        };
        inMemoryReferralData.users[uid] = userData;
      }
    } catch (err) {}
  }

  const referralCode = userData.referralCode || generateReferralCode();
  const referralLink = formatReferralLink(referralCode);
  const qualifyingSalesNgn = Number(userData.qualifyingSalesNgn || 0);
  const earnedDaysTotal = Math.floor(qualifyingSalesNgn / 1000) * 3;
  const claimedDaysTotal = Number(userData.claimedDaysTotal || 0);
  const availableDays = Math.max(0, earnedDaysTotal - claimedDaysTotal);

  const progressNgn = qualifyingSalesNgn % 1000;
  const neededForNextRewardNgn = 1000 - progressNgn;

  let referredCount = 0;
  for (const u of Object.values(inMemoryReferralData.users)) {
    if (u.referredBy === uid) referredCount++;
  }

  const recentPurchases = [];
  for (const p of Object.values(inMemoryReferralData.purchases)) {
    if (p.referrerUid === uid) {
      recentPurchases.push(p);
    }
  }
  recentPurchases.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const recentClaims = [];
  for (const c of Object.values(inMemoryReferralData.claims)) {
    if (c.userUid === uid) recentClaims.push(c);
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
 * Retrieves aggregate referral records for the administrator console from Supabase.
 */
export async function getAdminReferralAudit() {
  await loadReferralStore();

  let users = Object.values(inMemoryReferralData.users);
  let purchases = Object.values(inMemoryReferralData.purchases);
  let claims = Object.values(inMemoryReferralData.claims);

  if (isSupabaseConfigured()) {
    try {
      const [sbUsers, sbPurchases, sbClaims] = await Promise.all([
        supabaseGetAll("users").catch(() => []),
        supabaseGetAll("referral_purchases").catch(() => []),
        supabaseGetAll("referral_claims").catch(() => []),
      ]);
      if (sbUsers && sbUsers.length > 0) {
        users = sbUsers.map((u) => ({
          uid: u.id,
          email: u.email,
          referralCode: u.referral_code,
          referredBy: u.referred_by,
          qualifyingSalesNgn: Number(u.qualifying_sales_ngn || 0),
          claimedDaysTotal: Number(u.claimed_days_total || 0),
        }));
      }
      if (sbPurchases && sbPurchases.length > 0) {
        purchases = sbPurchases.map((p) => ({
          purchaseId: p.purchase_id,
          buyerUid: p.buyer_uid,
          buyerEmail: p.buyer_email,
          referrerUid: p.referrer_uid,
          licenseCode: p.license_code,
          durationDays: p.duration_days,
          amountNgn: Number(p.amount_ngn || 0),
          isQualifying: Boolean(p.is_qualifying),
          createdAt: p.created_at,
        }));
      }
      if (sbClaims && sbClaims.length > 0) {
        claims = sbClaims.map((c) => ({
          claimId: c.claim_id,
          userUid: c.user_uid,
          daysAwarded: Number(c.days_awarded || 0),
          claimedAt: c.claimed_at,
        }));
      }
    } catch (err) {}
  }

  const referrersMap = {};
  let totalQualifyingSalesNgn = 0;
  let totalReferredCustomers = 0;

  for (const uData of users) {
    if (uData.referredBy) {
      totalReferredCustomers++;
    }
    const sales = Number(uData.qualifyingSalesNgn || 0);
    const earned = Math.floor(sales / 1000) * 3;
    const claimed = Number(uData.claimedDaysTotal || 0);
    const available = Math.max(0, earned - claimed);

    if (sales > 0 || uData.referralCode) {
      referrersMap[uData.uid] = {
        uid: uData.uid,
        email: uData.email || "—",
        referralCode: uData.referralCode || "—",
        qualifyingSalesNgn: sales,
        earnedDaysTotal: earned,
        claimedDaysTotal: claimed,
        availableDays: available,
        referredCount: 0,
      };
      totalQualifyingSalesNgn += sales;
    }
  }

  for (const u of users) {
    if (u.referredBy && referrersMap[u.referredBy]) {
      referrersMap[u.referredBy].referredCount++;
    }
  }

  const referrersList = Object.values(referrersMap).sort(
    (a, b) => b.qualifyingSalesNgn - a.qualifyingSalesNgn
  );

  purchases.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const totalRewardsGeneratedCount = Math.floor(totalQualifyingSalesNgn / 1000);
  const totalRewardsEarnedDays = totalRewardsGeneratedCount * 3;
  let totalRewardsClaimedDays = 0;
  for (const c of claims) {
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
    recentPurchases: purchases.slice(0, 50),
  };
}
