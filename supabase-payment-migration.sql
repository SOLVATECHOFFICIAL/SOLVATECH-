-- ============================================================================
-- SOLVATECH BOT — CUSTOMER PAYMENT & LICENSE PURCHASE SYSTEM MIGRATION
-- Run this migration in your Supabase SQL Editor -> New Query -> Run
-- Preserves all existing tables and data.
-- ============================================================================

-- 1. PAYMENT REQUESTS TABLE
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

-- 2. INDEXES FOR FAST LOOKUPS & ADMIN QUEUE
CREATE INDEX IF NOT EXISTS idx_payment_requests_reference ON public.payment_requests(payment_reference);
CREATE INDEX IF NOT EXISTS idx_payment_requests_user_uid ON public.payment_requests(user_uid);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON public.payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_created_at ON public.payment_requests(created_at DESC);

-- 3. ROW LEVEL SECURITY (Server uses Service Role Key for full administrative control)
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

-- 4. DEDICATED SUPABASE STORAGE BUCKET FOR RECEIPTS (No Base64 in PostgreSQL)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-receipts',
  'payment-receipts',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 5. SEED DEFAULT PAYMENT CONFIGURATION IN SYSTEM_CONFIG
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
