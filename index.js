import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { getWhatsAppController, restoreAllSessions, auditActiveSessions, getAllWhatsAppStatuses } from "./lib/whatsapp.js";
import { getLockedNumberForUid, getAllNumberLocks, unlinkNumberFromUser, unlinkPhoneNumber } from "./lib/number-lock.js";
import { requireAuth, requireAdmin, isAdminEmail, createPreviewToken, getFirebaseServerFirestore } from "./lib/auth.js";
import { isSupabaseConfigured, getSupabasePublicConfig, supabaseUpsert, checkSupabaseSchemaStatus } from "./lib/supabase.js";
import { getUserPreferences, setUserPreferences } from "./lib/database.js";
import {
  createLicenseRecord,
  listAllLicenses,
  redeemLicenseCode,
  getUserLicenseStatus,
  listAllUsersWithLicenses,
  toggleUserUnlimitedStatus,
  deleteUserFromSystem,
  addUnlimitedUserByEmail,
  grantUserCustomDays,
  deleteLicenseKey,
  purgeExpiredOrUnusedKeys,
  adminOverwriteUserRecord,
  adminGenerateKeyForUser,
  getGlobalRailwayConfig,
  setGlobalRailwayConfig,
  getGlobalLicensePlans,
  updateGlobalLicensePlans,
  getMaintenanceDiagnostics,
  performSafeMaintenanceCleanup,
  getOfficialLicensePrice,
  syncAllLicensesFromCloud,
  ADMIN_EMAIL,
} from "./lib/license.js";
import {
  ensureUserReferralData,
  getReferralStats,
  claimReferralReward,
  getAdminReferralAudit,
} from "./lib/referral.js";
import {
  getCustomerPaymentPlans,
  getPaymentConfig,
  updatePaymentConfig,
  createCustomerPaymentSession,
  submitPaymentReceipt,
  cancelCustomerPaymentSession,
  getPaymentByReference,
  listCustomerPayments,
  listAllPaymentRequests,
  approvePaymentRequest,
  rejectPaymentRequest,
  getPaymentReceiptBinary,
  deletePaymentRequest,
  syncAllPaymentsFromCloud,
} from "./lib/payments.js";
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  sendAdminPushNotification,
} from "./lib/web-push.js";

const origConsoleError = console.error;
const origConsoleWarn = console.warn;
const origConsoleLog = console.log;

function isNoisyInternalLog(args) {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") return a.message || a.name || "";
      return "";
    })
    .join(" ");
  return (
    text.includes("Disconnecting idle stream") ||
    text.includes("Timed out waiting for new targets") ||
    text.includes("Closing session:") ||
    text.includes("Closing open session in favor of incoming prekey bundle") ||
    text.includes("Removing old closed session:") ||
    text.includes("Failed to decrypt message with any known session") ||
    text.includes("Session error:") ||
    text.includes("Bad MAC") ||
    text.includes("Key used already or never filled") ||
    text.includes("MessageCounterError")
  );
}

console.error = (...args) => {
  if (isNoisyInternalLog(args)) return;
  origConsoleError.apply(console, args);
};
console.warn = (...args) => {
  if (isNoisyInternalLog(args)) return;
  origConsoleWarn.apply(console, args);
};
console.log = (...args) => {
  if (isNoisyInternalLog(args)) return;
  origConsoleLog.apply(console, args);
};

process.on("uncaughtException", (error) => {
  logger.error("Process uncaught exception handled gracefully", error?.stack || error?.message);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  logger.error("Process unhandled rejection handled gracefully", msg);
});

const app = express();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");

// Ensure all Railway/Firebase environment variables are hydrated from configuration
try {
  let cfg = {};
  const configPath = path.join(rootDir, "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {}
  }
  if (!process.env.FIREBASE_PROJECT_ID?.trim() && cfg.projectId) process.env.FIREBASE_PROJECT_ID = cfg.projectId;
  if (!process.env.FIREBASE_API_KEY?.trim() && cfg.apiKey) process.env.FIREBASE_API_KEY = cfg.apiKey;
  if (!process.env.FIREBASE_AUTH_DOMAIN?.trim() && cfg.authDomain) process.env.FIREBASE_AUTH_DOMAIN = cfg.authDomain;
  if (!process.env.FIREBASE_DATABASE_ID?.trim() && cfg.firestoreDatabaseId) process.env.FIREBASE_DATABASE_ID = cfg.firestoreDatabaseId;
  if (!process.env.FIREBASE_STORAGE_BUCKET?.trim() && cfg.storageBucket) process.env.FIREBASE_STORAGE_BUCKET = cfg.storageBucket;
  if (!process.env.FIREBASE_APP_ID?.trim() && cfg.appId) process.env.FIREBASE_APP_ID = cfg.appId;
  process.env.ADMIN_EMAIL = "awoyinfasolomon1@gmail.com";
  if (!process.env.BOT_API_PREFIX?.trim()) process.env.BOT_API_PREFIX = "/bot-api";
  if (!process.env.BOT_DATA_DIR?.trim()) process.env.BOT_DATA_DIR = "./data";
} catch (e) {
  logger.warn("Could not auto-hydrate Firebase environment variables", e.message);
}

const apiPrefix = String(process.env.BOT_API_PREFIX || "/bot-api").replace(/\/$/, "");

// Explicit CORS configuration for Railway, GitHub Pages frontend, custom domains, and local development
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin, x-user-id, Cache-Control, Pragma");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const staticOptions = {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Service-Worker-Allowed", "/");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (filePath.endsWith(".webmanifest") || filePath.endsWith("manifest.json")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  }
};

app.use(express.static(rootDir, staticOptions));
app.use(express.static(publicDir, staticOptions));

/**
 * ARCHITECTURAL NOTE - STORAGE ON RAILWAY & PRODUCTION:
 * ======================================================
 * Currently, WhatsApp authentication keys and session state are stored in the local
 * filesystem directory (`sessions/<safeUserId>`) via Baileys multi-file auth state,
 * and group settings in `data/group-settings-<safeUserId>.json`.
 *
 * Ephemeral container platforms like Railway rebuild/restart containers, which resets
 * local filesystem storage unless a persistent Railway Volume is mounted to `./sessions`
 * and `./data`, or session state is synced to Cloud Firestore / database.
 *
 * For this phase, session directory isolation is strictly keyed to the verified Firebase UID.
 */

function getFirebaseClientConfig() {
  try {
    const configPath = path.join(rootDir, "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return {
        apiKey: parsed.apiKey,
        authDomain: parsed.authDomain,
        projectId: parsed.projectId,
        storageBucket: parsed.storageBucket,
        messagingSenderId: parsed.messagingSenderId,
        appId: parsed.appId,
        firestoreDatabaseId: parsed.firestoreDatabaseId || "(default)",
      };
    }
  } catch (error) {
    logger.warn("Could not read firebase-applet-config.json", error.message);
  }
  return null;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

const prefixes = Array.from(new Set([apiPrefix, "/api", "/bot-api", ""]));

for (const p of prefixes) {
  // Public Health, Firebase, and Supabase Config endpoints
  app.get(`${p}/health`, async (_request, response) => {
    const schemaStatus = await checkSupabaseSchemaStatus();
    response.json({
      status: "ok",
      database: schemaStatus.schemaReady ? "supabase" : "local-durable-fallback",
      supabaseConfigured: schemaStatus.configured,
      supabaseSchemaReady: schemaStatus.schemaReady,
      notice: schemaStatus.schemaReady
        ? "Supabase schema is live and verified."
        : schemaStatus.configured
        ? "Supabase credentials detected, but database tables are not yet created in Supabase. Run supabase-schema.sql in the Supabase SQL Editor. Operating in safe local fallback."
        : "Supabase credentials not configured in environment. Operating in safe local fallback.",
    });
  });

  app.get(`${p}/supabase-config`, (_request, response) => {
    response.json(getSupabasePublicConfig());
  });

  app.get(`${p}/firebase-config`, (_request, response) => {
    const config = getFirebaseClientConfig();
    if (!config) {
      return response.status(500).json({ error: "Firebase configuration is not available on the server." });
    }
    response.json(config);
  });

  // Studio Preview / Development Session Provider
  // Used when testing in environments whose dynamic domain is not yet allowlisted in Firebase Console.
  app.post(`${p}/auth/preview-session`, (request, response) => {
    const email = (request.body?.email || ADMIN_EMAIL).trim().toLowerCase();
    const isAdm = isAdminEmail(email);
    const user = {
      uid: (isAdm ? "admin_" : "user_") + email.replace(/[^a-zA-Z0-9_-]/g, "_"),
      email: email,
      displayName: isAdm ? "Solomon Awoyinfa (Admin)" : email.split("@")[0],
      photoURL: "./solva.webp",
    };
    const token = createPreviewToken(user);
    response.json({
      token,
      user,
      mode: "preview",
      message: "Studio preview session established successfully.",
    });
  });

  // Protected Routes: Require valid Firebase Auth Bearer token
  // The verified Firebase UID is authoritative and determines the WhatsApp session.
  // Any client-supplied body.userId, query.userId, or header x-user-id is strictly ignored.
  app.get(`${p}/status`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const userEmail = request.auth.email;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail });
    
    const [lockedNumber, license] = await Promise.all([
      getLockedNumberForUid(verifiedUid),
      getUserLicenseStatus(verifiedUid, userEmail),
    ]);

    const currentStatus = controller.getStatus();
    if (
      license?.hasActiveLicense &&
      currentStatus.status === "idle" &&
      !currentStatus.pairingCode &&
      controller.hasSavedSession()
    ) {
      controller.ensureConnected().catch(() => {});
    }

    const latestStatus = controller.getStatus();
    const preferences = await getUserPreferences(safeUserId);

    if (isSupabaseConfigured() && verifiedUid) {
      supabaseUpsert("users", {
        id: verifiedUid,
        email: userEmail || "",
        display_name: request.auth.displayName || "",
        photo_url: request.auth.photoURL || "",
        last_login_at: new Date().toISOString(),
      }, "id").catch(() => {});
    }

    response.json({
      ...latestStatus,
      phoneNumber: latestStatus.botNumber || lockedNumber || "",
      lockedNumber,
      license,
      preferences,
      userId: verifiedUid,
      user: {
        uid: request.auth.uid,
        email: request.auth.email,
        displayName: request.auth.displayName,
        photoURL: request.auth.photoURL,
      },
    });
  });

  app.get(`${p}/user/preferences`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const prefs = await getUserPreferences(safeUserId);
    response.json({ ok: true, preferences: prefs, userId: request.verifiedUid });
  });

  app.post(`${p}/user/preferences`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const patch = request.body || {};
    const updated = await setUserPreferences(safeUserId, patch);
    response.json({ ok: true, preferences: updated, userId: request.verifiedUid });
  });

  app.post(`${p}/reconnect`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const userEmail = request.auth.email;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail });
    try {
      await controller.start();
      controller.recheckCommunity?.();
      response.json({ ok: true, ...controller.getStatus(), userId: verifiedUid });
    } catch (error) {
      response.status(500).json({ error: error.message || "Reconnect failed.", userId: verifiedUid });
    }
  });

  app.post(`${p}/clear-cache`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
    try {
      await controller.disconnect();
      response.json({ ok: true, status: "idle", message: "Session cache cleared.", userId: verifiedUid });
    } catch (error) {
      response.status(500).json({ error: error.message || "Could not clear cache.", userId: verifiedUid });
    }
  });

  app.get(`${p}/user/profile`, requireAuth, (request, response) => {
    response.json({
      uid: request.auth.uid,
      email: request.auth.email,
      displayName: request.auth.displayName,
      photoURL: request.auth.photoURL,
    });
  });

  app.post(`${p}/pair`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const userEmail = request.auth.email;

    try {
      // License enforcement: Admin (awoyinfasolomon1@gmail.com) has automatic unlimited active status.
      // Normal users must have an active, non-expired license.
      const licenseStatus = await getUserLicenseStatus(verifiedUid, userEmail);
      if (!licenseStatus.hasActiveLicense) {
        return response.status(403).json({
          error: "Active license required. Please enter and redeem a valid SOLVATECH activation code in your dashboard before pairing your WhatsApp account.",
          code: "LICENSE_REQUIRED",
          userId: verifiedUid,
        });
      }

      const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail });
      const result = await controller.requestPairingCode(request.body?.number);
      response.json({
        code: result.code,
        pairingCode: result.code,
        expiresAt: result.expiresAt,
        pairingNumber: result.phone,
        userId: verifiedUid,
      });
    } catch (error) {
      logger.error(`Pairing request failed for verified user ${verifiedUid}`, error.stack || error.message);
      const statusCode = error.code === "NUMBER_LOCKED_TO_ANOTHER_ACCOUNT" || error.code === "ACCOUNT_LOCKED_TO_DIFFERENT_NUMBER" ? 403 : 400;
      response.status(statusCode).json({
        error: error.message || "Pairing code could not be generated.",
        code: error.code || "PAIRING_FAILED",
        statusCode: error?.output?.statusCode ?? error?.statusCode ?? null,
        userId: verifiedUid,
      });
    }
  });

  app.post(`${p}/disconnect`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
    try {
      await controller.disconnect();
      response.json({ ok: true, status: "idle", userId: verifiedUid });
    } catch (error) {
      logger.error(`Disconnect failed for verified user ${verifiedUid}`, error.stack || error.message);
      response.status(500).json({ error: "The WhatsApp session could not be cleared.", userId: verifiedUid });
    }
  });

  app.post(`${p}/number/unlink`, requireAuth, async (request, response) => {
    try {
      const verifiedUid = request.verifiedUid;
      const targetPhone = request.body?.phoneNumber || "";
      const result = await unlinkNumberFromUser(verifiedUid, targetPhone);
      response.json({ ok: true, ...result, message: "Number successfully unlinked from account." });
    } catch (err) {
      logger.error("Unlink number failed", err.stack || err.message);
      response.status(500).json({ error: "Failed to unlink number." });
    }
  });

  app.post(`${p}/number/release`, requireAuth, async (request, response) => {
    try {
      const targetPhone = request.body?.phoneNumber || request.body?.number || "";
      if (!targetPhone) {
        return response.status(400).json({ error: "Please provide a phone number to release." });
      }
      const result = await unlinkPhoneNumber(targetPhone);
      response.json({ ok: true, ...result, message: `Number (+${result.phone || targetPhone}) released successfully.` });
    } catch (err) {
      logger.error("Release phone number failed", err.stack || err.message);
      response.status(500).json({ error: "Failed to release number lock." });
    }
  });

  app.post(`${p}/unpair`, requireAuth, async (request, response) => {
    const safeUserId = request.safeUserId;
    const verifiedUid = request.verifiedUid;
    const controller = getWhatsAppController(safeUserId, { verifiedUid, userEmail: request.auth.email });
    try {
      await controller.disconnect();
      await unlinkNumberFromUser(verifiedUid);
      response.json({ ok: true, status: "idle", message: "WhatsApp session disconnected and phone number unlinked.", userId: verifiedUid });
    } catch (error) {
      logger.error(`Unpair failed for verified user ${verifiedUid}`, error.stack || error.message);
      response.status(500).json({ error: "Could not unpair session.", userId: verifiedUid });
    }
  });

  // --------------------------------------------------------------------------
  // USER LICENSE ROUTES (Authenticated)
  // --------------------------------------------------------------------------
  app.get(`${p}/license/status`, requireAuth, async (request, response) => {
    try {
      const verifiedUid = request.verifiedUid;
      const userEmail = request.auth.email;
      const status = await getUserLicenseStatus(verifiedUid, userEmail, request.headers.authorization);
      response.json({
        ...status,
        userId: verifiedUid,
        userEmail: request.auth.email,
        isAdmin: request.auth.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
      });
    } catch (error) {
      logger.error("Failed to retrieve license status", error.stack || error.message);
      response.status(500).json({ error: "Could not fetch license status." });
    }
  });

  app.post(`${p}/license/redeem`, requireAuth, async (request, response) => {
    try {
      const code = request.body?.code;
      const candidateRef = request.body?.ref || request.query?.ref || "";
      if (!code) {
        return response.status(400).json({ error: "Please enter a valid license code." });
      }

      // Verified user from authoritative Firebase token - NOT request body
      const verifiedUser = {
        uid: request.verifiedUid,
        email: request.auth.email,
      };

      // If user came in through a referral link or has a preserved referral code, ensure permanent attribution in Firebase before redemption
      if (candidateRef) {
        try {
          await ensureUserReferralData(
            request.verifiedUid,
            request.auth.email,
            candidateRef,
            request.headers.authorization
          );
        } catch (refErr) {
          logger.warn("Pre-redemption referral attribution notice", refErr.message);
        }
      }

      const result = await redeemLicenseCode(code, verifiedUser, request.headers.authorization);

      // Auto-reconnect existing saved session if present and valid
      const controller = getWhatsAppController(request.safeUserId, {
        verifiedUid: request.verifiedUid,
        userEmail: request.auth.email,
      });
      if (controller.hasSavedSession() && !controller.isConnected()) {
        logger.info(`Auto-reconnecting WhatsApp session for user ${request.verifiedUid} after license redemption`);
        controller.start().catch((err) => {
          logger.warn("Auto-reconnect after license redemption notice", err.message);
        });
      }

      response.json(result);
    } catch (error) {
      logger.warn(`License redemption rejected for user ${request.verifiedUid}: ${error.message}`);
      const statusCode = error.code === "LICENSE_NOT_FOUND" ? 404 : error.code === "LICENSE_ALREADY_USED" ? 409 : 400;
      response.status(statusCode).json({
        error: error.message || "License redemption failed.",
        code: error.code || "REDEMPTION_FAILED",
      });
    }
  });

  // --------------------------------------------------------------------------
  // REFERRAL SYSTEM ROUTES (Permanent Firebase Source of Truth)
  // --------------------------------------------------------------------------
  app.get(`${p}/referral/me`, requireAuth, async (request, response) => {
    try {
      const candidateCode = request.query?.ref || "";
      await ensureUserReferralData(
        request.verifiedUid,
        request.auth.email,
        candidateCode,
        request.headers.authorization
      );
      const stats = await getReferralStats(request.verifiedUid);
      response.json({
        success: true,
        ...stats,
      });
    } catch (error) {
      logger.error("Get referral stats error", error.stack || error.message);
      response.status(500).json({ error: "Failed to load referral details." });
    }
  });

  app.post(`${p}/referral/attribute`, requireAuth, async (request, response) => {
    try {
      const candidateCode = request.body?.code || request.body?.ref || request.query?.ref || "";
      if (!candidateCode) {
        return response.status(400).json({ error: "Referral code is required." });
      }
      await ensureUserReferralData(
        request.verifiedUid,
        request.auth.email,
        candidateCode,
        request.headers.authorization
      );
      const stats = await getReferralStats(request.verifiedUid);
      response.json({
        success: true,
        message: "Referral attribution processed.",
        ...stats,
      });
    } catch (error) {
      logger.error("Attribute referral error", error.stack || error.message);
      response.status(500).json({ error: "Failed to attribute referral code." });
    }
  });

  app.post(`${p}/referral/claim`, requireAuth, async (request, response) => {
    try {
      const result = await claimReferralReward(
        request.verifiedUid,
        request.auth.email,
        request.headers.authorization
      );
      response.json(result);
    } catch (error) {
      logger.warn(`Referral claim failed for user ${request.verifiedUid}: ${error.message}`);
      const statusCode = error.code === "NO_REWARD_AVAILABLE" ? 400 : 500;
      response.status(statusCode).json({
        error: error.message || "Failed to claim referral reward.",
        code: error.code || "CLAIM_FAILED",
      });
    }
  });

  // --------------------------------------------------------------------------
  // ADMIN LICENSE & REFERRAL AUDIT ROUTES (Strictly Admin Email: awoyinfasolomon1@gmail.com)
  // --------------------------------------------------------------------------
  app.get(`${p}/admin/overview`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const authToken = _request.headers.authorization || null;
      const [licenses, numberLocks, referralAudit, whatsappList, fullUserRecords, paymentRequests, paymentConfig] = await Promise.all([
        listAllLicenses(authToken).catch(e => { logger.debug("listAllLicenses err:", e.message); return []; }),
        getAllNumberLocks().catch(e => { logger.debug("getAllNumberLocks err:", e.message); return {}; }),
        getAdminReferralAudit(authToken).catch(e => { logger.debug("getAdminReferralAudit err:", e.message); return {}; }),
        Promise.resolve(getAllWhatsAppStatuses()).catch(() => []),
        listAllUsersWithLicenses(authToken).catch(e => { logger.debug("listAllUsersWithLicenses err:", e.message); return []; }),
        listAllPaymentRequests().catch(e => { logger.debug("listAllPaymentRequests err:", e.message); return []; }),
        getPaymentConfig().catch(e => { logger.debug("getPaymentConfig err:", e.message); return {}; }),
      ]);

      const locksByUid = {};
      for (const [phone, lock] of Object.entries(numberLocks || {})) {
        if (lock && lock.uid) {
          locksByUid[lock.uid] = phone;
        }
      }

      const wsByUid = {};
      for (const ws of (whatsappList || [])) {
        if (ws && ws.verifiedUid) {
          wsByUid[ws.verifiedUid] = ws;
        }
      }

      const referrersByUid = {};
      for (const ref of (referralAudit?.referrers || [])) {
        if (ref && ref.uid) {
          referrersByUid[ref.uid] = ref;
        }
      }

      const now = Date.now();
      const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

      let totalRevenueNgn = 0;
      let expiringSoonCount = 0;
      let expiredCount = 0;
      let unusedCount = 0;
      let usedCount = 0;

      const enrichedLicenses = licenses.map((lic) => {
        const isUsed = lic.status === "used" || Boolean(lic.redeemedByUid);
        const durationDays = Number(lic.durationDays) || 1;
        const priceNgn = getOfficialLicensePrice(durationDays);
        const isLifetime = durationDays >= 36500 || lic.durationDays === "Unlimited";

        let calculatedStatus = "unused";
        let remainingMs = null;

        if (isUsed) {
          usedCount++;
          if (lic.expiresAt) {
            const expiryMs = new Date(lic.expiresAt).getTime();
            remainingMs = expiryMs - now;
            if (isLifetime) {
              calculatedStatus = "lifetime";
            } else if (remainingMs > 0) {
              if (remainingMs <= FORTY_EIGHT_HOURS_MS) {
                calculatedStatus = "expiring_soon";
                expiringSoonCount++;
              } else {
                calculatedStatus = "active";
              }
            } else {
              calculatedStatus = "expired";
              expiredCount++;
            }
          } else if (isLifetime) {
            calculatedStatus = "lifetime";
          } else {
            calculatedStatus = "active";
          }

          if (priceNgn > 0) {
            totalRevenueNgn += priceNgn;
          }
        } else {
          unusedCount++;
          calculatedStatus = "unused";
        }

        const redeemedUid = lic.redeemedByUid || "";
        const phone = locksByUid[redeemedUid] || "";

        return {
          ...lic,
          priceNgn,
          isUsed,
          computedStatus: calculatedStatus,
          remainingMs,
          whatsappNumber: phone,
          customerEmail: lic.redeemedByEmail || "",
          customerName: "",
        };
      });

      const customersMap = {};

      // 1. Seed with full authoritative user records from Supabase (source of truth)
      for (const u of (fullUserRecords || [])) {
        customersMap[u.uid] = {
          uid: u.uid,
          email: u.email && u.email !== "—" ? u.email : "",
          displayName: u.displayName || (u.email ? u.email.split("@")[0] : "User"),
          phoneNumber: u.phoneNumber && u.phoneNumber !== "—" ? u.phoneNumber : "",
          createdAt: u.createdAt || null,
          lastLoginAt: u.lastLoginAt || null,
          isUnlimited: Boolean(u.isUnlimited),
          isAdmin: Boolean(u.isAdmin),
          licenseStatus: u.isUnlimited ? "lifetime" : (u.status || "none"),
          durationDays: u.durationDays,
          expiresAt: u.expiresAt,
          preservedNotice: u.preservedNotice || "",
          savedNormalDays: u.savedNormalDays || null,
          activeLicense: {
            durationDays: u.durationDays,
            expiresAt: u.expiresAt,
            isUnlimited: Boolean(u.isUnlimited),
            status: u.status,
          },
        };
      }

      // 3. Merge redeemed licenses
      for (const lic of enrichedLicenses) {
        if (lic.redeemedByUid) {
          const uid = lic.redeemedByUid;
          if (!customersMap[uid]) {
            customersMap[uid] = {
              uid,
              email: lic.redeemedByEmail || "",
              displayName: lic.customerName || "",
              createdAt: lic.redeemedAt || lic.createdAt || null,
            };
          }
          const wasAlreadyUnlimited = Boolean(
            customersMap[uid].isUnlimited ||
            customersMap[uid].activeLicense?.isUnlimited ||
            customersMap[uid].durationDays === "Unlimited"
          );

          if (!customersMap[uid].activeLicense || (!wasAlreadyUnlimited && new Date(lic.expiresAt || 0) > new Date(customersMap[uid].activeLicense.expiresAt || 0))) {
            customersMap[uid].activeLicense = {
              code: lic.code,
              durationDays: wasAlreadyUnlimited ? "Unlimited" : lic.durationDays,
              expiresAt: wasAlreadyUnlimited ? (customersMap[uid].activeLicense?.expiresAt || lic.expiresAt) : lic.expiresAt,
              redeemedAt: lic.redeemedAt,
              status: wasAlreadyUnlimited ? "lifetime" : lic.computedStatus,
              isUnlimited: wasAlreadyUnlimited,
            };
          }
        }
      }

      for (const ref of (referralAudit?.referrers || [])) {
        if (!customersMap[ref.uid]) {
          customersMap[ref.uid] = {
            uid: ref.uid,
            email: ref.email || "",
            displayName: "",
            createdAt: null,
          };
        }
      }

      const customersList = Object.values(customersMap).map((cust) => {
        const phone = locksByUid[cust.uid] || cust.phoneNumber || "";
        const ws = wsByUid[cust.uid] || null;
        const refInfo = referrersByUid[cust.uid] || null;

        const isOwnerAdmin = Boolean(
          cust.isAdmin ||
          cust.uid === "admin" ||
          isAdminEmail(cust.email) ||
          isAdminEmail(cust.uid)
        );
        const lic = cust.activeLicense || {};
        const isExplicitlyRevoked = cust.isUnlimited === false || lic.isUnlimited === false;
        const isUnlimited = isOwnerAdmin || (!isExplicitlyRevoked && Boolean(
          cust.isUnlimited ||
          lic.isUnlimited ||
          cust.licenseStatus === "lifetime" ||
          cust.licenseStatus === "unlimited" ||
          (lic.durationDays === "Unlimited" && lic.isUnlimited !== false) ||
          (cust.durationDays === "Unlimited" && cust.isUnlimited !== false)
        ));

        let licenseStatus = "none";
        let remainingMs = null;
        let expiresAt = lic.expiresAt || cust.expiresAt || null;

        let preservedNotice = cust.preservedNotice || lic.preservedNotice || "";
        const savedDays = cust.savedNormalDays || lic.savedNormalDays || (lic.savedRemainingMs ? Math.ceil(lic.savedRemainingMs / 86400000) : null);
        if (savedDays && savedDays > 0 && !preservedNotice) {
          preservedNotice = `Preserved: ${savedDays} normal days left`;
        }

        if (isUnlimited) {
          licenseStatus = "lifetime";
          remainingMs = 3153600000000;
        } else if (expiresAt) {
          const expiryMs = new Date(expiresAt).getTime();
          remainingMs = expiryMs - now;
          if (remainingMs > 0) {
            licenseStatus = remainingMs <= FORTY_EIGHT_HOURS_MS ? "expiring_soon" : "active";
          } else {
            licenseStatus = "expired";
          }
        }

        return {
          ...cust,
          isUnlimited,
          isAdmin: isOwnerAdmin,
          phoneNumber: phone,
          whatsappStatus: ws ? ws.status : phone ? "disconnected" : "never_paired",
          botNumber: ws?.botNumber || phone || "",
          connectedAt: ws?.connectedAt || null,
          licenseStatus,
          status: isUnlimited ? "unlimited" : licenseStatus,
          remainingMs,
          expiresAt,
          preservedNotice,
          savedNormalDays: savedDays || null,
          referralCode: refInfo?.referralCode || cust.referralCode || "",
          qualifyingSalesNgn: refInfo?.qualifyingSalesNgn || 0,
          earnedDaysTotal: refInfo?.earnedDaysTotal || 0,
          claimedDaysTotal: refInfo?.claimedDaysTotal || 0,
          availableDays: refInfo?.availableDays || 0,
          referredCount: refInfo?.referredCount || 0,
        };
      }).sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0));

      const lifetimeCount = customersList.filter((c) => c.isUnlimited).length;
      const activeCount = customersList.filter((c) => c.isUnlimited || c.licenseStatus === "active" || c.licenseStatus === "expiring_soon").length;

      const activityEvents = [];

      for (const lic of licenses) {
        if (lic.createdAt) {
          activityEvents.push({
            id: `lic_create_${lic.code}`,
            type: "LICENSE_GENERATED",
            title: `License Generated (${lic.durationDays} Days)`,
            description: `Code ${lic.code} created`,
            timestamp: lic.createdAt,
            user: lic.createdBy || "Admin",
            meta: { code: lic.code, duration: lic.durationDays },
          });
        }
        if (lic.redeemedAt && lic.redeemedByUid) {
          activityEvents.push({
            id: `lic_redeem_${lic.code}`,
            type: "LICENSE_REDEEMED",
            title: `License Redeemed (${lic.durationDays} Days)`,
            description: `Code ${lic.code} activated by ${lic.redeemedByEmail || lic.redeemedByUid}`,
            timestamp: lic.redeemedAt,
            user: lic.redeemedByEmail || lic.redeemedByUid,
            meta: { code: lic.code, expiresAt: lic.expiresAt },
          });
        }
      }

      for (const pur of (referralAudit?.recentPurchases || [])) {
        if (pur.createdAt) {
          activityEvents.push({
            id: `ref_pur_${pur.purchaseId || Math.random()}`,
            type: "REFERRAL_PURCHASE",
            title: `Qualifying Purchase Recorded`,
            description: `₦${Number(pur.amountNgn || 0).toLocaleString()} credited for referrer ${pur.referrerCode || pur.referrerUid}`,
            timestamp: pur.createdAt,
            user: pur.buyerEmail || pur.buyerUid || "Customer",
            meta: { amountNgn: pur.amountNgn, referrer: pur.referrerCode },
          });
        }
      }

      activityEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      let connectedWhatsApp = 0;
      let disconnectedWhatsApp = 0;
      for (const ws of (whatsappList || [])) {
        if (ws.status === "connected") connectedWhatsApp++;
        else disconnectedWhatsApp++;
      }

      const pendingPaymentsCount = (paymentRequests || []).filter((p) => p && p.status === "pending").length;

      response.json({
        success: true,
        overview: {
          totalUsers: customersList.length,
          activeLicenses: activeCount,
          expiringSoon: expiringSoonCount,
          expiredLicenses: expiredCount,
          lifetimeLicenses: lifetimeCount,
          unusedKeys: unusedCount,
          usedKeys: usedCount,
          totalRevenueNgn,
          connectedWhatsApp,
          disconnectedWhatsApp,
          pendingPayments: pendingPaymentsCount,
          totalReferrals: referralAudit?.summary?.totalReferredCustomers || 0,
          totalReferrers: referralAudit?.summary?.totalReferrers || 0,
          totalQualifyingSalesNgn: referralAudit?.summary?.totalQualifyingSalesNgn || 0,
          rewardsEarnedDays: referralAudit?.summary?.totalRewardsEarnedDays || 0,
          rewardsClaimedDays: referralAudit?.summary?.totalRewardsClaimedDays || 0,
          rewardsAvailableDays: referralAudit?.summary?.totalRewardsAvailableDays || 0,
        },
        licenses: enrichedLicenses,
        customers: customersList,
        payments: paymentRequests || [],
        paymentConfig: paymentConfig || {},
        referrals: referralAudit,
        whatsappSessions: whatsappList,
        recentActivity: activityEvents.slice(0, 50),
        systemHealth: {
          uptimeSeconds: Math.floor(process.uptime()),
          serverTime: new Date().toISOString(),
          nodeVersion: process.version,
          platform: process.platform,
          memory: process.memoryUsage(),
          status: "operational",
        },
        adminEmail: ADMIN_EMAIL,
      });
    } catch (error) {
      logger.error("Admin overview aggregate error", error.stack || error.message);
      response.status(500).json({ error: "Failed to generate admin overview data." });
    }
  });

  app.get(`${p}/admin/referrals`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const audit = await getAdminReferralAudit();
      response.json({
        success: true,
        ...audit,
      });
    } catch (error) {
      logger.error("Admin referral audit error", error.stack || error.message);
      response.status(500).json({ error: "Failed to list referral audit data." });
    }
  });

  app.get(`${p}/admin/licenses`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const licenses = await listAllLicenses(_request.headers.authorization || null);
      response.json({
        licenses,
        total: licenses.length,
        admin: ADMIN_EMAIL,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Admin list licenses error", error.stack || error.message);
      response.status(500).json({ error: "Failed to list licenses." });
    }
  });

  // Global Plans & Prices (Public & Authenticated)
  app.get(`${p}/plans`, async (_request, response) => {
    try {
      const plans = await getGlobalLicensePlans();
      response.json({ success: true, plans });
    } catch (err) {
      response.status(500).json({ error: "Failed to fetch license plans." });
    }
  });

  app.post(`${p}/admin/plans`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { plans } = request.body || {};
      const updated = await updateGlobalLicensePlans(plans);
      response.json({ success: true, plans: updated, message: "Global license plans updated in Supabase." });
    } catch (err) {
      response.status(400).json({ error: err.message || "Failed to update plans." });
    }
  });

  // Central Railway Backend URL Setting (Supabase system_config Source of Truth)
  app.get(`${p}/admin/backend-url`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const cfg = await getGlobalRailwayConfig();
      response.json({ success: true, railwayUrl: cfg.railwayUrl || "" });
    } catch (error) {
      response.status(500).json({ error: "Failed to get backend URL." });
    }
  });

  app.post(`${p}/admin/backend-url`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const url = String(request.body?.railwayUrl || request.body?.url || "").trim();
      const res = await setGlobalRailwayConfig(url);
      response.json({ success: true, railwayUrl: res.railwayUrl, message: "Railway backend URL successfully saved to Supabase system_config." });
    } catch (error) {
      response.status(500).json({ error: error.message || "Failed to update backend URL." });
    }
  });

  // Admin Safe Storage / Maintenance Diagnostics & Cleanup
  app.get(`${p}/admin/maintenance/diagnostics`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const diag = await getMaintenanceDiagnostics();
      response.json(diag);
    } catch (err) {
      response.status(500).json({ error: err.message || "Failed to fetch maintenance diagnostics." });
    }
  });

  app.post(`${p}/admin/maintenance/cleanup`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { action } = request.body || {};
      const res = await performSafeMaintenanceCleanup(action, request.headers.authorization || null);
      response.json(res);
    } catch (err) {
      response.status(400).json({ error: err.message || "Failed to run maintenance cleanup." });
    }
  });

  app.post(`${p}/admin/licenses/generate`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const days = request.body?.days;
      const isUnl = days === "Unlimited" || days === "unlimited" || String(days).toLowerCase() === "lifetime";
      if (!days || (!isUnl && (isNaN(Number(days)) || Number(days) <= 0))) {
        return response.status(400).json({ error: "Valid duration in days is required (1-365 or Unlimited)." });
      }

      const created = await createLicenseRecord(isUnl ? "Unlimited" : days, request.auth.email, request.headers.authorization);
      logger.info(`Admin generated new ${isUnl ? "Unlimited" : `${days}-day`} license: ${created.code}`);
      response.json({
        success: true,
        license: created,
        message: `Successfully generated ${isUnl ? "Unlimited Lifetime" : `${days}-day`} license code.`,
      });
    } catch (error) {
      logger.error("Admin generate license error", error.stack || error.message);
      response.status(400).json({ error: error.message || "Failed to generate license." });
    }
  });

  // Admin: List all registered users and their licenses
  app.get(`${p}/admin/users`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const users = await listAllUsersWithLicenses(_request.headers.authorization || null);
      response.json({ success: true, users, count: users.length });
    } catch (error) {
      logger.error("Admin list users error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to list users." });
    }
  });

  // Admin: Toggle Unlimited License for a specific user
  app.post(`${p}/admin/users/unlimited`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, isUnlimited } = request.body || {};
      if (!uid) {
        return response.status(400).json({ error: "User UID is required." });
      }
      const result = await toggleUserUnlimitedStatus(uid, isUnlimited, request.auth.email, request.headers.authorization);
      response.json({ success: true, ...result, message: `Unlimited status ${isUnlimited ? "activated" : "deactivated"} for user.` });
    } catch (error) {
      logger.error("Admin toggle unlimited error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to toggle unlimited status." });
    }
  });

  // Admin: Completely delete a user from customer / license lists
  app.post(`${p}/admin/users/delete`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid } = request.body || {};
      if (!uid) {
        return response.status(400).json({ error: "User UID is required." });
      }
      const result = await deleteUserFromSystem(uid, request.auth.email, request.headers.authorization);
      response.json({ success: true, ...result, message: "User completely removed from system." });
    } catch (error) {
      logger.error("Admin delete user error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to delete user." });
    }
  });

  // Admin: Manually Add User to Unlimited by Email
  app.post(`${p}/admin/users/unlimited-by-email`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { email } = request.body || {};
      if (!email) {
        return response.status(400).json({ error: "Email address is required." });
      }
      const result = await addUnlimitedUserByEmail(email, request.auth.email, request.headers.authorization);
      response.json({ success: true, ...result, message: `Unlimited access granted to ${email}.` });
    } catch (error) {
      logger.error("Admin manual add unlimited by email error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to add user to unlimited." });
    }
  });

  // Admin: Grant custom days to a user
  app.post(`${p}/admin/users/grant-days`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, days, email } = request.body || {};
      if (!uid || !days) {
        return response.status(400).json({ error: "User UID and days count are required." });
      }
      const result = await grantUserCustomDays(uid, days, email, request.headers.authorization);
      response.json({ success: true, ...result, message: `Successfully granted ${days} days to user.` });
    } catch (error) {
      logger.error("Admin grant days error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to grant days." });
    }
  });

  // Admin: Directly Overwrite User Record in Firestore / Local Store
  app.post(`${p}/admin/users/overwrite`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { uid, updates } = request.body || {};
      if (!uid) {
        return response.status(400).json({ error: "User UID is required." });
      }
      const result = await adminOverwriteUserRecord(uid, updates || {}, request.auth.email, request.headers.authorization);
      response.json({ success: true, ...result, message: "User record successfully updated in Firebase." });
    } catch (error) {
      logger.error("Admin overwrite user error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to overwrite user." });
    }
  });

  // Admin: Generate Key for a specific user and optionally redeem immediately
  app.post(`${p}/admin/licenses/generate-for-user`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { target, days, autoRedeem } = request.body || {};
      if (!target || !days) {
        return response.status(400).json({ error: "Target UID/Email and days are required." });
      }
      const result = await adminGenerateKeyForUser(target, days, Boolean(autoRedeem), request.auth.email, request.headers.authorization);
      response.json({ success: true, ...result, message: autoRedeem ? `Key generated and applied to ${target}.` : `Key generated for ${target}.` });
    } catch (error) {
      logger.error("Admin generate key for user error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to generate key for user." });
    }
  });

  // Admin: Recycling Bin - Delete single license key
  app.post(`${p}/admin/licenses/delete`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { code } = request.body || {};
      if (!code) {
        return response.status(400).json({ error: "License code is required." });
      }
      const result = await deleteLicenseKey(code, request.headers.authorization);
      response.json({ success: true, ...result, message: `License code ${code} deleted.` });
    } catch (error) {
      logger.error("Admin delete license error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to delete license." });
    }
  });

  // Admin: Recycling Bin - Purge expired or unused keys
  app.post(`${p}/admin/licenses/purge`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { filterType } = request.body || {};
      const result = await purgeExpiredOrUnusedKeys(filterType || "all", request.headers.authorization);
      response.json({ success: true, ...result, message: `Recycling bin purged ${result.count} keys successfully.` });
    } catch (error) {
      logger.error("Admin purge licenses error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to purge keys." });
    }
  });

  // System: Global Railway Backend URL (Public/Authenticated)
  app.get(`${p}/system/railway-config`, async (_request, response) => {
    try {
      const cfg = await getGlobalRailwayConfig();
      response.json({ success: true, ...cfg });
    } catch (error) {
      response.json({ success: true, railwayUrl: "" });
    }
  });

  app.post(`${p}/admin/railway-config`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { railwayUrl } = request.body || {};
      const result = await setGlobalRailwayConfig(railwayUrl, request.headers.authorization);
      response.json({ success: true, ...result, message: "Global Railway URL configured successfully for all users." });
    } catch (error) {
      response.status(500).json({ error: error.message || "Failed to update Railway configuration." });
    }
  });

  // Global License Plans (Supabase source of truth)
  app.get(`${p}/plans`, async (_request, response) => {
    try {
      const plans = await getGlobalLicensePlans();
      response.json({ success: true, plans });
    } catch (error) {
      response.status(500).json({ error: "Failed to retrieve plans." });
    }
  });

  app.post(`${p}/admin/plans`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const { plans } = request.body || {};
      if (!Array.isArray(plans) || plans.length === 0) {
        return response.status(400).json({ error: "Plans array is required." });
      }
      const updated = await updateGlobalLicensePlans(plans);
      response.json({ success: true, plans: updated, message: "Global license plans updated in Supabase." });
    } catch (error) {
      response.status(400).json({ error: error.message || "Failed to update global plans." });
    }
  });

  // --------------------------------------------------------------------------
  // CUSTOMER PAYMENT & LICENSE PURCHASE SYSTEM ROUTES
  // --------------------------------------------------------------------------
  app.get(`${p}/payments/config`, async (_request, response) => {
    try {
      const [plans, paymentConfig] = await Promise.all([
        getCustomerPaymentPlans(),
        getPaymentConfig(),
      ]);
      response.json({
        success: true,
        plans,
        paymentConfig,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to fetch payment config", error.stack || error.message);
      response.status(500).json({ error: "Failed to load payment plans and configuration." });
    }
  });

  app.get(`${p}/payments/my`, requireAuth, async (request, response) => {
    try {
      const [payments, paymentConfig, plans] = await Promise.all([
        listCustomerPayments(request.verifiedUid),
        getPaymentConfig(),
        getCustomerPaymentPlans(),
      ]);
      response.json({
        success: true,
        payments,
        paymentConfig,
        plans,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to fetch customer payments", error.stack || error.message);
      response.status(500).json({ error: "Failed to load your payment requests." });
    }
  });

  app.post(`${p}/payments/session`, requireAuth, async (request, response) => {
    try {
      const planId = request.body?.planId || request.body?.days;
      if (!planId) {
        return response.status(400).json({ error: "Please select a valid license plan." });
      }
      const result = await createCustomerPaymentSession({
        uid: request.verifiedUid,
        email: request.auth.email,
        planId,
      });
      response.json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.warn(`Create payment session error for user ${request.verifiedUid}: ${error.message}`);
      response.status(400).json({ error: error.message || "Could not create payment session." });
    }
  });

  app.get(`${p}/payments/status/:reference`, requireAuth, async (request, response) => {
    try {
      const ref = request.params.reference;
      const payment = await getPaymentByReference(ref);
      if (!payment) {
        return response.status(404).json({ error: "Payment session not found." });
      }
      const bareUid = String(request.verifiedUid || "").replace(/^user_/, "").trim();
      if (!isAdminEmail(request.auth.email) && payment.userUid !== bareUid) {
        return response.status(403).json({ error: "Forbidden." });
      }
      response.json({
        success: true,
        payment,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      response.status(500).json({ error: error.message || "Failed to fetch payment status." });
    }
  });

  app.post(`${p}/payments/cancel`, requireAuth, async (request, response) => {
    try {
      const ref = request.body?.paymentReference || request.body?.reference;
      const result = await cancelCustomerPaymentSession(ref, request.verifiedUid);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error.message || "Could not cancel payment session." });
    }
  });

  app.post(
    `${p}/payments/upload-receipt/:reference`,
    requireAuth,
    express.raw({
      type: ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/octet-stream"],
      limit: "6mb",
    }),
    async (request, response) => {
      try {
        const ref = request.params.reference;
        const fileBuffer = Buffer.isBuffer(request.body) ? request.body : null;
        const result = await submitPaymentReceipt({
          paymentReference: ref,
          uid: request.verifiedUid,
          email: request.auth.email,
          fileBuffer,
        });
        response.json(result);
      } catch (error) {
        logger.warn(`Receipt upload rejected for ${request.verifiedUid}: ${error.message}`);
        response.status(400).json({ error: error.message || "Receipt upload failed." });
      }
    }
  );

  app.get(`${p}/payments/receipt/:reference`, requireAuth, async (request, response) => {
    try {
      const ref = request.params.reference;
      const isAdm = isAdminEmail(request.auth.email);
      const { buffer, contentType } = await getPaymentReceiptBinary(ref, request.verifiedUid, isAdm);
      response.setHeader("Content-Type", contentType);
      response.setHeader("Cache-Control", "private, max-age=300");
      response.send(buffer);
    } catch (error) {
      const status = error.statusCode || 404;
      response.status(status).json({ error: error.message || "Receipt image not found." });
    }
  });

  // --------------------------------------------------------------------------
  // ADMIN PAYMENT VERIFICATION & CONFIGURATION ROUTES
  // --------------------------------------------------------------------------
  app.get(`${p}/admin/payments`, requireAuth, requireAdmin, async (_request, response) => {
    try {
      const [payments, paymentConfig, plans] = await Promise.all([
        listAllPaymentRequests(),
        getPaymentConfig(),
        getCustomerPaymentPlans(),
      ]);
      response.json({
        success: true,
        payments,
        paymentConfig,
        plans,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Admin list payments error", error.stack || error.message);
      response.status(500).json({ error: "Failed to load payment requests." });
    }
  });

  app.post(`${p}/admin/payments/config`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const updated = await updatePaymentConfig(request.body || {});
      response.json({
        success: true,
        paymentConfig: updated,
        message: "Payment configuration updated in Supabase system_config.",
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Failed to update payment configuration." });
    }
  });

  app.post(`${p}/admin/payments/approve`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const ref = request.body?.paymentReference || request.body?.reference;
      const result = await approvePaymentRequest(ref, request.auth.email, request.headers.authorization);

      // Auto-reconnect customer's saved WhatsApp session if present
      if (result.payment?.userUid) {
        const safeId = "user_" + String(result.payment.userUid).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
        const controller = getWhatsAppController(safeId, {
          verifiedUid: result.payment.userUid,
          userEmail: result.payment.userEmail,
        });
        if (controller.hasSavedSession() && !controller.isConnected()) {
          controller.start().catch(() => {});
        }
      }

      response.json(result);
    } catch (error) {
      logger.error("Admin approve payment error", error.stack || error.message);
      response.status(400).json({ error: error.message || "Failed to approve payment." });
    }
  });

  app.post(`${p}/admin/payments/reject`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const ref = request.body?.paymentReference || request.body?.reference;
      const reason = request.body?.reason || "";
      const result = await rejectPaymentRequest(ref, reason, request.auth.email);
      response.json(result);
    } catch (error) {
      logger.error("Admin reject payment error", error.stack || error.message);
      response.status(400).json({ error: error.message || "Failed to reject payment." });
    }
  });

  app.post(`${p}/admin/payments/delete`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const ref = request.body?.paymentReference || request.body?.reference;
      const result = await deletePaymentRequest(ref, request.auth.email);
      response.json({
        ...result,
        message: `Payment request ${ref} and receipt removed.`,
      });
    } catch (error) {
      response.status(400).json({ error: error.message || "Failed to delete payment request." });
    }
  });

  // --------------------------------------------------------------------------
  // WEB PUSH NOTIFICATION ROUTES (NATIVE CHROME / DESKTOP / MOBILE PWA)
  // --------------------------------------------------------------------------
  app.get(`${p}/push/vapid-public-key`, async (_request, response) => {
    try {
      const publicKey = await getVapidPublicKey();
      response.json({ success: true, publicKey });
    } catch (error) {
      logger.error("Failed to get VAPID public key", error.stack || error.message);
      response.status(500).json({ error: "Failed to load VAPID public key." });
    }
  });

  app.post(`${p}/push/subscribe`, requireAuth, async (request, response) => {
    try {
      const subscription = request.body?.subscription || request.body;
      if (!subscription || !subscription.endpoint) {
        return response.status(400).json({ error: "Invalid push subscription payload." });
      }
      const result = await savePushSubscription(subscription, request.auth.email, request.verifiedUid);
      response.json({ success: true, message: "Push notification subscription activated.", ...result });
    } catch (error) {
      logger.error("Push subscribe error", error.stack || error.message);
      response.status(400).json({ error: error.message || "Failed to save push subscription." });
    }
  });

  app.post(`${p}/push/unsubscribe`, requireAuth, async (request, response) => {
    try {
      const endpoint = request.body?.endpoint;
      if (endpoint) {
        await removePushSubscription(endpoint);
      }
      response.json({ success: true, message: "Push notification subscription removed." });
    } catch (error) {
      response.status(400).json({ error: error.message || "Failed to unsubscribe." });
    }
  });

  app.post(`${p}/push/test`, requireAuth, requireAdmin, async (request, response) => {
    try {
      const result = await sendAdminPushNotification({
        title: "🔔 SOLVATECH Test Alert",
        body: "Chrome Web Push is active and working! You will receive instant payment alerts here.",
        url: "/?tab=admin&view=payments",
      });
      response.json({ success: true, ...result, message: "Test push notification sent." });
    } catch (error) {
      logger.error("Push test error", error.stack || error.message);
      response.status(500).json({ error: error.message || "Failed to send test push notification." });
    }
  });
}

// Serve Service Worker at root for proper Service Worker Scope
app.get(["/sw.js", "/service-worker.js"], (_request, response) => {
  const swPath = path.join(rootDir, "sw.js");
  if (fs.existsSync(swPath)) {
    response.setHeader("Content-Type", "application/javascript");
    response.setHeader("Service-Worker-Allowed", "/");
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return response.sendFile(swPath);
  }
  response.status(404).send("Service Worker not found.");
});

app.use((request, response, next) => {
  const isApiRequest =
    request.path.startsWith("/bot-api") ||
    request.path.startsWith("/api") ||
    request.path.startsWith("/admin") ||
    request.path.startsWith("/payments") ||
    request.path.startsWith("/license") ||
    request.path.startsWith("/referral") ||
    request.path.startsWith("/user") ||
    request.path.startsWith("/auth") ||
    request.path === "/pair" ||
    request.path === "/status" ||
    request.path === "/disconnect" ||
    request.headers.accept?.includes("application/json") ||
    Boolean(request.headers.authorization);

  if (isApiRequest) {
    logger.warn(`API endpoint not found: ${request.method} ${request.originalUrl}`);
    return response.status(404).json({ error: `API endpoint not found: ${request.method} ${request.originalUrl}`, code: "ENDPOINT_NOT_FOUND" });
  }
  const rootIndexHtml = path.join(rootDir, "index.html");
  const htmlFile = fs.existsSync(rootIndexHtml) ? rootIndexHtml : path.join(publicDir, "index.html");

  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const proto = request.headers["x-forwarded-proto"] || (request.secure ? "https" : "https");

  if (host && fs.existsSync(htmlFile)) {
    try {
      const rawHtml = fs.readFileSync(htmlFile, "utf8");
      const currentOrigin = `${proto}://${host}`;
      const customizedHtml = rawHtml
        .replace(/https:\/\/solvatech\.name\.ng\/og-image\.png/g, `${currentOrigin}/og-image.png`)
        .replace(/https:\/\/solvatech\.name\.ng\/og-image\.jpg/g, `${currentOrigin}/og-image.jpg`)
        .replace(/https:\/\/solvatech\.name\.ng\//g, `${currentOrigin}/`);
      return response.type("html").send(customizedHtml);
    } catch {
      return response.sendFile(htmlFile);
    }
  }

  return response.sendFile(htmlFile);
});

app.use((error, _request, response, _next) => {
  logger.error("Unhandled web error", error.stack || error.message);
  response.status(500).json({ error: "Internal server error." });
});

const listenPort = Number(process.env.PORT) || 3000;

try {
  const s = app.listen(listenPort, "0.0.0.0", () => {
    logger.info(`SOLVATECH BOT web server listening on port ${listenPort} (0.0.0.0)`);
  });
  s.on("error", (err) => {
    logger.warn(`Port ${listenPort} note: ${err.message}`);
  });
} catch (err) {
  logger.warn(`Could not start server on port ${listenPort}: ${err.message}`);
}

// Cloud Hydration on Startup (Protects Railway restarts from wiping data)
syncAllLicensesFromCloud().then((res) => {
  logger.info(`[Cloud Hydration] Hydrated ${res?.totalLicenses || 0} license keys and ${res?.totalUsers || 0} user records from cloud storage.`);
}).catch((err) => {
  logger.debug("[Cloud Hydration] License hydration notice:", err.message);
});

syncAllPaymentsFromCloud().then((res) => {
  logger.info(`[Cloud Hydration] Hydrated ${res?.totalPayments || 0} payment requests from cloud storage.`);
}).catch((err) => {
  logger.debug("[Cloud Hydration] Payment hydration notice:", err.message);
});

// Background auto-restore & license audits
restoreAllSessions().catch((error) => {
  logger.warn("Auto-restore session error", error.message);
});

setInterval(() => {
  auditActiveSessions().catch((err) => {
    logger.debug("Background license audit notice", err.message);
  });
}, 30000).unref();