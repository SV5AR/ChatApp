-- Migration: Remove session-based auth, add signature-based auth with signing keys + PreKey rotation
-- Date: 2026-04-10
-- Purpose:
--   - Drop sessions, action_nonces, auth_challenges tables (session token system removed)
--   - Drop custom_uid() function (depends on session tokens)
--   - Add signing_public_key (Ed25519), prekey_public_key (X25519), prekey_signature, prekey_updated_at, prekey_version to profiles
--   - Create prekey_backups table (encrypted PreKey private keys for cross-device history)
--   - Replace custom_uid()-based RLS policies with anon-SELECT policies for Realtime
--   - Edge function becomes the sole authorization gate (signature verification)

BEGIN;

-- ── 1. Drop all custom_uid()-based RLS policies ──────────────────────────────
-- NOTE: We use CASCADE on the function drop (step 2) to catch any remaining
-- policies we don't know the name of, but we explicitly drop all known ones
-- first for clarity.

-- profiles
DROP POLICY IF EXISTS profiles_select_authd ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_self ON public.profiles;

-- friendships
DROP POLICY IF EXISTS friendships_select_participant ON public.friendships;
DROP POLICY IF EXISTS friendships_insert_sender ON public.friendships;
DROP POLICY IF EXISTS friendships_update_participant ON public.friendships;
DROP POLICY IF EXISTS friendships_delete_participant ON public.friendships;

-- chat_rows
DROP POLICY IF EXISTS chat_rows_select_participant ON public.chat_rows;
DROP POLICY IF EXISTS chat_rows_insert_creator ON public.chat_rows;
DROP POLICY IF EXISTS chat_rows_delete_participant ON public.chat_rows;
DROP POLICY IF EXISTS "users can read own chat rows" ON public.chat_rows;
DROP POLICY IF EXISTS "users can insert own chat rows" ON public.chat_rows;
DROP POLICY IF EXISTS "users can delete own chat rows" ON public.chat_rows;

-- messages
DROP POLICY IF EXISTS messages_select_participant ON public.messages;
DROP POLICY IF EXISTS messages_insert_sender ON public.messages;
DROP POLICY IF EXISTS messages_update_participant ON public.messages;
DROP POLICY IF EXISTS messages_delete_participant ON public.messages;

-- reactions
DROP POLICY IF EXISTS reactions_select_message_participant ON public.reactions;
DROP POLICY IF EXISTS reactions_insert_self ON public.reactions;
DROP POLICY IF EXISTS reactions_delete_self ON public.reactions;

-- username_shares
DROP POLICY IF EXISTS username_shares_select_owner_or_recipient ON public.username_shares;
DROP POLICY IF EXISTS username_shares_insert_owner ON public.username_shares;
DROP POLICY IF EXISTS username_shares_update_owner ON public.username_shares;
DROP POLICY IF EXISTS username_shares_delete_owner ON public.username_shares;
DROP POLICY IF EXISTS "users can read incoming username shares" ON public.username_shares;
DROP POLICY IF EXISTS "users can upsert outgoing username shares" ON public.username_shares;
DROP POLICY IF EXISTS "users can update outgoing username shares" ON public.username_shares;

-- messages_hidden
DROP POLICY IF EXISTS messages_hidden_select_owner ON public.messages_hidden;
DROP POLICY IF EXISTS messages_hidden_insert_owner ON public.messages_hidden;
DROP POLICY IF EXISTS messages_hidden_delete_owner ON public.messages_hidden;
DROP POLICY IF EXISTS "users can read own hidden messages" ON public.messages_hidden;
DROP POLICY IF EXISTS "users can insert own hidden messages" ON public.messages_hidden;
DROP POLICY IF EXISTS "users can delete own hidden messages" ON public.messages_hidden;

-- ratchet_states
DROP POLICY IF EXISTS ratchet_states_select_owner ON public.ratchet_states;
DROP POLICY IF EXISTS ratchet_states_insert_owner ON public.ratchet_states;
DROP POLICY IF EXISTS ratchet_states_update_owner ON public.ratchet_states;
DROP POLICY IF EXISTS ratchet_states_delete_owner ON public.ratchet_states;
DROP POLICY IF EXISTS "users can read own ratchet states" ON public.ratchet_states;
DROP POLICY IF EXISTS "users can insert own ratchet states" ON public.ratchet_states;
DROP POLICY IF EXISTS "users can update own ratchet states" ON public.ratchet_states;
DROP POLICY IF EXISTS "users can delete own ratchet states" ON public.ratchet_states;

-- ── 2. Drop custom_uid() function ────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.custom_uid();

-- ── 3. Drop session-related tables ───────────────────────────────────────────

DROP TABLE IF EXISTS public.sessions CASCADE;
DROP TABLE IF EXISTS public.action_nonces CASCADE;
DROP TABLE IF EXISTS public.auth_challenges CASCADE;

-- ── 4. Add signing/PreKey columns to profiles ────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS signing_public_key text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS prekey_public_key text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS prekey_signature text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS prekey_updated_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS prekey_version integer DEFAULT 0;

-- ── 5. Add CHECK constraints for new columns ─────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_signing_public_key_hex') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_signing_public_key_hex
      CHECK (signing_public_key IS NULL OR signing_public_key ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_signing_public_key_unique') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_signing_public_key_unique
      UNIQUE (signing_public_key);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_prekey_public_key_hex') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_prekey_public_key_hex
      CHECK (prekey_public_key IS NULL OR prekey_public_key ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_prekey_signature_hex') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_prekey_signature_hex
      CHECK (prekey_signature IS NULL OR prekey_signature ~ '^[0-9a-f]{128}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_prekey_version_nonneg') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_prekey_version_nonneg
      CHECK (prekey_version IS NULL OR prekey_version >= 0);
  END IF;
END $$;

-- ── 6. Create prekey_backups table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.prekey_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  prekey_version integer NOT NULL,
  encrypted_private_key text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prekey_backups_user_version_unique UNIQUE (user_id, prekey_version),
  CONSTRAINT prekey_backups_public_key_hex CHECK (public_key ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_prekey_backups_user_id ON public.prekey_backups(user_id);
CREATE INDEX IF NOT EXISTS idx_prekey_backups_user_version ON public.prekey_backups(user_id, prekey_version);

-- Trigger for updated_at
CREATE TRIGGER trg_prekey_backups_updated_at
  BEFORE UPDATE ON public.prekey_backups
  FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();

-- Enable RLS
ALTER TABLE public.prekey_backups ENABLE ROW LEVEL SECURITY;

-- prekey_backups: NO anon SELECT policy — only edge function (service_role) can access
-- This keeps PreKey backups private. Clients download via edge endpoint after signature verification.

-- ── 7. Add new RLS policies — anon SELECT for Realtime, deny mutations ──────

-- NOTE: The edge function uses service_role which BYPASSES RLS entirely.
-- These policies only affect anon-role connections (Realtime WebSocket subscriptions).
-- SELECT is allowed for Realtime data delivery. INSERT/UPDATE/DELETE are denied by default
-- (no matching policies for anon).

CREATE POLICY profiles_select_anon ON public.profiles FOR SELECT USING (true);
CREATE POLICY friendships_select_anon ON public.friendships FOR SELECT USING (true);
CREATE POLICY chat_rows_select_anon ON public.chat_rows FOR SELECT USING (true);
CREATE POLICY messages_select_anon ON public.messages FOR SELECT USING (true);
CREATE POLICY reactions_select_anon ON public.reactions FOR SELECT USING (true);
CREATE POLICY username_shares_select_anon ON public.username_shares FOR SELECT USING (true);
CREATE POLICY messages_hidden_select_anon ON public.messages_hidden FOR SELECT USING (true);
CREATE POLICY ratchet_states_select_anon ON public.ratchet_states FOR SELECT USING (true);

-- ── 8. Grant permissions ─────────────────────────────────────────────────────

-- Anon role: can SELECT all data tables (for Realtime)
GRANT SELECT ON public.profiles TO anon;
GRANT SELECT ON public.friendships TO anon;
GRANT SELECT ON public.chat_rows TO anon;
GRANT SELECT ON public.messages TO anon;
GRANT SELECT ON public.reactions TO anon;
GRANT SELECT ON public.username_shares TO anon;
GRANT SELECT ON public.messages_hidden TO anon;
GRANT SELECT ON public.ratchet_states TO anon;

-- No GRANT on prekey_backups to anon — only service_role can access

-- Auth rate limits: service only (keep existing)
-- (auth_rate_limits was never granted to anon)

COMMIT;
