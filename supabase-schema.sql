-- =========================================================================
-- SOLVATECH BOT - SUPABASE POSTGRESQL DATABASE SCHEMA
-- =========================================================================
-- Run this in your Supabase Project Dashboard -> SQL Editor -> New Query -> Run
-- =========================================================================

-- 1. Users table (Profiles & Referrals)
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  photo_url TEXT,
  referral_code TEXT,
  referred_by TEXT,
  qualifying_sales_ngn NUMERIC DEFAULT 0,
  claimed_days_total INTEGER DEFAULT 0,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Licenses table (Admin-generated license keys)
CREATE TABLE IF NOT EXISTS public.licenses (
  code TEXT PRIMARY KEY,
  duration_days TEXT,
  is_unlimited BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'unused',
  created_by TEXT,
  redeemed_by_uid TEXT,
  redeemed_by_email TEXT,
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  price_ngn NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. User Licenses table (Active customer subscriptions & expiries)
CREATE TABLE IF NOT EXISTS public.user_licenses (
  uid TEXT PRIMARY KEY,
  email TEXT,
  last_license_code TEXT,
  duration_days TEXT,
  is_unlimited BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Group Settings table (Per-user WhatsApp group settings)
CREATE TABLE IF NOT EXISTS public.group_settings (
  safe_user_id TEXT PRIMARY KEY,
  settings JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Group Rules table (Cross-session permanent group rules keyed by WhatsApp Group JID)
CREATE TABLE IF NOT EXISTS public.group_rules (
  group_id TEXT PRIMARY KEY,
  rules JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Number Locks table (Anti-hijack: binds a WhatsApp phone number to a user account)
CREATE TABLE IF NOT EXISTS public.number_locks (
  phone_number TEXT PRIMARY KEY,
  uid TEXT,
  user_email TEXT,
  locked_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Referral Purchases table
CREATE TABLE IF NOT EXISTS public.referral_purchases (
  purchase_id TEXT PRIMARY KEY,
  buyer_uid TEXT,
  buyer_email TEXT,
  referrer_uid TEXT,
  license_code TEXT,
  duration_days TEXT,
  amount_ngn NUMERIC DEFAULT 0,
  is_qualifying BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Referral Rewards table
CREATE TABLE IF NOT EXISTS public.referral_rewards (
  reward_id TEXT PRIMARY KEY,
  referrer_uid TEXT,
  threshold_ngn NUMERIC DEFAULT 0,
  free_days INTEGER DEFAULT 0,
  status TEXT DEFAULT 'earned',
  claimed_at TIMESTAMPTZ,
  claim_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Referral Claims table
CREATE TABLE IF NOT EXISTS public.referral_claims (
  claim_id TEXT PRIMARY KEY,
  user_uid TEXT,
  user_email TEXT,
  days_awarded INTEGER DEFAULT 0,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  previous_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'completed'
);

-- 10. System Configuration table (e.g. backend URL, pricing, global switches)
CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. WhatsApp Sessions table (Persistent Baileys session files to survive restarts)
CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
  safe_user_id TEXT PRIMARY KEY,
  uid TEXT,
  files JSONB DEFAULT '{}'::jsonb,
  file_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Allow Service Role to perform all operations (used by backend)
CREATE POLICY "service_role_all_users" ON public.users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_licenses" ON public.licenses FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_user_licenses" ON public.user_licenses FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_group_settings" ON public.group_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_group_rules" ON public.group_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_number_locks" ON public.number_locks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_referral_purchases" ON public.referral_purchases FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_referral_rewards" ON public.referral_rewards FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_referral_claims" ON public.referral_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_system_config" ON public.system_config FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_whatsapp_sessions" ON public.whatsapp_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
