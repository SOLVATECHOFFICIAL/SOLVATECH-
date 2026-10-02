import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

/**
 * Resolves configuration purely from environment variables (e.g. Railway / .env)
 */
export function getResolvedSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || "").trim();

  return { url, serviceRoleKey, anonKey };
}

let supabaseAdminClient = null;
let hasLoggedConfigWarning = false;

/**
 * Checks whether Supabase credentials have been configured via environment variables.
 */
export function isSupabaseConfigured() {
  const { url, serviceRoleKey, anonKey } = getResolvedSupabaseConfig();
  return Boolean(url && (serviceRoleKey || anonKey));
}

/**
 * Returns safe metadata about the Supabase configuration.
 * Never exposes the service-role or secret key.
 */
export function getSupabasePublicConfig() {
  const { url, anonKey, serviceRoleKey } = getResolvedSupabaseConfig();

  return {
    configured: isSupabaseConfigured(),
    url: url || null,
    anonKey: anonKey || null,
    hasServiceRoleKey: Boolean(serviceRoleKey),
  };
}

/**
 * Centralized Supabase client for backend operations.
 * Uses SUPABASE_SERVICE_ROLE_KEY (preferred for backend to bypass RLS)
 * with graceful fallback to SUPABASE_ANON_KEY.
 */
export function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    if (!hasLoggedConfigWarning) {
      hasLoggedConfigWarning = true;
      logger.info("[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not yet detected in environment. Operating in local durable fallback mode.");
    }
    return null;
  }

  const { url, serviceRoleKey, anonKey } = getResolvedSupabaseConfig();
  const key = serviceRoleKey || anonKey;

  if (!url || !key) {
    return null;
  }

  if (!supabaseAdminClient) {
    try {
      supabaseAdminClient = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
      logger.info(`[Supabase] Client initialized successfully for ${url}`);
    } catch (err) {
      logger.warn("[Supabase] Failed to initialize Supabase client:", err.message);
      return null;
    }
  }

  return supabaseAdminClient;
}

/**
 * Verifies whether the Supabase schema and tables have actually been created.
 * Prevents assuming the database is ready until verified.
 */
export async function checkSupabaseSchemaStatus() {
  const client = getSupabaseClient();
  if (!client) {
    return { configured: false, schemaReady: false, reason: "Credentials not provided" };
  }
  try {
    const { error: userError } = await client.from("users").select("id").limit(1);
    if (!userError) {
      return { configured: true, schemaReady: true, reason: null };
    }
    const { error: configError } = await client.from("system_config").select("key").limit(1);
    if (!configError) {
      return { configured: true, schemaReady: true, reason: null };
    }
    return { configured: true, schemaReady: false, reason: userError?.message || configError?.message || "Schema check failed" };
  } catch (err) {
    return { configured: true, schemaReady: false, reason: err.message };
  }
}

/**
 * Upserts a record or array of records into a Supabase table.
 * Returns { data, error, success: boolean }.
 */
export async function supabaseUpsert(tableName, records, onConflictColumn = "id") {
  const client = getSupabaseClient();
  if (!client) return { success: false, error: "Supabase not configured", data: null };

  try {
    const { data, error } = await client
      .from(tableName)
      .upsert(records, { onConflict: onConflictColumn });

    if (error) {
      logger.debug(`[Supabase] Upsert error on table '${tableName}':`, error.message);
      return { success: false, error: error.message, data: null };
    }
    return { success: true, error: null, data };
  } catch (err) {
    logger.debug(`[Supabase] Upsert exception on table '${tableName}':`, err.message);
    return { success: false, error: err.message, data: null };
  }
}

/**
 * Reads a single row by primary key column.
 */
export async function supabaseGetById(tableName, id, idColumn = "id") {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from(tableName)
      .select("*")
      .eq(idColumn, id)
      .maybeSingle();

    if (error) {
      logger.debug(`[Supabase] Select error on '${tableName}' where ${idColumn}=${id}:`, error.message);
      return null;
    }
    return data;
  } catch (err) {
    logger.debug(`[Supabase] Select exception on '${tableName}':`, err.message);
    return null;
  }
}

/**
 * Reads all rows from a table with optional filter and order.
 */
export async function supabaseGetAll(tableName, options = {}) {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    let query = client.from(tableName).select(options.columns || "*");
    if (options.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending ?? false });
    }
    if (options.limit) {
      query = query.limit(options.limit);
    }
    const { data, error } = await query;
    if (error) {
      logger.debug(`[Supabase] GetAll error on table '${tableName}':`, error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    logger.debug(`[Supabase] GetAll exception on table '${tableName}':`, err.message);
    return [];
  }
}

/**
 * Deletes rows matching a condition.
 */
export async function supabaseDelete(tableName, column, value) {
  const client = getSupabaseClient();
  if (!client) return { success: false };

  try {
    const { error } = await client.from(tableName).delete().eq(column, value);
    if (error) {
      logger.debug(`[Supabase] Delete error on table '${tableName}' where ${column}=${value}:`, error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logger.debug(`[Supabase] Delete exception on table '${tableName}':`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Updates rows matching a column value.
 */
export async function supabaseUpdate(tableName, column, value, patch) {
  const client = getSupabaseClient();
  if (!client) return { success: false, data: null };

  try {
    const { data, error } = await client
      .from(tableName)
      .update(patch)
      .eq(column, value)
      .select();

    if (error) {
      logger.debug(`[Supabase] Update error on table '${tableName}' where ${column}=${value}:`, error.message);
      return { success: false, error: error.message, data: null };
    }
    return { success: true, data: Array.isArray(data) ? data[0] : data };
  } catch (err) {
    logger.debug(`[Supabase] Update exception on table '${tableName}':`, err.message);
    return { success: false, error: err.message, data: null };
  }
}

/**
 * Reads rows matching a column value with optional ordering.
 */
export async function supabaseGetWhere(tableName, column, value, options = {}) {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    let query = client.from(tableName).select(options.columns || "*").eq(column, value);
    if (options.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending ?? false });
    }
    if (options.limit) {
      query = query.limit(options.limit);
    }
    const { data, error } = await query;
    if (error) {
      logger.debug(`[Supabase] GetWhere error on '${tableName}':`, error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    logger.debug(`[Supabase] GetWhere exception on '${tableName}':`, err.message);
    return [];
  }
}

let receiptBucketVerified = false;

/**
 * Ensures a dedicated Supabase Storage bucket exists for payment receipts.
 */
export async function ensureSupabaseStorageBucket(bucketName = "payment-receipts") {
  const client = getSupabaseClient();
  if (!client) return false;
  if (receiptBucketVerified && bucketName === "payment-receipts") return true;

  try {
    const { data: existing, error: getErr } = await client.storage.getBucket(bucketName);
    if (existing && !getErr) {
      if (!existing.public) {
        await client.storage.updateBucket(bucketName, {
          public: true,
          fileSizeLimit: 5242880,
          allowedMimeTypes: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
        }).catch(() => {});
      }
      if (bucketName === "payment-receipts") receiptBucketVerified = true;
      return true;
    }

    const { error: createErr } = await client.storage.createBucket(bucketName, {
      public: true,
      fileSizeLimit: 5242880,
      allowedMimeTypes: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
    });

    if (!createErr || String(createErr.message || "").toLowerCase().includes("already exists")) {
      if (bucketName === "payment-receipts") receiptBucketVerified = true;
      return true;
    }
    logger.debug(`[Supabase Storage] Create bucket notice (${bucketName}):`, createErr.message);
    return false;
  } catch (err) {
    logger.debug(`[Supabase Storage] Bucket check exception (${bucketName}):`, err.message);
    return false;
  }
}

/**
 * Returns the public URL for a file stored in a public Supabase Storage bucket.
 */
export function supabaseStoragePublicUrl(bucketName, storagePath) {
  const client = getSupabaseClient();
  if (!client || !storagePath) return null;
  const cleanPath = String(storagePath || "").replace(/^\/+/, "");
  try {
    const { data } = client.storage.from(bucketName).getPublicUrl(cleanPath);
    return data?.publicUrl || null;
  } catch {
    return null;
  }
}

/**
 * Uploads a binary file buffer to Supabase Storage (Never stores Base64 in PostgreSQL).
 */
export async function supabaseStorageUpload(bucketName, storagePath, fileBuffer, contentType = "image/jpeg") {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase client is not configured.");
  }

  await ensureSupabaseStorageBucket(bucketName);
  const cleanPath = String(storagePath || "").replace(/^\/+/, "");

  const { data, error } = await client.storage
    .from(bucketName)
    .upload(cleanPath, fileBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }

  return {
    bucket: bucketName,
    path: data?.path || cleanPath,
  };
}

/**
 * Downloads a binary file from Supabase Storage.
 */
export async function supabaseStorageDownload(bucketName, storagePath) {
  const client = getSupabaseClient();
  if (!client || !storagePath) return null;

  const cleanPath = String(storagePath || "").replace(/^\/+/, "");
  try {
    const { data, error } = await client.storage.from(bucketName).download(cleanPath);
    if (error || !data) {
      logger.debug(`[Supabase Storage] Download notice for '${cleanPath}':`, error?.message);
      return null;
    }
    const arrayBuffer = await data.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: data.type || "image/jpeg",
    };
  } catch (err) {
    logger.debug(`[Supabase Storage] Download exception for '${cleanPath}':`, err.message);
    return null;
  }
}

/**
 * Creates a temporary signed URL for viewing a receipt in Supabase Storage.
 */
export async function supabaseStorageSignedUrl(bucketName, storagePath, expiresInSeconds = 3600) {
  const client = getSupabaseClient();
  if (!client || !storagePath) return null;

  const cleanPath = String(storagePath || "").replace(/^\/+/, "");
  try {
    const { data, error } = await client.storage
      .from(bucketName)
      .createSignedUrl(cleanPath, expiresInSeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Removes an object from Supabase Storage.
 */
export async function supabaseStorageDelete(bucketName, storagePath) {
  const client = getSupabaseClient();
  if (!client || !storagePath) return false;

  const cleanPath = String(storagePath || "").replace(/^\/+/, "");
  try {
    const { error } = await client.storage.from(bucketName).remove([cleanPath]);
    return !error;
  } catch {
    return false;
  }
}

