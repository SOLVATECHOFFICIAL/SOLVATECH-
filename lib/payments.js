import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { ADMIN_EMAIL } from "./auth.js";
import {
  isSupabaseConfigured,
  supabaseUpsert,
  supabaseGetById,
  supabaseGetAll,
  supabaseGetWhere,
  supabaseUpdate,
  supabaseDelete,
  ensureSupabaseStorageBucket,
  supabaseStorageUpload,
  supabaseStorageDownload,
  supabaseStorageDelete,
  supabaseStoragePublicUrl,
  supabaseStorageListFiles,
} from "./supabase.js";
import {
  getGlobalLicensePlans,
  createLicenseRecord,
  redeemLicenseCode,
} from "./license.js";

export const RECEIPT_BUCKET = "payment-receipts";
export const PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000; // 5 minutes before receipt submission
export const MAX_RECEIPT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export const DEFAULT_PAYMENT_CONFIG = {
  provider: "OPay",
  accountNumber: "9049979183",
  accountName: "SOLOMON OLADIMEJI",
  manualWhatsappNumber: "2349049979183",
};

export const OFFICIAL_CUSTOMER_PLANS = [
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

const LOCAL_PAYMENTS_FILE = path.join(DATA_DIR, "data", "solvatech-payment-requests.json");
const LOCAL_PAYMENT_CONFIG_FILE = path.join(DATA_DIR, "data", "solvatech-payment-config.json");
const LOCAL_RECEIPTS_DIR = path.join(DATA_DIR, "data", "receipts");

let inMemoryPayments = null;
let inMemoryPaymentConfig = null;
let paymentOperationQueue = Promise.resolve();

function withPaymentLock(fn) {
  const next = paymentOperationQueue.then(() => fn()).catch((err) => {
    logger.error("Payment atomic operation error:", err.stack || err.message);
    throw err;
  });
  paymentOperationQueue = next.then(() => {}).catch(() => {});
  return next;
}

async function loadLocalPayments() {
  if (!inMemoryPayments) {
    try {
      if (fsSync.existsSync(LOCAL_PAYMENTS_FILE)) {
        inMemoryPayments = JSON.parse(await fs.readFile(LOCAL_PAYMENTS_FILE, "utf8"));
      } else {
        inMemoryPayments = {};
      }
    } catch {
      inMemoryPayments = {};
    }
  }
  if (!inMemoryPaymentConfig) {
    try {
      if (fsSync.existsSync(LOCAL_PAYMENT_CONFIG_FILE)) {
        inMemoryPaymentConfig = JSON.parse(await fs.readFile(LOCAL_PAYMENT_CONFIG_FILE, "utf8"));
      }
    } catch {
      inMemoryPaymentConfig = null;
    }
  }
}

async function persistLocalPayments() {
  try {
    await fs.mkdir(path.dirname(LOCAL_PAYMENTS_FILE), { recursive: true });
    await fs.writeFile(LOCAL_PAYMENTS_FILE, JSON.stringify(inMemoryPayments || {}, null, 2));
    if (inMemoryPaymentConfig) {
      await fs.writeFile(LOCAL_PAYMENT_CONFIG_FILE, JSON.stringify(inMemoryPaymentConfig, null, 2));
    }
  } catch (err) {
    logger.warn("Failed to persist local payments store:", err.message);
  }
}

/**
 * Returns official customer-facing plans (Strictly excludes Unlimited).
 */
export async function getCustomerPaymentPlans() {
  try {
    const rawPlans = await getGlobalLicensePlans();
    if (Array.isArray(rawPlans) && rawPlans.length > 0) {
      const filtered = rawPlans
        .filter((p) => {
          if (!p) return false;
          const idStr = String(p.id || "").toLowerCase();
          const nameStr = String(p.name || "").toLowerCase();
          const daysVal = Number(p.days);
          if (
            p.isUnlimited ||
            idStr.includes("unlimited") ||
            idStr.includes("lifetime") ||
            nameStr.includes("unlimited") ||
            nameStr.includes("lifetime") ||
            isNaN(daysVal) ||
            daysVal <= 0 ||
            daysVal > 365
          ) {
            return false;
          }
          return true;
        })
        .map((p) => {
          const days = Number(p.days);
          const officialMatch = OFFICIAL_CUSTOMER_PLANS.find((o) => o.days === days);
          const priceNgn = Number(p.priceNgn ?? p.price ?? officialMatch?.priceNgn ?? 0);
          return {
            id: String(p.id || officialMatch?.id || `${days}d`),
            days,
            name: officialMatch?.name || String(p.name || `${days} Days`),
            priceNgn,
            price: priceNgn,
          };
        });

      if (filtered.length > 0) return filtered;
    }
  } catch (err) {
    logger.debug("getCustomerPaymentPlans fallback notice:", err.message);
  }
  return OFFICIAL_CUSTOMER_PLANS;
}

/**
 * Resolves a plan strictly from trusted server/Supabase configuration.
 * Never trusts client-supplied prices or durations.
 */
export async function resolveTrustedCustomerPlan(planIdOrDays) {
  if (!planIdOrDays) return null;
  const clean = String(planIdOrDays).trim().toLowerCase();
  if (clean === "unlimited" || clean === "lifetime") {
    return null;
  }

  const plans = await getCustomerPaymentPlans();
  const byId = plans.find((p) => String(p.id).toLowerCase() === clean);
  if (byId) return byId;

  const numDays = parseInt(clean, 10);
  if (!isNaN(numDays) && numDays > 0) {
    const byDays = plans.find((p) => Number(p.days) === numDays);
    if (byDays) return byDays;
  }
  return null;
}

/**
 * Loads or seeds the payment configuration in Supabase system_config (key: "payment_config").
 */
export async function getPaymentConfig() {
  await loadLocalPayments();

  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "payment_config", "key");
      if (row && row.value && typeof row.value === "object" && row.value.accountNumber) {
        inMemoryPaymentConfig = {
          provider: String(row.value.provider || DEFAULT_PAYMENT_CONFIG.provider).trim(),
          accountNumber: String(row.value.accountNumber || DEFAULT_PAYMENT_CONFIG.accountNumber).trim(),
          accountName: String(row.value.accountName || DEFAULT_PAYMENT_CONFIG.accountName).trim(),
          manualWhatsappNumber: String(row.value.manualWhatsappNumber || DEFAULT_PAYMENT_CONFIG.manualWhatsappNumber).replace(/\D+/g, ""),
          updatedAt: row.updated_at || new Date().toISOString(),
        };
        await persistLocalPayments();
        return inMemoryPaymentConfig;
      }

      // Seed Supabase system_config with default OPay details
      await supabaseUpsert(
        "system_config",
        {
          key: "payment_config",
          value: DEFAULT_PAYMENT_CONFIG,
          updated_at: new Date().toISOString(),
        },
        "key"
      );
    } catch (err) {
      logger.debug("Supabase payment_config fetch notice:", err.message);
    }
  }

  if (inMemoryPaymentConfig && inMemoryPaymentConfig.accountNumber) {
    return inMemoryPaymentConfig;
  }

  inMemoryPaymentConfig = {
    ...DEFAULT_PAYMENT_CONFIG,
    updatedAt: new Date().toISOString(),
  };
  return inMemoryPaymentConfig;
}

/**
 * Admin: Updates payment provider, account name, and account number in Supabase system_config.
 */
export async function updatePaymentConfig(updates = {}) {
  await loadLocalPayments();
  const current = await getPaymentConfig();

  const provider = String(updates.provider ?? current.provider ?? DEFAULT_PAYMENT_CONFIG.provider).trim();
  const accountNumber = String(updates.accountNumber ?? current.accountNumber ?? DEFAULT_PAYMENT_CONFIG.accountNumber).trim();
  const accountName = String(updates.accountName ?? current.accountName ?? DEFAULT_PAYMENT_CONFIG.accountName).trim();
  const manualWhatsappNumber = String(
    updates.manualWhatsappNumber ?? current.manualWhatsappNumber ?? DEFAULT_PAYMENT_CONFIG.manualWhatsappNumber
  ).replace(/\D+/g, "") || DEFAULT_PAYMENT_CONFIG.manualWhatsappNumber;

  if (!provider || !accountNumber || !accountName) {
    throw new Error("Payment provider, account number, and account name are all required.");
  }

  const nextConfig = {
    provider,
    accountNumber,
    accountName,
    manualWhatsappNumber,
    updatedAt: new Date().toISOString(),
  };

  inMemoryPaymentConfig = nextConfig;
  await persistLocalPayments();

  if (isSupabaseConfigured()) {
    await supabaseUpsert(
      "system_config",
      {
        key: "payment_config",
        value: {
          provider,
          accountNumber,
          accountName,
          manualWhatsappNumber,
        },
        updated_at: nextConfig.updatedAt,
      },
      "key"
    );
  }

  return nextConfig;
}

/**
 * Generates a short, readable, unique server-side payment reference (e.g. PAY-8F4K2).
 */
export function generatePaymentReference() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(5);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `PAY-${code}`;
}

/**
 * Maps a database row or local object to a normalized payment record.
 * Enforces the 5-minute session expiry rule ONLY before receipt submission.
 * Submitted PENDING payments NEVER auto-expire or auto-reject.
 */
function normalizePaymentRow(row) {
  if (!row) return null;
  const id = row.id || row.payment_reference || row.paymentReference;
  const paymentReference = row.payment_reference || row.paymentReference;
  const userUid = row.user_uid || row.userUid || "";
  const userEmail = row.user_email || row.userEmail || "";
  const planId = row.plan_id || row.planId || "";
  const planName = row.plan_name || row.planName || "";
  const durationDays = Number(row.duration_days ?? row.durationDays ?? 0);
  const amountNgn = Number(row.amount_ngn ?? row.amountNgn ?? 0);
  const paymentMethod = row.payment_method || row.paymentMethod || "automatic";
  const providerName = row.provider_name || row.providerName || DEFAULT_PAYMENT_CONFIG.provider;
  const accountNumber = row.account_number || row.accountNumber || DEFAULT_PAYMENT_CONFIG.accountNumber;
  const accountName = row.account_name || row.accountName || DEFAULT_PAYMENT_CONFIG.accountName;
  const receiptBucket = row.receipt_bucket || row.receiptBucket || RECEIPT_BUCKET;
  const receiptPath = row.receipt_path || row.receiptPath || null;
  const receiptMimeType = row.receipt_mime_type || row.receiptMimeType || null;
  const receiptSizeBytes = Number(row.receipt_size_bytes ?? row.receiptSizeBytes ?? 0) || null;
  let status = String(row.status || "awaiting_receipt").toLowerCase();
  const sessionExpiresAt = row.session_expires_at || row.sessionExpiresAt || null;
  const submittedAt = row.submitted_at || row.submittedAt || null;
  const reviewedAt = row.reviewed_at || row.reviewedAt || null;
  const reviewedBy = row.reviewed_by || row.reviewedBy || null;
  const rejectionReason = row.rejection_reason || row.rejectionReason || null;
  const licenseCode = row.license_code || row.licenseCode || null;
  const licenseExpiresAt = row.license_expires_at || row.licenseExpiresAt || null;
  const createdAt = row.created_at || row.createdAt || new Date().toISOString();
  const updatedAt = row.updated_at || row.updatedAt || createdAt;

  // 5-minute countdown applies ONLY to 'awaiting_receipt' before receipt submission
  if (status === "awaiting_receipt" && !receiptPath && sessionExpiresAt) {
    const expMs = new Date(sessionExpiresAt).getTime();
    if (Date.now() > expMs) {
      status = "expired";
    }
  }

  // If receipt was submitted and status is pending, it remains pending until admin review
  const sessionRemainingMs =
    status === "awaiting_receipt" && sessionExpiresAt
      ? Math.max(0, new Date(sessionExpiresAt).getTime() - Date.now())
      : 0;

  return {
    id,
    paymentReference,
    userUid,
    userEmail,
    planId,
    planName,
    durationDays,
    amountNgn,
    paymentMethod,
    providerName,
    accountNumber,
    accountName,
    receiptBucket,
    receiptPath,
    receiptUrl: receiptPath ? supabaseStoragePublicUrl(receiptBucket, receiptPath) : null,
    hasReceipt: Boolean(receiptPath),
    receiptMimeType,
    receiptSizeBytes,
    status,
    sessionExpiresAt,
    sessionRemainingMs,
    submittedAt,
    reviewedAt,
    reviewedBy,
    rejectionReason,
    licenseCode,
    licenseExpiresAt,
    createdAt,
    updatedAt,
  };
}

function toSupabaseRow(record) {
  return {
    ...(record.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
      ? { id: record.id }
      : {}),
    payment_reference: record.paymentReference,
    user_uid: record.userUid,
    user_email: record.userEmail || "",
    plan_id: record.planId,
    plan_name: record.planName,
    duration_days: Number(record.durationDays),
    amount_ngn: Number(record.amountNgn),
    payment_method: record.paymentMethod || "automatic",
    provider_name: record.providerName,
    account_number: record.accountNumber,
    account_name: record.accountName,
    receipt_bucket: record.receiptBucket || RECEIPT_BUCKET,
    receipt_path: record.receiptPath || null,
    receipt_mime_type: record.receiptMimeType || null,
    receipt_size_bytes: record.receiptSizeBytes || null,
    status: record.status,
    session_expires_at: record.sessionExpiresAt,
    submitted_at: record.submittedAt || null,
    reviewed_at: record.reviewedAt || null,
    reviewed_by: record.reviewedBy || null,
    rejection_reason: record.rejectionReason || null,
    license_code: record.licenseCode || null,
    license_expires_at: record.licenseExpiresAt || null,
    created_at: record.createdAt,
    updated_at: record.updatedAt || new Date().toISOString(),
  };
}

/**
 * Creates a new 5-minute automatic payment session for an authenticated customer.
 */
export async function createCustomerPaymentSession({ uid, email, planId }) {
  const bareUid = String(uid || "").replace(/^user_/, "").trim();
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!bareUid) {
    throw new Error("Authenticated user is required to start a payment session.");
  }

  const plan = await resolveTrustedCustomerPlan(planId);
  if (!plan) {
    throw new Error("Please select a valid official license plan.");
  }

  const paymentConfig = await getPaymentConfig();

  return withPaymentLock(async () => {
    await loadLocalPayments();

    // Generate unique server-side reference PAY-XXXXX
    let paymentReference = generatePaymentReference();
    for (let attempt = 0; attempt < 8; attempt++) {
      const existsInMem = Boolean(inMemoryPayments[paymentReference]);
      let existsInSb = false;
      if (isSupabaseConfigured()) {
        const existingRow = await supabaseGetById("payment_requests", paymentReference, "payment_reference");
        existsInSb = Boolean(existingRow);
      }
      if (!existsInMem && !existsInSb) break;
      paymentReference = generatePaymentReference();
    }

    // Block creating a new session if customer already has a PENDING payment awaiting verification
    if (isSupabaseConfigured()) {
      try {
        const userRows = await supabaseGetWhere("payment_requests", "user_uid", bareUid);
        const existingPending = userRows.find((r) => r && r.status === "pending");
        if (existingPending) {
          throw new Error(
            `You already have a payment (${existingPending.payment_reference}) pending admin verification. Please wait until it is approved or rejected.`
          );
        }
        for (const r of userRows) {
          if (r && r.status === "awaiting_receipt" && !r.receipt_path) {
            await supabaseUpdate("payment_requests", "payment_reference", r.payment_reference, {
              status: "cancelled",
              updated_at: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        if (String(err.message || "").includes("pending admin verification")) {
          throw err;
        }
      }
    }
    for (const rec of Object.values(inMemoryPayments || {})) {
      if (rec && rec.userUid === bareUid && rec.status === "pending") {
        throw new Error(
          `You already have a payment (${rec.paymentReference}) pending admin verification. Please wait until it is approved or rejected.`
        );
      }
      if (rec && rec.userUid === bareUid && rec.status === "awaiting_receipt" && !rec.receiptPath) {
        rec.status = "cancelled";
        rec.updatedAt = new Date().toISOString();
      }
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const sessionExpiresAt = new Date(now + PAYMENT_SESSION_DURATION_MS).toISOString();

    const record = {
      id: crypto.randomUUID(),
      paymentReference,
      userUid: bareUid,
      userEmail: cleanEmail,
      planId: plan.id,
      planName: plan.name,
      durationDays: Number(plan.days),
      amountNgn: Number(plan.priceNgn),
      paymentMethod: "automatic",
      providerName: paymentConfig.provider,
      accountNumber: paymentConfig.accountNumber,
      accountName: paymentConfig.accountName,
      receiptBucket: RECEIPT_BUCKET,
      receiptPath: null,
      receiptMimeType: null,
      receiptSizeBytes: null,
      status: "awaiting_receipt",
      sessionExpiresAt,
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
      licenseCode: null,
      licenseExpiresAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (isSupabaseConfigured()) {
      const sbRes = await supabaseUpsert("payment_requests", toSupabaseRow(record), "payment_reference");
      if (!sbRes.success) {
        logger.warn("Supabase payment_requests insert notice (falling back to local store):", sbRes.error);
      }
    }

    inMemoryPayments[paymentReference] = record;
    await persistLocalPayments();

    return {
      session: normalizePaymentRow(record),
      paymentConfig,
      serverTime: new Date().toISOString(),
    };
  });
}

/**
 * Validates binary image magic bytes (JPEG, PNG, WEBP)
 */
function detectValidImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mime: "image/png", ext: "png" };
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

/**
 * Fetches a single payment request by reference from Supabase or local fallback.
 */
export async function getPaymentByReference(paymentReference) {
  await loadLocalPayments();
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  if (!cleanRef) return null;

  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("payment_requests", cleanRef, "payment_reference");
      if (row) {
        const norm = normalizePaymentRow(row);
        inMemoryPayments[cleanRef] = norm;
        return norm;
      }
    } catch (err) {
      logger.debug("Supabase getPaymentByReference notice:", err.message);
    }
  }

  const local = inMemoryPayments[cleanRef];
  return local ? normalizePaymentRow(local) : null;
}

/**
 * Customer: Uploads payment receipt screenshot to Supabase Storage and marks payment as PENDING.
 * Once PENDING, the 5-minute session timer no longer applies.
 */
export async function submitPaymentReceipt({
  paymentReference,
  uid,
  email,
  fileBuffer,
}) {
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  const bareUid = String(uid || "").replace(/^user_/, "").trim();
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!cleanRef) {
    throw new Error("Payment reference is required.");
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error("Please select a valid payment receipt image to upload.");
  }
  if (fileBuffer.length > MAX_RECEIPT_SIZE_BYTES) {
    throw new Error("Receipt image is too large. Maximum allowed size is 5MB.");
  }

  const detected = detectValidImageMime(fileBuffer);
  if (!detected) {
    throw new Error("Invalid file type. Only PNG, JPG/JPEG, and WEBP screenshot images are allowed.");
  }

  return withPaymentLock(async () => {
    const existing = await getPaymentByReference(cleanRef);
    if (!existing) {
      throw new Error("Payment session not found. Please start a new payment request.");
    }

    if (existing.userUid !== bareUid) {
      throw new Error("You are not authorized to upload a receipt for this payment reference.");
    }

    if (existing.status === "approved") {
      throw new Error("This payment has already been approved and activated.");
    }

    if (existing.status === "rejected" || existing.status === "cancelled") {
      throw new Error(`This payment session is ${existing.status}. Please create a new payment session.`);
    }

    // Check 5-minute expiry ONLY if receipt has not been submitted yet
    if (existing.status === "expired" && !existing.receiptPath) {
      if (isSupabaseConfigured()) {
        await supabaseUpdate("payment_requests", "payment_reference", cleanRef, {
          status: "expired",
          updated_at: new Date().toISOString(),
        });
      }
      if (inMemoryPayments[cleanRef]) {
        inMemoryPayments[cleanRef].status = "expired";
        await persistLocalPayments();
      }
      throw new Error("This 5-minute payment session expired before receipt submission. Please start a new payment session.");
    }

    // Securely generate storage path server-side (never trust client paths)
    const safeUidSegment = bareUid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const safeRefSegment = cleanRef.replace(/[^A-Z0-9-]/g, "");
    const storagePath = `receipts/${safeUidSegment}/${safeRefSegment}-${Date.now()}.${detected.ext}`;

    // 1. Upload binary directly to Supabase Storage bucket 'payment-receipts'
    let uploadedToSupabase = false;
    if (isSupabaseConfigured()) {
      try {
        await ensureSupabaseStorageBucket(RECEIPT_BUCKET);
        await supabaseStorageUpload(RECEIPT_BUCKET, storagePath, fileBuffer, detected.mime);
        uploadedToSupabase = true;
      } catch (storageErr) {
        logger.warn("Supabase Storage upload notice (saving local backup):", storageErr.message);
      }
    }

    // 2. Also keep local filesystem binary backup (never Base64 in PostgreSQL)
    try {
      const localFilePath = path.join(LOCAL_RECEIPTS_DIR, storagePath);
      await fs.mkdir(path.dirname(localFilePath), { recursive: true });
      await fs.writeFile(localFilePath, fileBuffer);
    } catch (fsErr) {
      if (!uploadedToSupabase) {
        throw new Error("Could not store payment receipt file. Please try again.");
      }
    }

    const nowIso = new Date().toISOString();
    const updatedRecord = {
      ...existing,
      userEmail: cleanEmail || existing.userEmail,
      receiptBucket: RECEIPT_BUCKET,
      receiptPath: storagePath,
      receiptMimeType: detected.mime,
      receiptSizeBytes: fileBuffer.length,
      status: "pending",
      submittedAt: nowIso,
      updatedAt: nowIso,
    };

    if (isSupabaseConfigured()) {
      await supabaseUpsert("payment_requests", toSupabaseRow(updatedRecord), "payment_reference");
    }

    inMemoryPayments[cleanRef] = updatedRecord;
    await persistLocalPayments();

    logger.info(`Customer ${cleanEmail || bareUid} submitted receipt for ${cleanRef} (${existing.planName} - ₦${existing.amountNgn})`);

    return {
      success: true,
      payment: normalizePaymentRow(updatedRecord),
      message: "Receipt uploaded! Your payment is now PENDING admin verification.",
    };
  });
}

/**
 * Customer: Cancel an unsubmitted payment session so they can pick another plan.
 */
export async function cancelCustomerPaymentSession(paymentReference, uid) {
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  const bareUid = String(uid || "").replace(/^user_/, "").trim();

  return withPaymentLock(async () => {
    const existing = await getPaymentByReference(cleanRef);
    if (!existing || existing.userUid !== bareUid) {
      throw new Error("Payment session not found.");
    }
    if (existing.status !== "awaiting_receipt" && existing.status !== "expired") {
      throw new Error("Only unsubmitted payment sessions can be cancelled.");
    }

    const nowIso = new Date().toISOString();
    existing.status = "cancelled";
    existing.updatedAt = nowIso;

    if (isSupabaseConfigured()) {
      await supabaseUpdate("payment_requests", "payment_reference", cleanRef, {
        status: "cancelled",
        updated_at: nowIso,
      });
    }
    if (inMemoryPayments[cleanRef]) {
      inMemoryPayments[cleanRef].status = "cancelled";
      inMemoryPayments[cleanRef].updatedAt = nowIso;
      await persistLocalPayments();
    }

    return { success: true, payment: normalizePaymentRow(existing) };
  });
}

/**
 * Lists all payment requests for a specific customer (newest first).
 */
export async function listCustomerPayments(uid) {
  await loadLocalPayments();
  const bareUid = String(uid || "").replace(/^user_/, "").trim();
  if (!bareUid) return [];

  const map = new Map();

  if (isSupabaseConfigured()) {
    try {
      const rows = await supabaseGetWhere("payment_requests", "user_uid", bareUid, {
        orderBy: "created_at",
        ascending: false,
        limit: 25,
      });
      for (const r of rows) {
        const norm = normalizePaymentRow(r);
        if (norm && norm.paymentReference) {
          map.set(norm.paymentReference, norm);
          inMemoryPayments[norm.paymentReference] = norm;
        }
      }
    } catch (err) {
      logger.debug("Supabase listCustomerPayments notice:", err.message);
    }
  }

  for (const rec of Object.values(inMemoryPayments || {})) {
    if (rec && rec.userUid === bareUid) {
      const norm = normalizePaymentRow(rec);
      if (norm && !map.has(norm.paymentReference)) {
        map.set(norm.paymentReference, norm);
      }
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Admin: Lists all payment requests across all customers (newest first).
 */
export async function listAllPaymentRequests() {
  await loadLocalPayments();
  const map = new Map();

  if (isSupabaseConfigured()) {
    try {
      const rows = await supabaseGetAll("payment_requests", {
        orderBy: "created_at",
        ascending: false,
        limit: 500,
      });
      for (const r of rows) {
        const norm = normalizePaymentRow(r);
        if (norm && norm.paymentReference) {
          map.set(norm.paymentReference, norm);
          inMemoryPayments[norm.paymentReference] = norm;
        }
      }
    } catch (err) {
      logger.debug("Supabase listAllPaymentRequests notice:", err.message);
    }
  }

  for (const rec of Object.values(inMemoryPayments || {})) {
    const norm = normalizePaymentRow(rec);
    if (norm && norm.paymentReference && !map.has(norm.paymentReference)) {
      map.set(norm.paymentReference, norm);
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

/**
 * Admin: Approves a pending payment request, generates & activates the customer's license in Supabase.
 */
export async function approvePaymentRequest(paymentReference, adminEmail = ADMIN_EMAIL, authToken = null) {
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  if (!cleanRef) {
    throw new Error("Payment reference is required.");
  }

  return withPaymentLock(async () => {
    const existing = await getPaymentByReference(cleanRef);
    if (!existing) {
      throw new Error(`Payment request ${cleanRef} not found.`);
    }

    if (existing.status === "approved") {
      throw new Error(`Payment ${cleanRef} has already been approved (Key: ${existing.licenseCode || "Activated"}).`);
    }

    const durationDays = Number(existing.durationDays);
    if (isNaN(durationDays) || durationDays <= 0) {
      throw new Error("Invalid plan duration on payment record.");
    }

    // 1. Generate cryptographic license key and redeem/activate it immediately for the customer
    const generatedLicense = await createLicenseRecord(durationDays, adminEmail);
    const redemption = await redeemLicenseCode(
      generatedLicense.code,
      {
        uid: existing.userUid,
        email: existing.userEmail,
      },
      authToken
    );

    const nowIso = new Date().toISOString();
    const updatedRecord = {
      ...existing,
      status: "approved",
      reviewedAt: nowIso,
      reviewedBy: adminEmail,
      rejectionReason: null,
      licenseCode: generatedLicense.code,
      licenseExpiresAt: redemption.license?.expiresAt || null,
      updatedAt: nowIso,
    };

    if (isSupabaseConfigured()) {
      await supabaseUpsert("payment_requests", toSupabaseRow(updatedRecord), "payment_reference");
    }

    inMemoryPayments[cleanRef] = updatedRecord;
    await persistLocalPayments();

    logger.info(
      `Admin ${adminEmail} APPROVED payment ${cleanRef} for ${existing.userEmail || existing.userUid} (${existing.planName} - ₦${existing.amountNgn}) -> License ${generatedLicense.code}`
    );

    return {
      success: true,
      payment: normalizePaymentRow(updatedRecord),
      license: redemption.license,
      message: `Payment ${cleanRef} approved! ${existing.planName} license (${generatedLicense.code}) activated for ${existing.userEmail || existing.userUid}.`,
    };
  });
}

/**
 * Admin: Rejects a payment request with an optional reason.
 */
export async function rejectPaymentRequest(paymentReference, reason = "", adminEmail = ADMIN_EMAIL) {
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  if (!cleanRef) {
    throw new Error("Payment reference is required.");
  }

  return withPaymentLock(async () => {
    const existing = await getPaymentByReference(cleanRef);
    if (!existing) {
      throw new Error(`Payment request ${cleanRef} not found.`);
    }

    if (existing.status === "approved") {
      throw new Error("Cannot reject a payment that has already been approved.");
    }

    const nowIso = new Date().toISOString();
    const cleanReason = String(reason || "Payment receipt could not be verified.").trim();

    const updatedRecord = {
      ...existing,
      status: "rejected",
      reviewedAt: nowIso,
      reviewedBy: adminEmail,
      rejectionReason: cleanReason,
      updatedAt: nowIso,
    };

    if (isSupabaseConfigured()) {
      await supabaseUpsert("payment_requests", toSupabaseRow(updatedRecord), "payment_reference");
    }

    inMemoryPayments[cleanRef] = updatedRecord;
    await persistLocalPayments();

    logger.info(`Admin ${adminEmail} REJECTED payment ${cleanRef} for ${existing.userEmail || existing.userUid}: ${cleanReason}`);

    return {
      success: true,
      payment: normalizePaymentRow(updatedRecord),
      message: `Payment ${cleanRef} has been rejected.`,
    };
  });
}

/**
 * Retrieves the binary receipt image for a payment request (Authorized for Admin or Payment Owner).
 */
export async function getPaymentReceiptBinary(paymentReference, requesterUid, isRequesterAdmin = false) {
  const existing = await getPaymentByReference(paymentReference);
  if (!existing) {
    const err = new Error("Payment record not found.");
    err.statusCode = 404;
    throw err;
  }

  const bareRequester = String(requesterUid || "").replace(/^user_/, "").trim();
  if (!isRequesterAdmin && existing.userUid !== bareRequester) {
    const err = new Error("Forbidden: You may only view your own payment receipts.");
    err.statusCode = 403;
    throw err;
  }

  if (!existing.receiptPath) {
    const err = new Error("No receipt has been uploaded for this payment session.");
    err.statusCode = 404;
    throw err;
  }

  // 1. Try Supabase Storage first
  if (isSupabaseConfigured()) {
    const downloaded = await supabaseStorageDownload(
      existing.receiptBucket || RECEIPT_BUCKET,
      existing.receiptPath
    );
    if (downloaded && downloaded.buffer) {
      return {
        buffer: downloaded.buffer,
        contentType: existing.receiptMimeType || downloaded.contentType || "image/jpeg",
      };
    }
  }

  // 2. Fallback to local disk receipt binary
  const localFilePath = path.join(LOCAL_RECEIPTS_DIR, existing.receiptPath);
  if (fsSync.existsSync(localFilePath)) {
    const buf = await fs.readFile(localFilePath);
    return {
      buffer: buf,
      contentType: existing.receiptMimeType || "image/jpeg",
    };
  }

  const err = new Error("Receipt image file is no longer available in storage.");
  err.statusCode = 404;
  throw err;
}

/**
 * Admin: Deletes a payment request record (and its receipt from Supabase Storage if present).
 */
export async function deletePaymentRequest(paymentReference, adminEmail = ADMIN_EMAIL) {
  const cleanRef = String(paymentReference || "").trim().toUpperCase();
  return withPaymentLock(async () => {
    const existing = await getPaymentByReference(cleanRef);
    if (existing && existing.receiptPath) {
      if (isSupabaseConfigured()) {
        await supabaseStorageDelete(existing.receiptBucket || RECEIPT_BUCKET, existing.receiptPath).catch(() => {});
      }
      try {
        const localFilePath = path.join(LOCAL_RECEIPTS_DIR, existing.receiptPath);
        if (fsSync.existsSync(localFilePath)) {
          await fs.unlink(localFilePath);
        }
      } catch {}
    }

    if (isSupabaseConfigured()) {
      await supabaseDelete("payment_requests", "payment_reference", cleanRef);
    }

    if (inMemoryPayments) {
      delete inMemoryPayments[cleanRef];
      await persistLocalPayments();
    }

    logger.info(`Admin ${adminEmail} deleted payment request ${cleanRef}`);
    return { success: true, paymentReference: cleanRef };
  });
}

/**
 * Returns live storage metrics for payment receipts and payment request rows.
 */
export async function getPaymentStorageMetrics() {
  const allPayments = await listAllPaymentRequests();
  let bucketFiles = [];
  if (isSupabaseConfigured()) {
    bucketFiles = await supabaseStorageListFiles(RECEIPT_BUCKET).catch(() => []);
  }

  const pendingPaths = new Set();
  let pendingReceiptCount = 0;
  let pendingReceiptBytes = 0;
  let clearableReceiptCount = 0;
  let clearableReceiptBytes = 0;
  let rejectedExpiredPaymentsCount = 0;
  let rejectedExpiredPaymentsBytes = 0;

  const countedPaths = new Set();

  for (const p of allPayments) {
    if (!p) continue;
    const rowJsonBytes = Buffer.byteLength(JSON.stringify(p), "utf8");
    const sizeBytes = Number(p.receiptSizeBytes || 0);

    if (p.status === "pending" && p.receiptPath) {
      pendingPaths.add(p.receiptPath);
      countedPaths.add(p.receiptPath);
      pendingReceiptCount++;
      pendingReceiptBytes += sizeBytes || 150000;
    } else if (p.receiptPath) {
      countedPaths.add(p.receiptPath);
      clearableReceiptCount++;
      clearableReceiptBytes += sizeBytes || 150000;
    }

    if (p.status === "rejected" || p.status === "expired" || p.status === "cancelled") {
      rejectedExpiredPaymentsCount++;
      rejectedExpiredPaymentsBytes += rowJsonBytes;
    }
  }

  // Also include any orphaned files in the bucket not attached to a pending payment
  for (const f of bucketFiles) {
    if (!f || !f.path) continue;
    if (pendingPaths.has(f.path)) continue;
    if (!countedPaths.has(f.path)) {
      clearableReceiptCount++;
      clearableReceiptBytes += Number(f.sizeBytes || 120000);
    }
  }

  return {
    totalPayments: allPayments.length,
    pendingReceiptCount,
    pendingReceiptBytes,
    clearableReceiptCount,
    clearableReceiptBytes,
    rejectedExpiredPaymentsCount,
    rejectedExpiredPaymentsBytes,
    totalReceiptBytes: pendingReceiptBytes + clearableReceiptBytes,
  };
}

/**
 * Admin Safe Storage Cleanup: Clears uploaded receipt images for already-reviewed (approved/rejected/expired/cancelled)
 * payments and orphaned bucket files. Never touches PENDING payment receipts or active user licenses!
 */
export async function clearProcessedReceiptImages(adminEmail = ADMIN_EMAIL) {
  return withPaymentLock(async () => {
    const allPayments = await listAllPaymentRequests();
    const pendingPaths = new Set();
    let clearedCount = 0;
    let bytesFreed = 0;

    for (const p of allPayments) {
      if (!p) continue;
      if (p.status === "pending" && p.receiptPath) {
        pendingPaths.add(p.receiptPath);
        continue;
      }
      if (p.receiptPath) {
        const size = Number(p.receiptSizeBytes || 150000);
        if (isSupabaseConfigured()) {
          await supabaseStorageDelete(p.receiptBucket || RECEIPT_BUCKET, p.receiptPath).catch(() => {});
          await supabaseUpdate("payment_requests", "payment_reference", p.paymentReference, {
            receipt_path: null,
            receipt_size_bytes: 0,
            updated_at: new Date().toISOString(),
          }).catch(() => {});
        }
        try {
          const localFilePath = path.join(LOCAL_RECEIPTS_DIR, p.receiptPath);
          if (fsSync.existsSync(localFilePath)) {
            await fs.unlink(localFilePath);
          }
        } catch {}

        if (inMemoryPayments && inMemoryPayments[p.paymentReference]) {
          inMemoryPayments[p.paymentReference].receiptPath = null;
          inMemoryPayments[p.paymentReference].receiptSizeBytes = 0;
          inMemoryPayments[p.paymentReference].hasReceipt = false;
          inMemoryPayments[p.paymentReference].receiptUrl = null;
        }
        clearedCount++;
        bytesFreed += size;
      }
    }

    // Also delete any orphaned files in the Supabase Storage bucket that aren't tied to a pending payment
    if (isSupabaseConfigured()) {
      const bucketFiles = await supabaseStorageListFiles(RECEIPT_BUCKET).catch(() => []);
      for (const f of bucketFiles) {
        if (f && f.path && !pendingPaths.has(f.path)) {
          await supabaseStorageDelete(RECEIPT_BUCKET, f.path).catch(() => {});
          clearedCount++;
          bytesFreed += Number(f.sizeBytes || 120000);
        }
      }
    }

    await persistLocalPayments();
    logger.info(`Admin ${adminEmail} cleared ${clearedCount} processed receipt images (${bytesFreed} bytes freed)`);
    return {
      success: true,
      count: clearedCount,
      bytesFreed,
      message: `Cleared ${clearedCount} processed receipt picture(s) (${(bytesFreed / 1024).toFixed(1)} KB freed). Pending receipts and active licenses are 100% preserved.`,
    };
  });
}

/**
 * Admin Safe Storage Cleanup: Purges rejected, expired, and cancelled payment request records (and their receipts).
 * Strictly preserves all PENDING and APPROVED payment records and customer licenses.
 */
export async function purgeRejectedAndExpiredPayments(adminEmail = ADMIN_EMAIL) {
  return withPaymentLock(async () => {
    const allPayments = await listAllPaymentRequests();
    let deletedCount = 0;
    let bytesFreed = 0;

    for (const p of allPayments) {
      if (!p) continue;
      if (p.status === "rejected" || p.status === "expired" || p.status === "cancelled") {
        const rowSize = Buffer.byteLength(JSON.stringify(p), "utf8") + Number(p.receiptSizeBytes || 0);
        if (p.receiptPath) {
          if (isSupabaseConfigured()) {
            await supabaseStorageDelete(p.receiptBucket || RECEIPT_BUCKET, p.receiptPath).catch(() => {});
          }
          try {
            const localFilePath = path.join(LOCAL_RECEIPTS_DIR, p.receiptPath);
            if (fsSync.existsSync(localFilePath)) {
              await fs.unlink(localFilePath);
            }
          } catch {}
        }
        if (isSupabaseConfigured()) {
          await supabaseDelete("payment_requests", "payment_reference", p.paymentReference).catch(() => {});
        }
        if (inMemoryPayments) {
          delete inMemoryPayments[p.paymentReference];
        }
        deletedCount++;
        bytesFreed += rowSize;
      }
    }

    await persistLocalPayments();
    logger.info(`Admin ${adminEmail} purged ${deletedCount} rejected/expired payment requests (${bytesFreed} bytes freed)`);
    return {
      success: true,
      count: deletedCount,
      bytesFreed,
      message: `Purged ${deletedCount} rejected/expired payment session(s) (${(bytesFreed / 1024).toFixed(1)} KB freed). Pending & Approved payments are preserved.`,
    };
  });
}

