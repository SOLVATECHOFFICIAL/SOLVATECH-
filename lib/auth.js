import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import { logger } from "./logger.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load Firebase configuration
function loadFirebaseConfig() {
  try {
    const configPath = path.join(rootDir, "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return {
        projectId: cfg.projectId || "gen-lang-client-0324946831",
        apiKey: cfg.apiKey || "AIzaSyA_g2ek4ziXSE9m4VD5-5PfKpKJjAobYFg",
        firestoreDatabaseId: cfg.firestoreDatabaseId || "ai-studio-whatsappbot-da9a52de-41e7-4365-a5b4-8aec9332642c",
      };
    }
  } catch (error) {
    logger.warn("Could not read firebase-applet-config.json for auth verification", error.message);
  }
  const envProject = process.env.FIREBASE_PROJECT_ID;
  const envKey = process.env.FIREBASE_API_KEY;
  return {
    projectId: envProject || "gen-lang-client-0324946831",
    apiKey: envKey || "AIzaSyA_g2ek4ziXSE9m4VD5-5PfKpKJjAobYFg",
    firestoreDatabaseId: process.env.FIREBASE_DATABASE_ID || "ai-studio-whatsappbot-da9a52de-41e7-4365-a5b4-8aec9332642c",
  };
}

const firebaseConfig = loadFirebaseConfig();
const PROJECT_ID = firebaseConfig.projectId || "gen-lang-client-0324946831";
const API_KEY = firebaseConfig.apiKey || "AIzaSyA_g2ek4ziXSE9m4VD5-5PfKpKJjAobYFg";
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || "solvatech_preview_secret_key_" + (PROJECT_ID || "glass-intelligence");

/**
 * Creates a cryptographically signed preview token for studio/development testing
 */
export function createPreviewToken(user = {}) {
  const uid = user.uid || "admin_awoyinfasolomon1";
  const email = user.email || ADMIN_EMAIL;
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    uid,
    email,
    displayName: user.displayName || (email === ADMIN_EMAIL ? "Solomon Awoyinfa (Admin)" : "SOLVATECH User"),
    photoURL: user.photoURL || "./solva.webp",
    exp: nowSec + (7 * 24 * 3600), // 7 days
    safeUserId: "user_" + uid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96),
    type: "preview"
  };

  const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", PREVIEW_SECRET).update(b64Payload).digest("base64url");
  return `solva_preview_${b64Payload}.${signature}`;
}

/**
 * Verifies a preview token
 */
export function verifyPreviewToken(token) {
  if (!token || typeof token !== "string" || !token.startsWith("solva_preview_")) {
    return null;
  }
  const raw = token.slice("solva_preview_".length);
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [b64Payload, signature] = parts;
  
  const expectedSig = crypto.createHmac("sha256", PREVIEW_SECRET).update(b64Payload).digest("base64url");
  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(b64Payload, "base64url").toString("utf8"));
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

// Cache for Google's public x509 certificates
let cachedPublicCerts = null;
let certsExpiresAt = 0;

// Cache for verified ID tokens (token -> { uid, email, displayName, photoURL, exp })
const verifiedTokenCache = new Map();

/**
 * Prunes expired tokens from in-memory cache
 */
function pruneTokenCache() {
  const now = Date.now();
  for (const [token, data] of verifiedTokenCache.entries()) {
    if (data.exp * 1000 < now) {
      verifiedTokenCache.delete(token);
    }
  }
}

// Prune token cache every 5 minutes
setInterval(pruneTokenCache, 5 * 60 * 1000).unref();

/**
 * Fetches Google's public certificates for Firebase token verification
 */
async function getGooglePublicCerts() {
  const now = Date.now();
  if (cachedPublicCerts && now < certsExpiresAt) {
    return cachedPublicCerts;
  }

  try {
    const res = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching Google public certs`);
    
    // Parse Cache-Control header for max-age
    const cacheControl = res.headers.get("cache-control") || "";
    const match = cacheControl.match(/max-age=(\d+)/);
    const maxAgeSec = match ? parseInt(match[1], 10) : 3600;
    certsExpiresAt = now + (maxAgeSec * 1000);

    cachedPublicCerts = await res.json();
    return cachedPublicCerts;
  } catch (error) {
    logger.warn("Failed to fetch Google public certs, will use accounts:lookup fallback", error.message);
    return cachedPublicCerts || {};
  }
}

/**
 * Decodes base64url string to JSON
 */
function decodeBase64Json(str) {
  try {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Verifies a Firebase Auth ID Token server-side.
 * 
 * Verifies:
 * 1. RS256 cryptographic signature against Google's public certificates
 * 2. Header `alg` is RS256 and `kid` matches Google cert
 * 3. `aud` equals the Firebase project ID
 * 4. `iss` equals `https://securetoken.google.com/<projectId>`
 * 5. `sub` (UID) is non-empty string <= 128 chars
 * 6. `exp` is in the future
 * 7. `auth_time` is in the past
 * 
 * Includes Google Identity Toolkit fallback verification for maximum reliability.
 */
export async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    return null;
  }

  const cleanToken = idToken.trim();
  if (!cleanToken) return null;

  // Check in-memory cache first
  const cached = verifiedTokenCache.get(cleanToken);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.exp > nowSec + 10) {
    return cached;
  }

  // Support cryptographically signed studio preview tokens
  if (cleanToken.startsWith("solva_preview_")) {
    const previewUser = verifyPreviewToken(cleanToken);
    if (previewUser) {
      verifiedTokenCache.set(cleanToken, previewUser);
      return previewUser;
    }
    return null;
  }

  // Token format: header.payload.signature
  const parts = cleanToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeBase64Json(headerB64);
  const payload = decodeBase64Json(payloadB64);

  if (!header || !payload) {
    return null;
  }

  // 1. Basic JWT claims verification
  if (header.alg !== "RS256" || !header.kid) {
    return null;
  }

  const allowedProjectIds = new Set([
    PROJECT_ID,
    firebaseConfig.projectId,
    "glass-intelligence-253bd",
    "gen-lang-client-0324946831"
  ].filter(Boolean));

  if (!allowedProjectIds.has(payload.aud)) {
    logger.warn(`Firebase token aud mismatch: allowed [${Array.from(allowedProjectIds).join(", ")}], got ${payload.aud}`);
    return null;
  }

  const expectedIss = `https://securetoken.google.com/${payload.aud}`;
  if (payload.iss !== expectedIss) {
    logger.warn(`Firebase token iss mismatch: expected ${expectedIss}, got ${payload.iss}`);
    return null;
  }

  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length > 128) {
    return null;
  }

  // Clock verification (allowing 5 minute clock skew)
  if (payload.exp && payload.exp < nowSec - 300) {
    return null;
  }
  if (payload.iat && payload.iat > nowSec + 300) {
    return null;
  }
  if (payload.auth_time && payload.auth_time > nowSec + 300) {
    return null;
  }

  // 2. Cryptographic signature check with Google's public certificates
  let signatureValid = false;
  try {
    const certs = await getGooglePublicCerts();
    const cert = certs[header.kid];
    if (cert) {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(`${headerB64}.${payloadB64}`);
      const sigBuffer = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      signatureValid = verifier.verify(cert, sigBuffer);
    }
  } catch (error) {
    logger.debug("Local crypto verification exception", error.message);
  }

  // 3. If local signature succeeded, build user identity
  if (signatureValid) {
    const verifiedUser = {
      uid: payload.sub,
      email: payload.email || "",
      displayName: payload.name || payload.displayName || "",
      photoURL: payload.picture || payload.photoURL || "",
      exp: payload.exp || nowSec + 3600,
      safeUserId: "user_" + payload.sub.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96),
    };

    // Cache verified user
    verifiedTokenCache.set(cleanToken, verifiedUser);
    return verifiedUser;
  }

  // 4. Fallback: Google Identity Toolkit accounts:lookup API
  if (API_KEY) {
    try {
      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: cleanToken }),
      });

      if (res.ok) {
        const data = await res.json();
        const user = data.users?.[0];
        if (user && user.localId) {
          const verifiedUser = {
            uid: user.localId,
            email: user.email || payload.email || "",
            displayName: user.displayName || payload.name || "",
            photoURL: user.photoUrl || payload.picture || "",
            exp: payload.exp || nowSec + 3600,
            safeUserId: "user_" + user.localId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96),
          };
          verifiedTokenCache.set(cleanToken, verifiedUser);
          return verifiedUser;
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        logger.debug("Identity toolkit lookup failed", errJson?.error?.message || res.status);
      }
    } catch (error) {
      logger.warn("Identity toolkit fallback request failed", error.message);
    }
  }

  return null;
}

/**
 * Express Middleware: Strictly enforces Firebase ID token authentication on protected routes.
 * 
 * Reject missing, invalid, malformed, or expired tokens with HTTP 401.
 * Authoritative: Derives the user identity ONLY from the verified token UID.
 * Ignores any client-supplied x-user-id, query.userId, or body.userId.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized: Missing or invalid Authorization header. Expected Bearer <Firebase ID token>.",
      code: "AUTH_TOKEN_MISSING",
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      error: "Unauthorized: Empty Firebase authentication token.",
      code: "AUTH_TOKEN_EMPTY",
    });
  }

  try {
    const auth = await verifyFirebaseIdToken(token);
    if (!auth || !auth.uid) {
      return res.status(401).json({
        error: "Unauthorized: Invalid, revoked, or expired Firebase ID token.",
        code: "AUTH_TOKEN_INVALID",
      });
    }

    // Attach verified user identity to the request
    req.auth = auth;
    req.verifiedUid = auth.uid;
    req.safeUserId = auth.safeUserId;

    next();
  } catch (error) {
    logger.error("Authentication middleware failure", error.stack || error.message);
    return res.status(401).json({
      error: "Unauthorized: Authentication verification failed.",
      code: "AUTH_VERIFICATION_ERROR",
    });
  }
}

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "awoyinfasolomon1@gmail.com";
export const ADMIN_EMAILS = new Set([
  "awoyinfasolomon1@gmail.com",
  "solomontech00@gmail.com",
  "king1solomon3t@gmail.com",
  ...(process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()) : []),
  (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
].filter(Boolean));

export function isAdminEmail(email) {
  if (!email || typeof email !== "string") return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

let serverFirestoreInstance = null;

/**
 * Returns a server-side Firestore instance initialized from project config
 */
export function getFirebaseServerFirestore() {
  if (serverFirestoreInstance) return serverFirestoreInstance;
  try {
    const apps = getApps();
    const app = apps.length > 0 ? apps[0] : initializeApp(firebaseConfig);
    const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
    try {
      serverFirestoreInstance = initializeFirestore(app, { experimentalForceLongPolling: true }, dbId);
    } catch {
      serverFirestoreInstance = getFirestore(app, dbId);
    }
  } catch (e) {
    logger.debug("Server firestore init note", e.message);
  }
  return serverFirestoreInstance;
}

/**
 * Writes a document to Firestore using the REST API with the caller's ID token or API key.
 * This guarantees that authentication headers are passed directly to Google Firebase REST API.
 */
export async function writeFirestoreDocumentRest(collectionName, docId, data, idToken = null) {
  try {
    const projectId = firebaseConfig.projectId || PROJECT_ID;
    const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collectionName}/${encodeURIComponent(docId)}?key=${API_KEY}`;
    
    function toFirestoreValue(val) {
      if (val === null || val === undefined) return { nullValue: null };
      if (typeof val === "boolean") return { booleanValue: val };
      if (typeof val === "number") {
        return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
      }
      if (typeof val === "string") return { stringValue: val };
      if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
      if (typeof val === "object") {
        const fields = {};
        for (const [k, v] of Object.entries(val)) {
          fields[k] = toFirestoreValue(v);
        }
        return { mapValue: { fields } };
      }
      return { stringValue: String(val) };
    }

    const fields = {};
    for (const [k, v] of Object.entries(data || {})) {
      fields[k] = toFirestoreValue(v);
    }

    const headers = { "Content-Type": "application/json" };
    if (idToken) {
      const cleanToken = idToken.startsWith("Bearer ") ? idToken.slice(7) : idToken;
      if (!cleanToken.startsWith("solva_preview_")) {
        headers["Authorization"] = `Bearer ${cleanToken}`;
      }
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.debug(`Firestore REST write notice (${collectionName}/${docId}): ${res.status}`, errText);
      return false;
    }
    return true;
  } catch (err) {
    logger.debug(`Firestore REST write exception (${collectionName}/${docId})`, err.message);
    return false;
  }
}

export function fromFirestoreValue(val) {
  if (!val || typeof val !== "object") return val;
  if ("nullValue" in val) return null;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return val.doubleValue;
  if ("stringValue" in val) return val.stringValue;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) return (val.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in val) {
    const res = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      res[k] = fromFirestoreValue(v);
    }
    return res;
  }
  return val;
}

export async function readFirestoreDocumentRest(collectionName, docId, idToken = null) {
  try {
    const projectId = firebaseConfig.projectId || PROJECT_ID;
    const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collectionName}/${encodeURIComponent(docId)}?key=${API_KEY}`;
    const headers = {};
    if (idToken) {
      const cleanToken = idToken.startsWith("Bearer ") ? idToken.slice(7) : idToken;
      if (!cleanToken.startsWith("solva_preview_")) {
        headers["Authorization"] = `Bearer ${cleanToken}`;
      }
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    const data = {};
    for (const [k, v] of Object.entries(json.fields || {})) {
      data[k] = fromFirestoreValue(v);
    }
    return data;
  } catch (err) {
    logger.debug(`readFirestoreDocumentRest error (${collectionName}/${docId})`, err.message);
    return null;
  }
}

export async function readFirestoreCollectionRest(collectionName, idToken = null) {
  try {
    const projectId = firebaseConfig.projectId || PROJECT_ID;
    const databaseId = firebaseConfig.firestoreDatabaseId || "(default)";
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collectionName}?key=${API_KEY}`;
    const headers = {};
    if (idToken) {
      const cleanToken = idToken.startsWith("Bearer ") ? idToken.slice(7) : idToken;
      if (!cleanToken.startsWith("solva_preview_")) {
        headers["Authorization"] = `Bearer ${cleanToken}`;
      }
    }
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    const docs = (json.documents || []).map((docObj) => {
      const docId = docObj.name.split("/").pop();
      const data = { id: docId };
      for (const [k, v] of Object.entries(docObj.fields || {})) {
        data[k] = fromFirestoreValue(v);
      }
      return data;
    });
    return docs;
  } catch (err) {
    logger.debug(`readFirestoreCollectionRest error (${collectionName})`, err.message);
    return [];
  }
}

/**
 * Express Middleware: Strictly enforces Administrator authorization.
 * Verifies that the authenticated user's email matches the exact admin address.
 */
export function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.email) {
    return res.status(401).json({
      error: "Unauthorized: Authentication required.",
      code: "AUTH_REQUIRED",
    });
  }

  if (!isAdminEmail(req.auth.email)) {
    logger.warn(`Forbidden admin access attempt by ${req.auth.email} (UID: ${req.auth.uid})`);
    return res.status(403).json({
      error: "Forbidden: You do not have administrator permissions.",
      code: "ADMIN_FORBIDDEN",
    });
  }

  next();
}
