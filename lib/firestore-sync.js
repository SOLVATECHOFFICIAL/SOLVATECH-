import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  deleteDoc,
} from "firebase/firestore";
import { logger } from "./logger.js";
import {
  writeFirestoreDocumentRest,
  readFirestoreDocumentRest,
  readFirestoreCollectionRest,
} from "./auth.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadFirebaseConfig() {
  try {
    const configPath = path.join(rootDir, "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return {
        projectId: cfg.projectId || process.env.FIREBASE_PROJECT_ID || "",
        apiKey: cfg.apiKey || process.env.FIREBASE_API_KEY || "",
        firestoreDatabaseId: cfg.firestoreDatabaseId || process.env.FIREBASE_DATABASE_ID || "(default)",
        authDomain: cfg.authDomain || "",
        storageBucket: cfg.storageBucket || "",
        messagingSenderId: cfg.messagingSenderId || "",
        appId: cfg.appId || "",
      };
    }
  } catch (error) {
    logger.warn("Could not read firebase-applet-config.json", error.message);
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    apiKey: process.env.FIREBASE_API_KEY || "",
    firestoreDatabaseId: process.env.FIREBASE_DATABASE_ID || "(default)",
  };
}

const firebaseConfig = loadFirebaseConfig();
let dbInstance = null;

export function getFirestoreDb() {
  if (dbInstance) return dbInstance;
  try {
    const apps = getApps();
    const app = apps.length > 0 ? apps[0] : initializeApp(firebaseConfig);
    const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
    try {
      dbInstance = initializeFirestore(app, { experimentalForceLongPolling: true }, dbId);
    } catch {
      dbInstance = getFirestore(app, dbId);
    }
  } catch (err) {
    logger.debug("[Firestore] DB initialization note:", err.message);
  }
  return dbInstance;
}

/**
 * Saves or updates a document in Firestore.
 * Tries REST API (with caller ID token if provided) first, then Firestore SDK.
 */
export async function firestoreUpsert(collectionName, docId, data, idToken = null) {
  if (!collectionName || !docId) return false;
  const cleanDocId = String(docId).trim();
  const payload = { ...data, updatedAt: new Date().toISOString() };

  // 1. Try REST API first (ensures caller's token is passed directly)
  try {
    const ok = await writeFirestoreDocumentRest(collectionName, cleanDocId, payload, idToken);
    if (ok) return true;
  } catch (err) {
    logger.debug(`[Firestore] REST write notice for ${collectionName}/${cleanDocId}:`, err.message);
  }

  // 2. Try Firestore Client SDK
  try {
    const db = getFirestoreDb();
    if (db) {
      const docRef = doc(db, collectionName, cleanDocId);
      await setDoc(docRef, payload, { merge: true });
      return true;
    }
  } catch (err) {
    logger.debug(`[Firestore] SDK write notice for ${collectionName}/${cleanDocId}:`, err.message);
  }

  return false;
}

/**
 * Reads a single document from Firestore by collection name and docId.
 */
export async function firestoreGetById(collectionName, docId, idToken = null) {
  if (!collectionName || !docId) return null;
  const cleanDocId = String(docId).trim();

  // 1. Try REST API
  try {
    const data = await readFirestoreDocumentRest(collectionName, cleanDocId, idToken);
    if (data && typeof data === "object" && Object.keys(data).length > 0) {
      return data;
    }
  } catch {}

  // 2. Try Firestore Client SDK
  try {
    const db = getFirestoreDb();
    if (db) {
      const docRef = doc(db, collectionName, cleanDocId);
      const snapshot = await getDoc(docRef);
      if (snapshot.exists()) {
        return { id: snapshot.id, ...snapshot.data() };
      }
    }
  } catch {}

  return null;
}

/**
 * Reads all documents from a Firestore collection.
 */
export async function firestoreGetAll(collectionName, idToken = null) {
  if (!collectionName) return [];

  // 1. Try REST API
  try {
    const docs = await readFirestoreCollectionRest(collectionName, idToken);
    if (Array.isArray(docs) && docs.length > 0) {
      return docs;
    }
  } catch {}

  // 2. Try Firestore Client SDK
  try {
    const db = getFirestoreDb();
    if (db) {
      const colRef = collection(db, collectionName);
      const snapshot = await getDocs(colRef);
      const list = [];
      snapshot.forEach((d) => {
        list.push({ id: d.id, ...d.data() });
      });
      return list;
    }
  } catch (err) {
    logger.debug(`[Firestore] SDK list error for ${collectionName}:`, err.message);
  }

  return [];
}

/**
 * Deletes a document from Firestore.
 */
export async function firestoreDelete(collectionName, docId, idToken = null) {
  if (!collectionName || !docId) return false;
  const cleanDocId = String(docId).trim();

  try {
    const db = getFirestoreDb();
    if (db) {
      const docRef = doc(db, collectionName, cleanDocId);
      await deleteDoc(docRef);
      return true;
    }
  } catch {}

  return false;
}
