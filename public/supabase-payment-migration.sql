-- ============================================================================
-- SOLVATECH BOT — CUSTOMER PAYMENT & LICENSE PURCHASE SYSTEM MIGRATION
-- Copy & Paste this into your Supabase SQL Editor -> New Query -> Run
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

-- 3. ROW LEVEL SECURITY & ACCESS POLICIES FOR PAYMENT_REQUESTS
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "full_access_payment_requests" ON public.payment_requests;
CREATE POLICY "full_access_payment_requests"
ON public.payment_requests
FOR ALL
TO public, anon, authenticated, service_role
USING (true)
WITH CHECK (true);

-- 4. DEDICATED SUPABASE STORAGE BUCKET FOR RECEIPTS (Public Read so Receipt Images Always Render)
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

-- 5. SUPABASE STORAGE POLICIES FOR RECEIPT UPLOAD, VIEW & DELETE
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

-- 6. SEED DEFAULT PAYMENT CONFIGURATION IN SYSTEM_CONFIG
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

-- 7. SEED OFFICIAL 9 CUSTOMER PLANS + ADMIN UNLIMITED IN SYSTEM_CONFIG
INSERT INTO public.system_config (key, value, updated_at)
VALUES (
  'license_plans',
  '{
    "plans": [
      { "id": "1d", "days": 1, "name": "1 Day", "priceNgn": 200, "price": 200 },
      { "id": "3d", "days": 3, "name": "3 Days", "priceNgn": 500, "price": 500 },
      { "id": "7d", "days": 7, "name": "7 Days", "priceNgn": 1000, "price": 1000 },
      { "id": "14d", "days": 14, "name": "14 Days", "priceNgn": 2000, "price": 2000 },
      { "id": "30d", "days": 30, "name": "30 Days", "priceNgn": 4000, "price": 4000 },
      { "id": "60d", "days": 60, "name": "2 Months", "priceNgn": 8000, "price": 8000 },
      { "id": "90d", "days": 90, "name": "3 Months", "priceNgn": 12000, "price": 12000 },
      { "id": "180d", "days": 180, "name": "6 Months", "priceNgn": 24000, "price": 24000 },
      { "id": "365d", "days": 365, "name": "12 Months", "priceNgn": 48000, "price": 48000 },
      { "id": "unlimited", "days": "Unlimited", "name": "Unlimited Lifetime", "priceNgn": 0, "price": 0, "isUnlimited": true }
    ]
  }'::jsonb,
  NOW()
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();
