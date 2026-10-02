import webpush from "web-push";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";
import { isSupabaseConfigured, supabaseGetById, supabaseUpsert, supabaseDelete } from "./supabase.js";
import { ADMIN_EMAIL } from "./auth.js";
import {
  firestoreUpsert,
  firestoreGetById,
  firestoreGetAll,
  firestoreDelete,
} from "./firestore-sync.js";

const VAPID_FILE = path.join(DATA_DIR, "data", "solvatech-vapid-keys.json");
const SUBS_FILE = path.join(DATA_DIR, "data", "solvatech-push-subscriptions.json");

let vapidKeys = null;
let pushSubscriptions = new Map(); // endpoint -> subscriptionObject

/**
 * Initializes or retrieves permanent VAPID keys.
 */
export async function getVapidKeys() {
  if (vapidKeys && vapidKeys.publicKey && vapidKeys.privateKey) {
    return vapidKeys;
  }

  // 1. Check environment variables
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
    };
    webpush.setVapidDetails(
      `mailto:${ADMIN_EMAIL || "solvatechofficial@gmail.com"}`,
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    return vapidKeys;
  }

  // 2. Check Firestore system_config
  try {
    const fsRow = await firestoreGetById("system_config", "vapid_keys");
    if (fsRow && fsRow.publicKey && fsRow.privateKey) {
      vapidKeys = {
        publicKey: String(fsRow.publicKey).trim(),
        privateKey: String(fsRow.privateKey).trim(),
      };
      webpush.setVapidDetails(
        `mailto:${ADMIN_EMAIL || "solvatechofficial@gmail.com"}`,
        vapidKeys.publicKey,
        vapidKeys.privateKey
      );
      return vapidKeys;
    }
  } catch {}

  // 3. Check Supabase system_config
  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "vapid_keys", "key");
      if (row && row.value && row.value.publicKey && row.value.privateKey) {
        vapidKeys = {
          publicKey: String(row.value.publicKey).trim(),
          privateKey: String(row.value.privateKey).trim(),
        };
        webpush.setVapidDetails(
          `mailto:${ADMIN_EMAIL || "solvatechofficial@gmail.com"}`,
          vapidKeys.publicKey,
          vapidKeys.privateKey
        );
        return vapidKeys;
      }
    } catch {}
  }

  // 4. Check local disk
  try {
    if (fsSync.existsSync(VAPID_FILE)) {
      const raw = await fs.readFile(VAPID_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.publicKey && parsed.privateKey) {
        vapidKeys = parsed;
        webpush.setVapidDetails(
          `mailto:${ADMIN_EMAIL || "solvatechofficial@gmail.com"}`,
          vapidKeys.publicKey,
          vapidKeys.privateKey
        );
        return vapidKeys;
      }
    }
  } catch {}

  // 5. Generate fresh permanent VAPID keys
  const generated = webpush.generateVAPIDKeys();
  vapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };

  try {
    await fs.mkdir(path.dirname(VAPID_FILE), { recursive: true });
    await fs.writeFile(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  } catch {}

  // Sync to Firestore
  try {
    await firestoreUpsert("system_config", "vapid_keys", {
      key: "vapid_keys",
      publicKey: vapidKeys.publicKey,
      privateKey: vapidKeys.privateKey,
      updatedAt: new Date().toISOString(),
    });
  } catch {}

  // Sync to Supabase
  if (isSupabaseConfigured()) {
    try {
      await supabaseUpsert("system_config", {
        key: "vapid_keys",
        value: vapidKeys,
        updated_at: new Date().toISOString(),
      }, "key");
    } catch {}
  }

  webpush.setVapidDetails(
    `mailto:${ADMIN_EMAIL || "solvatechofficial@gmail.com"}`,
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  return vapidKeys;
}

export async function getVapidPublicKey() {
  const keys = await getVapidKeys();
  return keys.publicKey;
}

async function loadSubscriptions() {
  // 1. Read local disk
  try {
    if (fsSync.existsSync(SUBS_FILE)) {
      const raw = await fs.readFile(SUBS_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const sub of arr) {
          if (sub && sub.endpoint) pushSubscriptions.set(sub.endpoint, sub);
        }
      }
    }
  } catch {}

  // 2. Read from Firestore
  try {
    const fsSubs = await firestoreGetAll("web_push_subscriptions");
    if (Array.isArray(fsSubs)) {
      for (const sub of fsSubs) {
        if (sub && sub.endpoint) pushSubscriptions.set(sub.endpoint, sub);
      }
    }
  } catch {}

  // 3. Read from Supabase
  if (isSupabaseConfigured()) {
    try {
      const row = await supabaseGetById("system_config", "push_subscriptions", "key");
      if (row && Array.isArray(row.value)) {
        for (const sub of row.value) {
          if (sub && sub.endpoint) pushSubscriptions.set(sub.endpoint, sub);
        }
      }
    } catch {}
  }
}
loadSubscriptions().catch(() => {});

async function persistSubscriptions() {
  const list = Array.from(pushSubscriptions.values());
  try {
    await fs.mkdir(path.dirname(SUBS_FILE), { recursive: true });
    await fs.writeFile(SUBS_FILE, JSON.stringify(list, null, 2));
  } catch {}

  // 1. Sync to Firestore
  try {
    for (const sub of list) {
      if (sub && sub.endpoint) {
        const docId = Buffer.from(sub.endpoint).toString("base64url").slice(0, 100);
        await firestoreUpsert("web_push_subscriptions", docId, sub);
      }
    }
  } catch {}

  // 2. Sync to Supabase
  if (isSupabaseConfigured()) {
    try {
      await supabaseUpsert("system_config", {
        key: "push_subscriptions",
        value: list,
        updated_at: new Date().toISOString(),
      }, "key");
    } catch {}
  }
}

export async function savePushSubscription(sub, userEmail = "", userUid = "") {
  if (!sub || !sub.endpoint) throw new Error("Invalid subscription object.");
  await loadSubscriptions();

  const record = {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime || null,
    keys: sub.keys || {},
    userEmail: String(userEmail || "").trim().toLowerCase(),
    userUid: String(userUid || "").trim(),
    userAgent: sub.userAgent || "",
    subscribedAt: new Date().toISOString(),
  };

  pushSubscriptions.set(sub.endpoint, record);
  await persistSubscriptions();
  logger.info(`Web Push subscription saved for ${userEmail || "admin"} (${pushSubscriptions.size} active device(s))`);
  return { success: true, count: pushSubscriptions.size };
}

export async function removePushSubscription(endpoint) {
  if (!endpoint) return;
  await loadSubscriptions();
  if (pushSubscriptions.has(endpoint)) {
    pushSubscriptions.delete(endpoint);
    await persistSubscriptions();
  }
}

export async function sendAdminPushNotification({
  title = "💰 SOLVATECH Payment Alert",
  body = "New payment receipt submitted. Tap to review.",
  icon = "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp",
  url = "/?tab=admin&view=payments",
  data = {},
}) {
  await getVapidKeys();
  await loadSubscriptions();

  if (pushSubscriptions.size === 0) {
    logger.debug?.("No active Web Push subscribers to notify.");
    return { success: false, sent: 0, reason: "No subscribers" };
  }

  const payload = JSON.stringify({
    title,
    body,
    icon,
    badge: "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp",
    data: {
      url: url || "/?tab=admin&view=payments",
      timestamp: Date.now(),
      ...data,
    },
  });

  const pushOptions = {
    TTL: 86400, // 24 hours
    urgency: "high",
  };

  let sentCount = 0;
  const deadEndpoints = [];

  const sendPromises = Array.from(pushSubscriptions.values()).map(async (sub) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        payload,
        pushOptions
      );
      sentCount++;
    } catch (err) {
      const statusCode = err.statusCode || err.code;
      if (statusCode === 410 || statusCode === 404 || statusCode === 403) {
        // Subscription is expired or unregistered by browser
        deadEndpoints.push(sub.endpoint);
      } else {
        logger.warn(`Web Push dispatch warning to ${sub.endpoint.slice(0, 40)}:`, err.message);
      }
    }
  });

  await Promise.all(sendPromises);

  if (deadEndpoints.length > 0) {
    for (const ep of deadEndpoints) {
      pushSubscriptions.delete(ep);
    }
    await persistSubscriptions();
  }

  logger.info(`Web Push notification delivered to ${sentCount}/${pushSubscriptions.size + deadEndpoints.length} devices: "${title}"`);
  return { success: true, sent: sentCount, total: pushSubscriptions.size };
}
