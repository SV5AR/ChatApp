-- ZChat Database Schema
-- Zero-Knowledge E2EE Messaging Platform
-- Run this in Supabase SQL Editor

-- ============================================================
-- DROP EXISTING OBJECTS (Development - run once to reset)
-- ============================================================
DROP POLICY IF EXISTS "Users can select own media" ON storage.objects;
DROP POLICY IF EXISTS "Users can insert own media" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own media" ON storage.objects;
DROP FUNCTION IF EXISTS public.custom_uid() CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS friendships CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS auth_challenges CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP FUNCTION IF EXISTS get_pending_requests();
DROP FUNCTION IF EXISTS get_friends();

-- ============================================================
-- ENABLE EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- PROFILES TABLE: User identity and public key
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,           -- SHA-256 hash of derived public key (matches user's UUID)
    public_key TEXT NOT NULL,       -- X25519 public key for encryption
    encrypted_username TEXT,        -- Username encrypted with user's own key
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SESSIONS TABLE: short-lived session tokens (non-custodial proof)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    token TEXT UNIQUE, -- legacy plaintext token (kept for compatibility)
    token_hash TEXT UNIQUE, -- SHA-256(token) for safer server-side validation
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

-- Backfill token_hash for existing rows, if any.
UPDATE sessions
SET token_hash = encode(digest(token, 'sha256'), 'hex')
WHERE token IS NOT NULL AND token_hash IS NULL;

ALTER TABLE sessions
ALTER COLUMN token_hash SET NOT NULL;

-- ============================================================
-- AUTH CHALLENGES TABLE: one-time possession proofs for x25519 identity
-- ============================================================
CREATE TABLE IF NOT EXISTS auth_challenges (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    challenge_hash TEXT NOT NULL,
    server_key_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_user ON auth_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);

-- ============================================================
-- AUTH RATE LIMIT TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    blocked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_rate_limit_key_window UNIQUE (key, endpoint, window_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_key_endpoint ON auth_rate_limits(key, endpoint);
CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked_until ON auth_rate_limits(blocked_until);


-- ============================================================
-- FRIENDSHIPS TABLE: Friend requests and connections
-- ============================================================
CREATE TABLE IF NOT EXISTS friendships (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    receiver_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
    encrypted_key_bundle TEXT,      -- Shared secret encrypted for receiver
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,        -- When the request was accepted
    CONSTRAINT unique_friendship UNIQUE (sender_id, receiver_id)
);

-- ============================================================
-- MESSAGES TABLE: E2EE messages between users
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    receiver_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL,  -- NaCl SecretBox ciphertext
    nonce TEXT NOT NULL,               -- Random nonce for encryption
    created_at TIMESTAMPTZ DEFAULT NOW(),
    read_at TIMESTAMPTZ                -- When recipient read the message (for notifications)
);

-- ============================================================
-- INDEXES: For faster queries
-- ============================================================
-- Friendships indexes
CREATE INDEX IF NOT EXISTS idx_friendships_sender ON friendships(sender_id);
CREATE INDEX IF NOT EXISTS idx_friendships_receiver ON friendships(receiver_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_friendships_sender_receiver ON friendships(sender_id, receiver_id);

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_unread ON messages(receiver_id, read_at) WHERE read_at IS NULL;

-- ============================================================
-- RATCHET STATES TABLE: Encrypted ratchet state for forward secrecy
-- ============================================================
-- Stores encrypted ratchet state per conversation.
-- Only the user who owns the conversation can read/write their own ratchet state.
-- The state is encrypted client-side with the user's private key before upload.
CREATE TABLE IF NOT EXISTS ratchet_states (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    conversation_key TEXT NOT NULL,  -- Hash of (user_id + other_user_id) for conversation identification
    encrypted_state TEXT NOT NULL,    -- Encrypted ratchet state (client-side encrypted)
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_ratchet_per_conversation UNIQUE (user_id, conversation_key)
);

CREATE INDEX IF NOT EXISTS idx_ratchet_states_user ON ratchet_states(user_id);
CREATE INDEX IF NOT EXISTS idx_ratchet_states_conversation ON ratchet_states(user_id, conversation_key);

-- ============================================================
-- CUSTOM AUTH FUNCTION
-- ============================================================
-- custom_uid now resolves a validated session token (x-session-token)
-- The client must obtain a short-lived session token from an edge function
-- which verifies a signature produced by the user's private key. This
-- prevents arbitrary client-supplied user IDs from bypassing RLS.
CREATE OR REPLACE FUNCTION public.custom_uid()
RETURNS text AS $$
    SELECT coalesce(
        (
            SELECT user_id
            FROM sessions
            WHERE (
                token_hash = encode(digest(coalesce(current_setting('request.headers', true)::json->>'x-session-token', ''), 'sha256'), 'hex')
                OR token = coalesce(current_setting('request.headers', true)::json->>'x-session-token', '')
            )
            AND expires_at > NOW()
            LIMIT 1
        ),
        ''
    )::text;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog;

-- Service role grants required by Edge auth function in locked-down projects.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friendships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reactions TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_challenges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_rate_limits TO service_role;

-- Client role grants (RLS still enforces row access).
-- Without these GRANTs, PostgREST returns 401/42501 before policies are evaluated.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friendships TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.reactions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ratchet_states TO anon, authenticated;

-- RPC grants used by client.
GRANT EXECUTE ON FUNCTION public.get_pending_requests() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_friends() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_counts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_messages_read(TEXT) TO anon, authenticated;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratchet_states ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PROFILES RLS POLICIES
-- ============================================================

-- Anyone can read profiles (needed for friend discovery)
CREATE POLICY "Anyone can read profiles" ON profiles
    FOR SELECT USING (true);

-- Users can insert their own profile
CREATE POLICY "Users can insert own profile" ON profiles
    FOR INSERT WITH CHECK (public.custom_uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE USING (public.custom_uid() = id);

-- Users can delete their own profile (cascade deletes messages & friendships)
CREATE POLICY "Users can delete own profile" ON profiles
    FOR DELETE USING (public.custom_uid() = id);

-- ============================================================
-- FRIENDSHIPS RLS POLICIES
-- ============================================================

-- Users can see friendships where they are sender or receiver
CREATE POLICY "Users can read own friendships" ON friendships
    FOR SELECT USING (
        sender_id = public.custom_uid() OR 
        receiver_id = public.custom_uid()
    );

-- Users can insert their own friend requests
CREATE POLICY "Users can insert friend requests" ON friendships
    FOR INSERT WITH CHECK (sender_id = public.custom_uid());

-- Users can update friendships they are part of (accept/reject)
CREATE POLICY "Users can update own friendships" ON friendships
    FOR UPDATE USING (
        sender_id = public.custom_uid() OR 
        receiver_id = public.custom_uid()
    );

-- Users can delete friendships they are part of
CREATE POLICY "Users can delete own friendships" ON friendships
    FOR DELETE USING (
        sender_id = public.custom_uid() OR 
        receiver_id = public.custom_uid()
    );

-- ============================================================
-- MESSAGES RLS POLICIES
-- ============================================================

-- Users can only read messages they sent or received
CREATE POLICY "Users can read own messages" ON messages
    FOR SELECT USING (
        sender_id = public.custom_uid() OR 
        receiver_id = public.custom_uid()
    );

-- Users can insert their own messages
CREATE POLICY "Users can insert own messages" ON messages
    FOR INSERT WITH CHECK (sender_id = public.custom_uid());

-- Users can delete their own messages (sent messages)
CREATE POLICY "Users can delete own messages" ON messages
    FOR DELETE USING (sender_id = public.custom_uid());

-- Users can update read_at (mark messages as read)
CREATE POLICY "Users can mark messages read" ON messages
    FOR UPDATE USING (
        receiver_id = public.custom_uid() AND 
        read_at IS NULL
    );

-- ============================================================
-- RATCHET STATES RLS POLICIES
-- ============================================================

CREATE POLICY "Users can read own ratchet states" ON ratchet_states
    FOR SELECT USING (user_id = public.custom_uid());

CREATE POLICY "Users can insert own ratchet states" ON ratchet_states
    FOR INSERT WITH CHECK (user_id = public.custom_uid());

CREATE POLICY "Users can update own ratchet states" ON ratchet_states
    FOR UPDATE USING (user_id = public.custom_uid());

CREATE POLICY "Users can delete own ratchet states" ON ratchet_states
    FOR DELETE USING (user_id = public.custom_uid());

-- ============================================================
-- DATABASE FUNCTIONS
-- ============================================================

-- Get pending friend requests received by current user
CREATE OR REPLACE FUNCTION get_pending_requests()
RETURNS TABLE (
    id UUID,
    sender_id TEXT,
    receiver_id TEXT,
    encrypted_username TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
AS $$
    SELECT 
        f.id, 
        f.sender_id, 
        f.receiver_id,
        p.encrypted_username,
        f.created_at
    FROM friendships f
    LEFT JOIN profiles p ON p.id = f.sender_id
    WHERE f.receiver_id = public.custom_uid() 
    AND f.status = 'pending';
$$;

-- Get accepted friends for current user
CREATE OR REPLACE FUNCTION get_friends()
RETURNS TABLE (
    id UUID,
    friend_id TEXT,
    status TEXT,
    encrypted_key_bundle TEXT,
    created_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
AS $$
    SELECT 
        f.id,
        CASE 
            WHEN f.sender_id = public.custom_uid() THEN f.receiver_id 
            ELSE f.sender_id 
        END AS friend_id,
        f.status,
        f.encrypted_key_bundle,
        f.created_at,
        f.accepted_at
    FROM friendships f
    WHERE (f.sender_id = public.custom_uid() OR f.receiver_id = public.custom_uid())
    AND f.status = 'accepted';
$$;

-- Get unread message count for each friend
CREATE OR REPLACE FUNCTION get_unread_counts()
RETURNS TABLE (
    friend_id TEXT,
    unread_count BIGINT
)
LANGUAGE SQL
SECURITY DEFINER
AS $$
    SELECT 
        CASE 
            WHEN sender_id = public.custom_uid() THEN receiver_id 
            ELSE sender_id 
        END AS friend_id,
        COUNT(*)::BIGINT AS unread_count
    FROM messages
    WHERE receiver_id = public.custom_uid()
    AND read_at IS NULL
    GROUP BY friend_id;
$$;

-- Mark messages as read when user views conversation
CREATE OR REPLACE FUNCTION mark_messages_read(p_friend_id TEXT)
RETURNS void
LANGUAGE SQL
SECURITY DEFINER
AS $$
    UPDATE messages 
    SET read_at = NOW() 
    WHERE receiver_id = public.custom_uid() 
    AND sender_id = p_friend_id 
    AND read_at IS NULL;
$$;

-- ============================================================
-- REACTIONS TABLE (Optional - for message reactions)
-- ============================================================
CREATE TABLE IF NOT EXISTS reactions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    encrypted_emoji TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_reaction UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- Reactions RLS Policies
CREATE POLICY "Anyone can read reactions" ON reactions
    FOR SELECT USING (true);

CREATE POLICY "Users can insert reactions" ON reactions
    FOR INSERT WITH CHECK (user_id = public.custom_uid());

CREATE POLICY "Users can delete own reactions" ON reactions
    FOR DELETE USING (user_id = public.custom_uid());

-- ============================================================
-- STORAGE BUCKET FOR VOICE MESSAGES
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('zchat-media', 'zchat-media', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for zchat-media
CREATE POLICY "Users can select own media" ON storage.objects
    FOR SELECT USING (
        bucket_id = 'zchat-media' AND 
        (storage.foldername(name))[1] = public.custom_uid()
    );

CREATE POLICY "Users can insert own media" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'zchat-media' AND 
        (storage.foldername(name))[1] = public.custom_uid()
    );

CREATE POLICY "Users can delete own media" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'zchat-media' AND 
        (storage.foldername(name))[1] = public.custom_uid()
    );

-- ============================================================
-- SUMMARY OF SCHEMA
-- ============================================================
-- Tables:
--   - profiles: User identities (id = SHA-256 of public key)
--   - friendships: Friend requests/connections with status
--   - messages: E2EE messages with read_at for notifications
--   - reactions: Emoji reactions on messages
--
-- Key Features:
--   - TEXT IDs (not UUID) to match mnemonic-derived UUIDs
--   - RLS policies for SELECT, INSERT, UPDATE, DELETE on all tables
--   - read_at column on messages enables unread notification badges
--   - get_unread_counts() function for chat list notification badges
--   - get_pending_requests() for friend request notifications
--   - Proper indexes for conversation queries
