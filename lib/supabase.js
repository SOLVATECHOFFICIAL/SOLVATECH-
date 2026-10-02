import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

// Centralized Supabase environment configuration
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

let supabaseAdminClient = null;
let hasLoggedConfigWarning = false;

/**
 * Checks whether Supabase credentials have been provided via environment variables.
 */
export function isSupabaseConfigured() {
  const url = (process.env.SUPABASE_URL || SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY || "").trim();
  return Boolean(url && key);
}

/**
 * Returns safe metadata about the Supabase configuration.
 * Never exposes the service-role or secret key.
 */
export function getSupabasePublicConfig() {
  const url = (process.env.SUPABASE_URL || SUPABASE_URL || "").trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY || "").trim();
  const hasServiceKey = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE_KEY || "").trim());

  return {
    configured: isSupabaseConfigured(),
    url: url || null,
    anonKey: anonKey || null,
    hasServiceRoleKey: hasServiceKey,
  };
}

/**
 * Centralized Supabase client for backend operations.
 * Uses SUPABASE_SERVICE_ROLE_KEY (preferred for backend to bypass RLS)
 * with graceful fallback to SUPABASE_ANON_KEY.
 * Returns null if credentials are not yet configured.
 */
export function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    if (!hasLoggedConfigWarning) {
      hasLoggedConfigWarning = true;
      logger.info("[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY not set. Using local durable store until credentials are provided in Railway/Environment.");
    }
    return null;
  }

  const url = (process.env.SUPABASE_URL || SUPABASE_URL).trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY).trim();

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
