-- Migration: Drop nonce columns from messages and reactions
-- Date: 2026-04-10
-- Purpose:
--   The nonce columns were used for replay protection under the old session-token auth.
--   With Ed25519 signature-based auth (timestamp ±30s + in-memory nonce tracking),
--   these columns are redundant. Removing them simplifies the schema.

BEGIN;

-- Drop nonce from messages
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'nonce'
  ) THEN
    ALTER TABLE public.messages DROP COLUMN nonce;
  END IF;
END $$;

-- Drop nonce from reactions
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reactions' AND column_name = 'nonce'
  ) THEN
    ALTER TABLE public.reactions DROP COLUMN nonce;
  END IF;
END $$;

-- Drop action_nonces table if it somehow still exists
DROP TABLE IF EXISTS public.action_nonces CASCADE;

COMMIT;
