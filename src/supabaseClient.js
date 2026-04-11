import { createClient } from "@supabase/supabase-js";

// CRITICAL: Load from environment variables, never hardcode
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ CRITICAL: Missing Supabase environment variables!");
  console.error(
    "Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env file",
  );
  throw new Error("Supabase configuration incomplete");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: {
      Accept: "application/json",
    },
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

if (typeof window !== "undefined" && window.__CHAT_DEBUG__ === true) {
  console.log("[Supabase] Client initialized (DBG):", SUPABASE_URL);
}

/**
 * Security Notes:
 *
 * 1. ANON KEY SECURITY:
 *    - This key is used for Realtime subscriptions only
 *    - All mutations go through the edge function (Ed25519 signature auth)
 *    - No session tokens are used — authorization is signature-based
 *
 * 2. RLS:
 *    - SELECT policies allow anon access for Realtime delivery
 *    - All mutations are handled by the edge function (bypasses RLS via service_role)
 *
 * 3. ENV VARIABLES:
 *    - .env file is NEVER committed to git
 *    - .gitignore prevents accidental leaks
 */
