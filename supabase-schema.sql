-- =========================================================================
-- SOLVATECH BOT - ULTIMATE SUPABASE / POSTGRESQL SCHEMA & MIGRATION SCRIPT
-- =========================================================================
-- Description: Complete, high-performance database schema for SOLVATECH BOT
-- Features: User profiles, multi-device sessions, cryptographic licenses,
--           group automation, anti-spam, DDD message recovery, AI memory,
--           referral tracking, performance indexes, RLS, functions & views.
-- Instructions: Run in your Supabase Dashboard -> SQL Editor -> New Query -> Run.
-- Safe & Idempotent: Can be run repeatedly without data loss.
-- =========================================================================

-- Enable UUID extension if available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================================
-- SECTION 1: USERS & AUTHENTICATION PROFILES
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  photo_url TEXT,
  role TEXT DEFAULT 'user',
  referral_code TEXT,
  referred_by TEXT,
  referred_at TIMESTAMPTZ,
  qualifying_sales_ngn NUMERIC(14, 2) DEFAULT 0,
  claimed_days_total INTEGER DEFAULT 0,
  is_banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  preferences JSONB DEFAULT '{"theme":"dark","notifications":true}'::jsonb,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backward-compatible column migration
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS qualifying_sales_ngn NUMERIC(14, 2) DEFAULT 0;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS claimed_days_total INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{"theme":"dark","notifications":true}'::jsonb;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS raw_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 2: CRYPTOGRAPHIC LICENSES & KEYS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.licenses (
  code TEXT PRIMARY KEY,
  duration_days TEXT NOT NULL,
  is_unlimited BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'unused',
  created_by TEXT,
  notes TEXT,
  redeemed_by_uid TEXT,
  redeemed_by_email TEXT,
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  price_ngn NUMERIC(12, 2) DEFAULT 0,
  batch_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS duration_days TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS is_unlimited BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unused';
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS redeemed_by_uid TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS redeemed_by_email TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS price_ngn NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS batch_id TEXT;
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.licenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 3: USER SUBSCRIPTIONS & ACTIVATIONS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.user_licenses (
  uid TEXT PRIMARY KEY,
  email TEXT,
  last_license_code TEXT,
  duration_days TEXT,
  is_unlimited BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  days_remaining INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS last_license_code TEXT;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS duration_days TEXT;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS is_unlimited BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS days_remaining INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.user_licenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 4: USER GROUP SETTINGS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.group_settings (
  safe_user_id TEXT PRIMARY KEY,
  settings JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.group_settings ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.group_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 5: CROSS-SESSION PERMANENT GROUP RULES (BY WHATSAPP JID)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.group_rules (
  group_id TEXT PRIMARY KEY,
  group_name TEXT,
  rules JSONB DEFAULT '{
    "antiLink": false,
    "antiBot": false,
    "antiStatus": false,
    "antiSticker": false,
    "welcome": false,
    "goodbye": false,
    "warningLimit": 3
  }'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.group_rules ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE IF EXISTS public.group_rules ADD COLUMN IF NOT EXISTS rules JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.group_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.group_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 6 & 7: ANTI-HIJACK NUMBER LOCKS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.number_locks (
  phone_number TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  user_email TEXT,
  device_name TEXT,
  locked_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.number_locks ADD COLUMN IF NOT EXISTS uid TEXT;
ALTER TABLE IF EXISTS public.number_locks ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE IF EXISTS public.number_locks ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE IF EXISTS public.number_locks ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.user_number_locks (
  uid TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  user_email TEXT,
  locked_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.user_number_locks ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE IF EXISTS public.user_number_locks ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE IF EXISTS public.user_number_locks ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 8: REFERRAL PURCHASES & REVENUE ATTRIBUTION
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.referral_purchases (
  purchase_id TEXT PRIMARY KEY,
  buyer_uid TEXT NOT NULL,
  buyer_email TEXT,
  referrer_uid TEXT NOT NULL,
  license_code TEXT,
  duration_days TEXT,
  amount_ngn NUMERIC(12, 2) DEFAULT 0,
  is_qualifying BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS buyer_uid TEXT;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS buyer_email TEXT;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS referrer_uid TEXT;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS license_code TEXT;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS duration_days TEXT;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS amount_ngn NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS is_qualifying BOOLEAN DEFAULT TRUE;
ALTER TABLE IF EXISTS public.referral_purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 9: REFERRAL REWARD MILESTONES
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.referral_rewards (
  reward_id TEXT PRIMARY KEY,
  referrer_uid TEXT NOT NULL,
  threshold_ngn NUMERIC(12, 2) DEFAULT 0,
  free_days INTEGER DEFAULT 0,
  status TEXT DEFAULT 'earned',
  claimed_at TIMESTAMPTZ,
  claim_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS referrer_uid TEXT;
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS threshold_ngn NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS free_days INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'earned';
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS claim_id TEXT;
ALTER TABLE IF EXISTS public.referral_rewards ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 10: REFERRAL CLAIMS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.referral_claims (
  claim_id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL,
  user_email TEXT,
  days_awarded INTEGER DEFAULT 0,
  previous_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'completed',
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS user_uid TEXT;
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS days_awarded INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS previous_expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS new_expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
ALTER TABLE IF EXISTS public.referral_claims ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 11: SYSTEM CONFIGURATION & GLOBAL PRICE PLANS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.system_config ADD COLUMN IF NOT EXISTS value JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.system_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Seed default pricing plans if absent
INSERT INTO public.system_config (key, value, updated_at)
VALUES (
  'license_plans',
  '{
    "plans": [
      {"id": "1d", "days": 1, "name": "1 Day", "priceNgn": 200},
      {"id": "3d", "days": 3, "name": "3 Days", "priceNgn": 500},
      {"id": "7d", "days": 7, "name": "7 Days", "priceNgn": 1000},
      {"id": "14d", "days": 14, "name": "14 Days / 2 Weeks", "priceNgn": 2000},
      {"id": "30d", "days": 30, "name": "30 Days", "priceNgn": 4000},
      {"id": "60d", "days": 60, "name": "2 Months", "priceNgn": 8000},
      {"id": "90d", "days": 90, "name": "3 Months", "priceNgn": 12000},
      {"id": "180d", "days": 180, "name": "6 Months", "priceNgn": 24000},
      {"id": "365d", "days": 365, "name": "12 Months", "priceNgn": 48000}
    ]
  }'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;


-- =========================================================================
-- SECTION 12: WHATSAPP PERSISTENT BAILEYS SESSIONS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
  safe_user_id TEXT PRIMARY KEY,
  user_id TEXT,
  uid TEXT,
  phone_number TEXT,
  files JSONB DEFAULT '{}'::jsonb,
  file_count INTEGER DEFAULT 0,
  connection_status TEXT DEFAULT 'disconnected',
  last_active_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS uid TEXT;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS safe_user_id TEXT;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS file_count INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS connection_status TEXT DEFAULT 'disconnected';
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.whatsapp_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 13: ANTI-DELETE MESSAGE RECOVERY (DDD LOGS)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.deleted_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  original_id TEXT,
  remote_jid TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT,
  text TEXT,
  media_type TEXT,
  media_storage_path TEXT,
  media_url TEXT,
  original_timestamp BIGINT,
  deleted_at BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS original_id TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS remote_jid TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS sender TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS text TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS media_storage_path TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS original_timestamp BIGINT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
ALTER TABLE IF EXISTS public.deleted_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 14: BOT COMMAND EXECUTION & ANALYTICS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.bot_command_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  args TEXT,
  chat_jid TEXT,
  is_group BOOLEAN DEFAULT FALSE,
  caller_jid TEXT,
  execution_time_ms INTEGER DEFAULT 0,
  success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS command_name TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS args TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS chat_jid TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS caller_jid TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS success BOOLEAN DEFAULT TRUE;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE IF EXISTS public.bot_command_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 15: GROUP USER WARNINGS & INFRACTIONS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.group_warnings (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  target_user_jid TEXT NOT NULL,
  warning_count INTEGER DEFAULT 1,
  violation_type TEXT,
  reason TEXT,
  warned_by_jid TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS group_id TEXT;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS target_user_jid TEXT;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS warning_count INTEGER DEFAULT 1;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS violation_type TEXT;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS warned_by_jid TEXT;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.group_warnings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 16: ANTI-SPAM & RATE LIMIT EVENTS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.anti_spam_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  event_type TEXT DEFAULT 'message_flood',
  messages_in_window INTEGER DEFAULT 0,
  action_taken TEXT DEFAULT 'warn',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS chat_jid TEXT;
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS sender_jid TEXT;
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT 'message_flood';
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS messages_in_window INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS action_taken TEXT DEFAULT 'warn';
ALTER TABLE IF EXISTS public.anti_spam_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 17: AI CHAT MEMORIES & CONTEXT TURNS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.ai_chat_memories (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model_used TEXT,
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS chat_id TEXT;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS model_used TEXT;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS tokens_used INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.ai_chat_memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 18: AI DEEP KNOWLEDGE & USER FACTS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.ai_deep_facts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence NUMERIC(3, 2) DEFAULT 1.0,
  source TEXT DEFAULT 'conversation',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS chat_id TEXT;
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS fact_key TEXT;
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS fact_value TEXT;
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS confidence NUMERIC(3, 2) DEFAULT 1.0;
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'conversation';
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.ai_deep_facts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 19: ADMIN SECURITY AUDIT LOGS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_uid TEXT,
  target_resource TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS admin_email TEXT;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS target_uid TEXT;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS target_resource TEXT;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE IF EXISTS public.audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 20: ANTI-VIEW-ONCE MEDIA CACHE STORE
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.media_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_hash TEXT,
  file_size BIGINT DEFAULT 0,
  storage_path TEXT,
  mime_type TEXT,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS file_hash TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE IF EXISTS public.media_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 21: BROADCAST MESSAGING LOGS
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.broadcast_logs (
  id TEXT PRIMARY KEY,
  sender_email TEXT NOT NULL,
  message_text TEXT NOT NULL,
  recipient_type TEXT DEFAULT 'all',
  total_recipients INTEGER DEFAULT 0,
  successful_deliveries INTEGER DEFAULT 0,
  failed_deliveries INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS sender_email TEXT;
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS message_text TEXT;
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS recipient_type TEXT DEFAULT 'all';
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS total_recipients INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS successful_deliveries INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS failed_deliveries INTEGER DEFAULT 0;
ALTER TABLE IF EXISTS public.broadcast_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =========================================================================
-- SECTION 22: HIGH-PERFORMANCE INDEXES
-- =========================================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON public.users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON public.users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON public.users(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_licenses_status ON public.licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_redeemed_by_uid ON public.licenses(redeemed_by_uid);
CREATE INDEX IF NOT EXISTS idx_licenses_created_at ON public.licenses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON public.licenses(expires_at);

CREATE INDEX IF NOT EXISTS idx_user_licenses_status ON public.user_licenses(status);
CREATE INDEX IF NOT EXISTS idx_user_licenses_expires_at ON public.user_licenses(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_licenses_is_unlimited ON public.user_licenses(is_unlimited);

CREATE INDEX IF NOT EXISTS idx_number_locks_uid ON public.number_locks(uid);
CREATE INDEX IF NOT EXISTS idx_number_locks_email ON public.number_locks(user_email);
CREATE INDEX IF NOT EXISTS idx_user_number_locks_phone ON public.user_number_locks(phone_number);

CREATE INDEX IF NOT EXISTS idx_ref_purchases_buyer ON public.referral_purchases(buyer_uid);
CREATE INDEX IF NOT EXISTS idx_ref_purchases_referrer ON public.referral_purchases(referrer_uid);
CREATE INDEX IF NOT EXISTS idx_ref_purchases_created ON public.referral_purchases(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ref_rewards_referrer ON public.referral_rewards(referrer_uid);
CREATE INDEX IF NOT EXISTS idx_ref_rewards_status ON public.referral_rewards(status);

CREATE INDEX IF NOT EXISTS idx_ref_claims_uid ON public.referral_claims(user_uid);
CREATE INDEX IF NOT EXISTS idx_ref_claims_claimed_at ON public.referral_claims(claimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_deleted_msgs_user_id ON public.deleted_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_deleted_msgs_remote_jid ON public.deleted_messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_deleted_msgs_created ON public.deleted_messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_command_logs_user ON public.bot_command_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_command_logs_name ON public.bot_command_logs(command_name);
CREATE INDEX IF NOT EXISTS idx_bot_command_logs_created ON public.bot_command_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_warnings_group ON public.group_warnings(group_id);
CREATE INDEX IF NOT EXISTS idx_group_warnings_user ON public.group_warnings(target_user_jid);

CREATE INDEX IF NOT EXISTS idx_anti_spam_chat ON public.anti_spam_events(chat_jid);
CREATE INDEX IF NOT EXISTS idx_anti_spam_created ON public.anti_spam_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_memories_chat ON public.ai_chat_memories(chat_id);
CREATE INDEX IF NOT EXISTS idx_ai_memories_created ON public.ai_chat_memories(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_deep_facts_chat ON public.ai_deep_facts(chat_id);
CREATE INDEX IF NOT EXISTS idx_ai_deep_facts_key ON public.ai_deep_facts(fact_key);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON public.audit_logs(target_uid);


-- =========================================================================
-- SECTION 23: ANALYTICAL VIEWS
-- =========================================================================

-- View: Active subscribers with subscription health
CREATE OR REPLACE VIEW public.active_subscribers_view AS
SELECT 
  u.id AS user_id,
  u.email,
  u.display_name,
  u.referral_code,
  ul.status AS subscription_status,
  ul.is_unlimited,
  ul.expires_at,
  CASE 
    WHEN ul.is_unlimited THEN 'Unlimited'
    WHEN ul.expires_at IS NULL THEN 'Inactive'
    WHEN ul.expires_at < NOW() THEN 'Expired'
    ELSE 'Active'
  END AS computed_status,
  CASE 
    WHEN ul.is_unlimited THEN 99999
    WHEN ul.expires_at IS NULL THEN 0
    WHEN ul.expires_at < NOW() THEN 0
    ELSE CEIL(EXTRACT(EPOCH FROM (ul.expires_at - NOW())) / 86400)::INTEGER
  END AS days_remaining,
  nl.phone_number AS locked_phone,
  ws.connection_status AS whatsapp_status,
  ws.last_active_at AS whatsapp_last_active
FROM public.users u
LEFT JOIN public.user_licenses ul ON u.id = ul.uid
LEFT JOIN public.user_number_locks nl ON u.id = nl.uid
LEFT JOIN public.whatsapp_sessions ws ON u.id = ws.safe_user_id;

-- View: Referral sales leaderboard
CREATE OR REPLACE VIEW public.referral_leaderboard_view AS
SELECT 
  u.id AS user_id,
  u.email,
  u.display_name,
  u.referral_code,
  COUNT(rp.purchase_id) AS total_referral_sales_count,
  COALESCE(SUM(rp.amount_ngn), 0) AS total_sales_volume_ngn,
  u.claimed_days_total AS total_reward_days_claimed,
  COUNT(rw.reward_id) FILTER (WHERE rw.status = 'earned') AS pending_unclaimed_rewards
FROM public.users u
LEFT JOIN public.referral_purchases rp ON u.id = rp.referrer_uid
LEFT JOIN public.referral_rewards rw ON u.id = rw.referrer_uid
GROUP BY u.id, u.email, u.display_name, u.referral_code, u.claimed_days_total
ORDER BY total_sales_volume_ngn DESC;

-- View: System health & key indicators
CREATE OR REPLACE VIEW public.system_health_view AS
SELECT 
  (SELECT COUNT(*) FROM public.users) AS total_users,
  (SELECT COUNT(*) FROM public.user_licenses WHERE is_unlimited = TRUE OR expires_at > NOW()) AS active_subscribers,
  (SELECT COUNT(*) FROM public.licenses WHERE status = 'unused') AS available_license_keys,
  (SELECT COUNT(*) FROM public.licenses WHERE status = 'used') AS redeemed_license_keys,
  (SELECT COUNT(*) FROM public.whatsapp_sessions WHERE connection_status = 'connected' OR connection_status = 'ready') AS connected_sessions,
  (SELECT COUNT(*) FROM public.deleted_messages) AS total_recovered_messages,
  (SELECT COUNT(*) FROM public.bot_command_logs) AS total_commands_executed,
  (SELECT COUNT(*) FROM public.number_locks) AS locked_numbers_count;


-- =========================================================================
-- SECTION 24: FUNCTIONS & TRIGGERS
-- =========================================================================

-- Trigger function: Update timestamp column
CREATE OR REPLACE FUNCTION public.update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update trigger to relevant tables
DROP TRIGGER IF EXISTS trg_update_users_timestamp ON public.users;
CREATE TRIGGER trg_update_users_timestamp
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_licenses_timestamp ON public.licenses;
CREATE TRIGGER trg_update_licenses_timestamp
  BEFORE UPDATE ON public.licenses
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_user_licenses_timestamp ON public.user_licenses;
CREATE TRIGGER trg_update_user_licenses_timestamp
  BEFORE UPDATE ON public.user_licenses
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_group_settings_timestamp ON public.group_settings;
CREATE TRIGGER trg_update_group_settings_timestamp
  BEFORE UPDATE ON public.group_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_group_rules_timestamp ON public.group_rules;
CREATE TRIGGER trg_update_group_rules_timestamp
  BEFORE UPDATE ON public.group_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_whatsapp_sessions_timestamp ON public.whatsapp_sessions;
CREATE TRIGGER trg_update_whatsapp_sessions_timestamp
  BEFORE UPDATE ON public.whatsapp_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

DROP TRIGGER IF EXISTS trg_update_ai_facts_timestamp ON public.ai_deep_facts;
CREATE TRIGGER trg_update_ai_facts_timestamp
  BEFORE UPDATE ON public.ai_deep_facts
  FOR EACH ROW EXECUTE FUNCTION public.update_timestamp_column();

-- Function: Atomic License Grant
CREATE OR REPLACE FUNCTION public.grant_user_license(
  p_uid TEXT,
  p_days INTEGER,
  p_admin_email TEXT DEFAULT 'admin'
)
RETURNS JSONB AS $$
DECLARE
  v_current_expiry TIMESTAMPTZ;
  v_new_expiry TIMESTAMPTZ;
  v_base_time TIMESTAMPTZ;
BEGIN
  SELECT expires_at INTO v_current_expiry 
  FROM public.user_licenses 
  WHERE uid = p_uid;

  IF v_current_expiry IS NOT NULL AND v_current_expiry > NOW() THEN
    v_base_time := v_current_expiry;
  ELSE
    v_base_time := NOW();
  END IF;

  v_new_expiry := v_base_time + (p_days || ' days')::INTERVAL;

  INSERT INTO public.user_licenses (uid, duration_days, is_unlimited, status, redeemed_at, expires_at, updated_at)
  VALUES (p_uid, p_days::TEXT, FALSE, 'active', NOW(), v_new_expiry, NOW())
  ON CONFLICT (uid) DO UPDATE SET
    duration_days = p_days::TEXT,
    is_unlimited = FALSE,
    status = 'active',
    expires_at = v_new_expiry,
    updated_at = NOW();

  INSERT INTO public.audit_logs (id, admin_email, action, target_uid, details)
  VALUES (
    'audit_' || EXTRACT(EPOCH FROM NOW())::BIGINT || '_' || FLOOR(RANDOM() * 1000)::INT,
    p_admin_email,
    'GRANT_DAYS',
    p_uid,
    jsonb_build_object('days_granted', p_days, 'new_expiry', v_new_expiry)
  );

  RETURN jsonb_build_object('success', TRUE, 'uid', p_uid, 'new_expiry', v_new_expiry);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================================
-- SECTION 25: ROW LEVEL SECURITY & PERMISSIVE POLICIES
-- =========================================================================

-- Enable RLS across all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_number_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_command_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anti_spam_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_deep_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_logs ENABLE ROW LEVEL SECURITY;

-- Clean drop existing policies to ensure clean idempotent run
DROP POLICY IF EXISTS "full_access_users" ON public.users;
DROP POLICY IF EXISTS "full_access_licenses" ON public.licenses;
DROP POLICY IF EXISTS "full_access_user_licenses" ON public.user_licenses;
DROP POLICY IF EXISTS "full_access_group_settings" ON public.group_settings;
DROP POLICY IF EXISTS "full_access_group_rules" ON public.group_rules;
DROP POLICY IF EXISTS "full_access_number_locks" ON public.number_locks;
DROP POLICY IF EXISTS "full_access_user_number_locks" ON public.user_number_locks;
DROP POLICY IF EXISTS "full_access_referral_purchases" ON public.referral_purchases;
DROP POLICY IF EXISTS "full_access_referral_rewards" ON public.referral_rewards;
DROP POLICY IF EXISTS "full_access_referral_claims" ON public.referral_claims;
DROP POLICY IF EXISTS "full_access_system_config" ON public.system_config;
DROP POLICY IF EXISTS "full_access_whatsapp_sessions" ON public.whatsapp_sessions;
DROP POLICY IF EXISTS "full_access_deleted_messages" ON public.deleted_messages;
DROP POLICY IF EXISTS "full_access_bot_command_logs" ON public.bot_command_logs;
DROP POLICY IF EXISTS "full_access_group_warnings" ON public.group_warnings;
DROP POLICY IF EXISTS "full_access_anti_spam_events" ON public.anti_spam_events;
DROP POLICY IF EXISTS "full_access_ai_chat_memories" ON public.ai_chat_memories;
DROP POLICY IF EXISTS "full_access_ai_deep_facts" ON public.ai_deep_facts;
DROP POLICY IF EXISTS "full_access_audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "full_access_media_cache" ON public.media_cache;
DROP POLICY IF EXISTS "full_access_broadcast_logs" ON public.broadcast_logs;

-- Create unified full access policies for backend bot service & frontend users
CREATE POLICY "full_access_users" ON public.users FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_licenses" ON public.licenses FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_user_licenses" ON public.user_licenses FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_group_settings" ON public.group_settings FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_group_rules" ON public.group_rules FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_number_locks" ON public.number_locks FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_user_number_locks" ON public.user_number_locks FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_referral_purchases" ON public.referral_purchases FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_referral_rewards" ON public.referral_rewards FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_referral_claims" ON public.referral_claims FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_system_config" ON public.system_config FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_whatsapp_sessions" ON public.whatsapp_sessions FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_deleted_messages" ON public.deleted_messages FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_bot_command_logs" ON public.bot_command_logs FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_group_warnings" ON public.group_warnings FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_anti_spam_events" ON public.anti_spam_events FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_ai_chat_memories" ON public.ai_chat_memories FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_ai_deep_facts" ON public.ai_deep_facts FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_audit_logs" ON public.audit_logs FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_media_cache" ON public.media_cache FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "full_access_broadcast_logs" ON public.broadcast_logs FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);

-- =========================================================================
-- SECTION 26: CUSTOMER PAYMENT REQUESTS & RECEIPT STORAGE BUCKET
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  amount_ngn NUMERIC NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'automatic',
  provider_name TEXT NOT NULL DEFAULT 'OPay',
  account_number TEXT NOT NULL DEFAULT '9049979183',
  account_name TEXT NOT NULL DEFAULT 'SOLOMON OLADIMEJI',
  receipt_bucket TEXT DEFAULT 'payment-receipts',
  receipt_path TEXT,
  receipt_mime_type TEXT,
  receipt_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'awaiting_receipt',
  session_expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  rejection_reason TEXT,
  license_code TEXT,
  license_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_reference ON public.payment_requests(payment_reference);
CREATE INDEX IF NOT EXISTS idx_payment_requests_user_uid ON public.payment_requests(user_uid);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON public.payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_created_at ON public.payment_requests(created_at DESC);

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "full_access_payment_requests" ON public.payment_requests;
CREATE POLICY "full_access_payment_requests" ON public.payment_requests FOR ALL TO public, anon, authenticated, service_role USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-receipts',
  'payment-receipts',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS "payment_receipts_bucket_access" ON storage.buckets;
CREATE POLICY "payment_receipts_bucket_access"
ON storage.buckets
FOR ALL
TO public, anon, authenticated, service_role
USING (id = 'payment-receipts')
WITH CHECK (id = 'payment-receipts');

DROP POLICY IF EXISTS "payment_receipts_objects_access" ON storage.objects;
CREATE POLICY "payment_receipts_objects_access"
ON storage.objects
FOR ALL
TO public, anon, authenticated, service_role
USING (bucket_id = 'payment-receipts')
WITH CHECK (bucket_id = 'payment-receipts');

INSERT INTO public.system_config (key, value, updated_at)
VALUES (
  'payment_config',
  '{
    "provider": "OPay",
    "accountNumber": "9049979183",
    "accountName": "SOLOMON OLADIMEJI",
    "manualWhatsappNumber": "2349049979183"
  }'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- =========================================================================
-- SECTION 27: LIVE 500MB STORAGE METRICS RPC (NON-DESTRUCTIVE)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_database_storage_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  db_bytes BIGINT;
BEGIN
  SELECT pg_database_size(current_database()) INTO db_bytes;
  RETURN jsonb_build_object(
    'database_size_bytes', COALESCE(db_bytes, 0),
    'quota_bytes', 524288000,
    'measured_at', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_database_storage_stats() TO public, anon, authenticated, service_role;

-- =========================================================================
-- FINISHED: SOLVATECH BOT SCHEMA READY (100% NON-DESTRUCTIVE)
-- =========================================================================
