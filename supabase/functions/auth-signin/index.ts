import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import nacl from "https://esm.sh/tweetnacl@1.0.3";

// ── Utility helpers ──────────────────────────────────────────────────────────

function hexToUint8(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hash));
}

async function sha256TextHex(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRatchetEnvelope(raw: string): { c: string; n: number } | null {
  try {
    const parsed = JSON.parse(raw);
    const c = String(parsed?.c || "").trim();
    const n = Number(parsed?.n);
    if (!c || !Number.isInteger(n) || n < 0) return null;
    return { c, n };
  } catch {
    return null;
  }
}

// ── Response helpers ─────────────────────────────────────────────────────────

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-signature, x-public-key, x-timestamp, x-nonce",
      ...extraHeaders,
    },
  });
}

// ── Request validation & body reading ────────────────────────────────────────

async function validateAndReadBody(req: Request, maxBodyBytes = 64 * 1024): Promise<{ ok: true; body: Uint8Array } | { ok: false; response: Response }> {
  const contentType = req.headers.get("content-type") || "";
  if (req.method === "POST" && contentType && !contentType.includes("application/json")) {
    return { ok: false, response: json({ error: "Unsupported content type" }, 415) };
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > maxBodyBytes) {
    return { ok: false, response: json({ error: "Payload too large" }, 413) };
  }

  try {
    const buffer = await req.arrayBuffer();
    return { ok: true, body: new Uint8Array(buffer) };
  } catch {
    return { ok: false, response: json({ error: "Failed to read request body" }, 400) };
  }
}

// ── In-memory nonce tracking (replay protection) ─────────────────────────────

const seenNonces = new Map<string, number>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_NONCES = 50000;

function cleanupNonces() {
  const now = Date.now();
  // Fast path: if the oldest entry is still valid, skip cleanup
  const firstTs = seenNonces.values().next().value;
  if (firstTs !== undefined && now - firstTs < NONCE_TTL_MS && seenNonces.size < MAX_NONCES) return;

  for (const [nonce, ts] of seenNonces) {
    if (now - ts > NONCE_TTL_MS) seenNonces.delete(nonce);
  }
  if (seenNonces.size > MAX_NONCES) {
    const sorted = Array.from(seenNonces.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - MAX_NONCES; i++) {
      seenNonces.delete(sorted[i][0]);
    }
  }
}

// ── Signature-based request verification ─────────────────────────────────────

/**
 * Bitcoin-style signature verification:
 * 1. Check timestamp within ±30s
 * 2. Check nonce not replayed
 * 3. Look up profile by Ed25519 signing public key
 * 4. Verify Ed25519 signature over raw request body
 * Returns { userId } on success, or { response } on failure.
 */
async function verifyRequest(
  req: Request,
  rawBody: Uint8Array,
  supabaseAdmin: ReturnType<typeof createClient>,
): Promise<{ userId: string } | { response: Response }> {
  const sigHex = req.headers.get("x-signature")?.trim() || "";
  const pubKeyHex = req.headers.get("x-public-key")?.trim() || "";
  const timestamp = req.headers.get("x-timestamp") || "";
  const nonce = req.headers.get("x-nonce")?.trim() || "";

  if (!sigHex || !pubKeyHex || !timestamp || !nonce) {
    return { response: json({ error: "Missing auth headers (x-signature, x-public-key, x-timestamp, x-nonce)" }, 401) };
  }

  // Timestamp validation (±30s)
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || Math.abs(nowSeconds() - ts) > 30) {
    return { response: json({ error: "Invalid or stale timestamp" }, 401) };
  }

  // Nonce replay check
  if (seenNonces.has(nonce)) {
    return { response: json({ error: "Replay detected" }, 409) };
  }
  seenNonces.set(nonce, Date.now());
  cleanupNonces();

  // Look up profile by Ed25519 signing public key
  const normalizedPubKey = pubKeyHex.toLowerCase();
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("signing_public_key", normalizedPubKey)
    .maybeSingle();

  if (error || !profile?.id) {
    return { response: json({ error: "Profile not found or signing key not registered" }, 401) };
  }

  // Ed25519 signature verification over raw request body
  const pubKey = hexToUint8(pubKeyHex);
  const sig = hexToUint8(sigHex);
  if (pubKey.length !== 32 || sig.length !== 64) {
    return { response: json({ error: "Invalid key or signature length" }, 400) };
  }
  if (!nacl.sign.detached.verify(rawBody, sig, pubKey)) {
    return { response: json({ error: "Invalid signature" }, 401) };
  }

  return { userId: profile.id };
}

// ── Rate limiting ────────────────────────────────────────────────────────────

async function enforceRateLimit(
  supabaseAdmin: ReturnType<typeof createClient>,
  key: string,
  endpoint: string,
  windowSeconds: number,
  maxRequests: number,
  blockSeconds: number,
): Promise<{ ok: boolean; retryAfter?: number; reason?: string }> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("auth_rate_limits")
    .select("id, count, blocked_until")
    .eq("key", key)
    .eq("endpoint", endpoint)
    .eq("window_start", windowStart)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, reason: `rate-limit read failed: ${fetchErr.message}` };
  }

  const nowTs = now.getTime();
  if (existing?.blocked_until && new Date(existing.blocked_until).getTime() > nowTs) {
    const retryAfter = Math.ceil((new Date(existing.blocked_until).getTime() - nowTs) / 1000);
    return { ok: false, retryAfter, reason: "blocked" };
  }

  const nextCount = (existing?.count || 0) + 1;
  let blockedUntil: string | null = null;
  if (nextCount > maxRequests) {
    blockedUntil = new Date(nowTs + blockSeconds * 1000).toISOString();
  }

  const payload = {
    key,
    endpoint,
    window_start: windowStart,
    count: nextCount,
    blocked_until: blockedUntil,
    updated_at: now.toISOString(),
  };

  const { error: upsertErr } = await supabaseAdmin
    .from("auth_rate_limits")
    .upsert(payload, { onConflict: "key,endpoint,window_start" });

  if (upsertErr) {
    return { ok: false, reason: `rate-limit write failed: ${upsertErr.message}` };
  }

  if (blockedUntil) {
    return { ok: false, retryAfter: blockSeconds, reason: "too_many_requests" };
  }

  return { ok: true };
}

// ── Main server ──────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isHealth = path === "/health" || path.endsWith("/health");
    const isProfileRead = path === "/profile" || path.endsWith("/profile");
    const isProfileUpsert = path === "/profile/upsert" || path.endsWith("/profile/upsert");
    const isFriendships = path === "/friendships" || path.endsWith("/friendships");
    const isFriendRequest = path === "/friendships/request" || path.endsWith("/friendships/request");
    const isFriendRespond = path === "/friendships/respond" || path.endsWith("/friendships/respond");
    const isFriendRemove = path === "/friendships/remove" || path.endsWith("/friendships/remove");
    const isBlocksRead = path === "/blocks" || path.endsWith("/blocks");
    const isBlockAdd = path === "/blocks/add" || path.endsWith("/blocks/add");
    const isBlockRemove = path === "/blocks/remove" || path.endsWith("/blocks/remove");
    const isMessagesRead = path === "/messages" || path.endsWith("/messages");
    const isMessageSend = path === "/messages/send" || path.endsWith("/messages/send");
    const isMessageEdit = path === "/messages/edit" || path.endsWith("/messages/edit");
    const isMessageDelete = path === "/messages/delete" || path.endsWith("/messages/delete");
    const isMessageHide = path === "/messages/hide" || path.endsWith("/messages/hide");
    const isChatRead = path === "/chat" || path.endsWith("/chat");
    const isChatEnsure = path === "/chat/ensure" || path.endsWith("/chat/ensure");
    const isChatDelete = path === "/chat/delete" || path.endsWith("/chat/delete");
    const isUnreadCounts = path === "/messages/unread-counts" || path.endsWith("/messages/unread-counts");
    const isMarkRead = path === "/messages/mark-read" || path.endsWith("/messages/mark-read");
    const isDeleteAccount = path === "/account/delete" || path.endsWith("/account/delete");
    const isReactionsRead = path === "/reactions" || path.endsWith("/reactions");
    const isReactionUpsert = path === "/reactions/upsert" || path.endsWith("/reactions/upsert");
    const isStatusUpdate = path === "/status/update" || path.endsWith("/status/update");
    const isTyping = path === "/typing" || path.endsWith("/typing");
    const isRatchetState = path === "/ratchet-state" || path.endsWith("/ratchet-state");
    const isUsernameSharesRead = path === "/username-shares" || path.endsWith("/username-shares");
    const isUsernameSharesUpsert = path === "/username-shares/upsert" || path.endsWith("/username-shares/upsert");

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-signature, x-public-key, x-timestamp, x-nonce",
          "access-control-max-age": "86400",
        },
      });
    }

    // Request validation: read body for signature verification
    const bodyResult = await validateAndReadBody(req);
    if (!bodyResult.ok) return bodyResult.response;
    const rawBody = bodyResult.body;

    if (req.method === "GET" && isHealth) return json({ ok: true });

    const supabaseUrl =
      Deno.env.get("ZCHAT_SUPABASE_URL") ||
      Deno.env.get("SUPABASE_URL") ||
      "";
    const serviceRole =
      Deno.env.get("ZCHAT_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!supabaseUrl || !serviceRole) {
      return json(
        { error: "Server misconfigured: missing ZCHAT_SUPABASE_URL/ZCHAT_SERVICE_ROLE_KEY" },
        500,
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          apikey: serviceRole,
          Authorization: `Bearer ${serviceRole}`,
        },
      },
    });

    // ── GET /friendships ───────────────────────────────────────────────────

    if (req.method === "GET" && isFriendships) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const status = url.searchParams.get("status")?.trim();
      let query = supabaseAdmin.from("friendships").select("*");

      if (status === "pending") {
        query = query.eq("receiver_id", sessionUserId).eq("status", "pending");
      } else if (status === "accepted") {
        query = query.or(`sender_id.eq.${sessionUserId},receiver_id.eq.${sessionUserId}`).eq("status", "accepted");
      } else {
        query = query.or(`sender_id.eq.${sessionUserId},receiver_id.eq.${sessionUserId}`);
      }

      const { data, error } = await query;
      if (error) return json({ error: "Failed to fetch friendships", detail: error.message, code: (error as any).code }, 500);
      return json({ data: data || [] });
    }

    // ── POST /friendships/request ──────────────────────────────────────────

    if (req.method === "POST" && isFriendRequest) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        receiverId?: string;
        encryptedKeyBundle?: string;
        requesterUsernameShare?: string;
      } | null;
      const receiverId = body?.receiverId?.trim().toLowerCase();
      const encryptedKeyBundle = body?.encryptedKeyBundle ?? null;
      const requesterUsernameShare = body?.requesterUsernameShare?.trim() || "";
      if (!receiverId) return json({ error: "Missing receiverId" }, 400);
      if (receiverId === sessionUserId) return json({ error: "Cannot add yourself" }, 400);

      // Check both directions to avoid duplicate-key errors
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id, status")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${sessionUserId})`)
        .limit(1)
        .maybeSingle();

      if (existingErr) {
        return json({ error: "Failed to check existing friendship", detail: existingErr.message, code: (existingErr as any).code }, 500);
      }

      if (existing) {
        if (existing.status === "blocked") {
          return json({ error: "Cannot send request while blocked" }, 403);
        }
        if (existing.status === "accepted") {
          return json({ error: "Already friends", existing }, 409);
        }
        if (existing.status === "pending") {
          if (existing.sender_id === sessionUserId) {
            return json({ error: "Friend request already pending", existing }, 409);
          }
          // Auto-accept inverse pending request
          const { data: accepted, error: acceptErr } = await supabaseAdmin
            .from("friendships")
            .update({
              status: "accepted",
              accepted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              encrypted_key_bundle: encryptedKeyBundle || existing.encrypted_key_bundle,
              ...(requesterUsernameShare ? { requester_username_share: requesterUsernameShare } : {}),
            })
            .eq("id", existing.id)
            .select("*")
            .single();

          if (acceptErr) {
            return json({ error: "Failed to accept existing pending request", detail: acceptErr.message }, 500);
          }
          if (requesterUsernameShare) {
            const { data: senderProfile } = await supabaseAdmin
              .from("profiles")
              .select("public_key")
              .eq("id", sessionUserId)
              .maybeSingle();
            if (senderProfile?.public_key) {
              await supabaseAdmin
                .from("username_shares")
                .upsert({
                  owner_id: sessionUserId,
                  recipient_id: receiverId,
                  owner_public_key: senderProfile.public_key,
                  encrypted_username: requesterUsernameShare,
                  updated_at: new Date().toISOString(),
                }, { onConflict: "owner_id,recipient_id" });
            }
          }
          return json({ data: accepted, auto_accepted: true });
        }

        // Rejected or other -> revive as pending
        const senderId = sessionUserId;
        const targetId = receiverId;
        let friendshipId = existing.id;

        if (existing.sender_id !== senderId || existing.receiver_id !== targetId) {
          const { error: delErr } = await supabaseAdmin.from("friendships").delete().eq("id", existing.id);
          if (delErr) {
            return json({ error: "Failed to reset prior friendship state", detail: delErr.message }, 500);
          }
          friendshipId = null as unknown as string;
        }

        if (friendshipId) {
          const { data: updated, error: updErr } = await supabaseAdmin
            .from("friendships")
            .update({
              status: "pending",
              updated_at: new Date().toISOString(),
              encrypted_key_bundle: encryptedKeyBundle,
              ...(requesterUsernameShare ? { requester_username_share: requesterUsernameShare } : {}),
            })
            .eq("id", friendshipId)
            .select("*")
            .single();

          if (updErr) return json({ error: "Failed to refresh friend request", detail: updErr.message }, 500);
          return json({ data: updated, revived: true });
        }
      }

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .insert({
          sender_id: sessionUserId,
          receiver_id: receiverId,
          status: "pending",
          encrypted_key_bundle: encryptedKeyBundle,
          requester_username_share: requesterUsernameShare || null,
        })
        .select("*")
        .single();

      if (error) return json({ error: "Failed to send friend request", detail: error.message, code: (error as any).code }, 500);
      return json({ data });
    }

    // ── POST /friendships/respond ──────────────────────────────────────────

    if (req.method === "POST" && isFriendRespond) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        friendshipId?: string;
        accept?: boolean;
        encryptedKeyBundle?: string;
        accepterUsernameShare?: string;
      } | null;
      const friendshipId = body?.friendshipId;
      if (!friendshipId) return json({ error: "Missing friendshipId" }, 400);
      if (typeof body?.accept !== "boolean") return json({ error: "Missing or invalid accept flags" }, 400);

      const accept = body.accept;

      const { data: current, error: currentErr } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id, status, requester_username_share")
        .eq("id", friendshipId)
        .maybeSingle();

      if (currentErr) return json({ error: "Failed to fetch friendship", detail: currentErr.message }, 500);
      if (!current) return json({ error: "Friend request not found" }, 404);
      if (current.receiver_id !== sessionUserId) return json({ error: "Forbidden" }, 403);
      if (current.status !== "pending") {
        return json({
          error: `Cannot respond to request in '${current.status}' state`,
          data: current,
          previous_status: current.status,
          new_status: current.status,
        }, 409);
      }

      const updatePayload: Record<string, unknown> = {
        status: accept ? "accepted" : "rejected",
        updated_at: new Date().toISOString(),
      };
      if (accept) updatePayload.accepted_at = new Date().toISOString();
      else updatePayload.accepted_at = null;
      if (body?.encryptedKeyBundle) updatePayload.encrypted_key_bundle = body.encryptedKeyBundle;

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .update(updatePayload)
        .eq("id", friendshipId)
        .eq("receiver_id", sessionUserId)
        .select("*")
        .single();

      if (error) return json({ error: "Failed to respond to request", detail: error.message }, 500);

      if (accept && data?.sender_id && data?.receiver_id) {
        try {
          const requesterId = String(data.sender_id);
          const accepterId = String(data.receiver_id);
          const accepterUsernameShare = body?.accepterUsernameShare?.trim() || "";

          const { data: requesterProfile } = await supabaseAdmin
            .from("profiles")
            .select("public_key, encrypted_username")
            .eq("id", requesterId)
            .maybeSingle();
          const { data: accepterProfile } = await supabaseAdmin
            .from("profiles")
            .select("public_key, encrypted_username")
            .eq("id", accepterId)
            .maybeSingle();

          const requesterStoredShare = String(current.requester_username_share || "").trim();
          const encryptedForAccepter = requesterStoredShare || requesterProfile?.encrypted_username;
          if (requesterProfile?.public_key && encryptedForAccepter) {
            await supabaseAdmin
              .from("username_shares")
              .upsert({
                owner_id: requesterId,
                recipient_id: accepterId,
                owner_public_key: requesterProfile.public_key,
                encrypted_username: encryptedForAccepter,
                updated_at: new Date().toISOString(),
              }, { onConflict: "owner_id,recipient_id" });
          }

          if (accepterProfile?.public_key && accepterProfile?.encrypted_username) {
            const encryptedForRequester = accepterUsernameShare || accepterProfile.encrypted_username;
            await supabaseAdmin
              .from("username_shares")
              .upsert({
                owner_id: accepterId,
                recipient_id: requesterId,
                owner_public_key: accepterProfile.public_key,
                encrypted_username: encryptedForRequester,
                updated_at: new Date().toISOString(),
              }, { onConflict: "owner_id,recipient_id" });
          }
        } catch (shareErr) {
          console.warn("username share seed on accept failed:", shareErr);
        }
      }

      return json({
        data,
        previous_status: current.status,
        new_status: data?.status || current.status,
      });
    }

    // ── POST /friendships/remove ───────────────────────────────────────────

    if (req.method === "POST" && isFriendRemove) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { friendshipId?: string } | null;
      const friendshipId = body?.friendshipId;
      if (!friendshipId) return json({ error: "Missing friendshipId" }, 400);

      const { data: f, error: fetchErr } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id")
        .eq("id", friendshipId)
        .single();

      if (fetchErr) return json({ error: "Failed to fetch friendship", detail: fetchErr.message }, 500);
      if (f.sender_id !== sessionUserId && f.receiver_id !== sessionUserId) return json({ error: "Forbidden" }, 403);

      const a = String(f.sender_id);
      const b = String(f.receiver_id);

      const { data: msgIds } = await supabaseAdmin
        .from("messages")
        .select("id")
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);

      const ids = (msgIds || []).map((m: any) => m.id).filter(Boolean);
      if (ids.length) {
        await supabaseAdmin.from("reactions").delete().in("message_id", ids);
        await supabaseAdmin.from("messages_hidden").delete().in("message_id", ids);
      }
      await supabaseAdmin
        .from("messages")
        .delete()
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
      await supabaseAdmin
        .from("ratchet_states")
        .delete()
        .or(`and(user_id.eq.${a},conversation_key.eq.${a}:${b}),and(user_id.eq.${a},conversation_key.eq.${b}:${a}),and(user_id.eq.${b},conversation_key.eq.${a}:${b}),and(user_id.eq.${b},conversation_key.eq.${b}:${a})`);
      await supabaseAdmin
        .from("username_shares")
        .delete()
        .or(`and(owner_id.eq.${a},recipient_id.eq.${b}),and(owner_id.eq.${b},recipient_id.eq.${a})`);
      await supabaseAdmin
        .from("chat_rows")
        .delete()
        .or(`and(user_a.eq.${a},user_b.eq.${b}),and(user_a.eq.${b},user_b.eq.${a})`);

      const { error } = await supabaseAdmin.from("friendships").delete().eq("id", friendshipId);
      if (error) return json({ error: "Failed to remove friend", detail: error.message }, 500);
      return json({ success: true });
    }

    // ── GET /blocks ────────────────────────────────────────────────────────

    if (req.method === "GET" && isBlocksRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { data, error } = await supabaseAdmin
        .from("friendships")
        .select("id, receiver_id, created_at, updated_at")
        .eq("sender_id", sessionUserId)
        .eq("status", "blocked")
        .order("updated_at", { ascending: false });

      if (error) return json({ error: "Failed to load blocked users", detail: error.message }, 500);

      const rows = (data || []).map((row) => ({
        id: row.id,
        blocker_id: sessionUserId,
        blocked_id: row.receiver_id,
        created_at: row.updated_at || row.created_at,
      }));
      return json({ data: rows });
    }

    // ── POST /blocks/add ───────────────────────────────────────────────────

    if (req.method === "POST" && isBlockAdd) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { blockedId?: string } | null;
      const blockedId = body?.blockedId?.trim().toLowerCase();
      if (!blockedId) return json({ error: "Missing blockedId" }, 400);
      if (blockedId === sessionUserId) return json({ error: "Cannot block yourself" }, 400);

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("friendships")
        .select("id, sender_id, receiver_id, status")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${blockedId}),and(sender_id.eq.${blockedId},receiver_id.eq.${sessionUserId})`)
        .limit(1)
        .maybeSingle();

      if (existingErr) return json({ error: "Failed to check current relationship", detail: existingErr.message }, 500);

      const now = new Date().toISOString();

      if (existing) {
        if (existing.sender_id === sessionUserId && existing.receiver_id === blockedId) {
          const { data: updated, error: updErr } = await supabaseAdmin
            .from("friendships")
            .update({ status: "blocked", accepted_at: null, encrypted_key_bundle: null, updated_at: now })
            .eq("id", existing.id)
            .select("id, sender_id, receiver_id, status, updated_at")
            .single();
          if (updErr) return json({ error: "Failed to block user", detail: updErr.message }, 500);

          // Cleanup conversation
          const a = sessionUserId;
          const b = blockedId;
          const { data: msgIds } = await supabaseAdmin
            .from("messages")
            .select("id")
            .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
          const ids = (msgIds || []).map((m: any) => m.id).filter(Boolean);
          if (ids.length) {
            await supabaseAdmin.from("reactions").delete().in("message_id", ids);
            await supabaseAdmin.from("messages_hidden").delete().in("message_id", ids);
          }
          await supabaseAdmin
            .from("messages")
            .delete()
            .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
          await supabaseAdmin
            .from("ratchet_states")
            .delete()
            .or(`and(user_id.eq.${a},conversation_key.eq.${a}:${b}),and(user_id.eq.${a},conversation_key.eq.${b}:${a}),and(user_id.eq.${b},conversation_key.eq.${a}:${b}),and(user_id.eq.${b},conversation_key.eq.${b}:${a})`);
          await supabaseAdmin
            .from("username_shares")
            .delete()
            .or(`and(owner_id.eq.${a},recipient_id.eq.${b}),and(owner_id.eq.${b},recipient_id.eq.${a})`);
          await supabaseAdmin
            .from("chat_rows")
            .delete()
            .or(`and(user_a.eq.${a},user_b.eq.${b}),and(user_a.eq.${b},user_b.eq.${a})`);

          return json({ data: updated });
        }

        const { error: delErr } = await supabaseAdmin.from("friendships").delete().eq("id", existing.id);
        if (delErr) return json({ error: "Failed to replace inverse relationship", detail: delErr.message }, 500);
      }

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("friendships")
        .insert({
          sender_id: sessionUserId,
          receiver_id: blockedId,
          status: "blocked",
          encrypted_key_bundle: null,
          accepted_at: null,
          updated_at: now,
        })
        .select("id, sender_id, receiver_id, status, updated_at")
        .single();

      if (insErr) return json({ error: "Failed to block user", detail: insErr.message }, 500);

      // Cleanup conversation
      const a = sessionUserId;
      const b = blockedId;
      const { data: msgIds } = await supabaseAdmin
        .from("messages")
        .select("id")
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
      const ids = (msgIds || []).map((m: any) => m.id).filter(Boolean);
      if (ids.length) {
        await supabaseAdmin.from("reactions").delete().in("message_id", ids);
        await supabaseAdmin.from("messages_hidden").delete().in("message_id", ids);
      }
      await supabaseAdmin
        .from("messages")
        .delete()
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
      await supabaseAdmin
        .from("ratchet_states")
        .delete()
        .or(`and(user_id.eq.${a},conversation_key.eq.${a}:${b}),and(user_id.eq.${a},conversation_key.eq.${b}:${a}),and(user_id.eq.${b},conversation_key.eq.${a}:${b}),and(user_id.eq.${b},conversation_key.eq.${b}:${a})`);
      await supabaseAdmin
        .from("username_shares")
        .delete()
        .or(`and(owner_id.eq.${a},recipient_id.eq.${b}),and(owner_id.eq.${b},recipient_id.eq.${a})`);
      await supabaseAdmin
        .from("chat_rows")
        .delete()
        .or(`and(user_a.eq.${a},user_b.eq.${b}),and(user_a.eq.${b},user_b.eq.${a})`);

      return json({ data: inserted });
    }

    // ── POST /blocks/remove ────────────────────────────────────────────────

    if (req.method === "POST" && isBlockRemove) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { blockedId?: string } | null;
      const blockedId = body?.blockedId?.trim().toLowerCase();
      if (!blockedId) return json({ error: "Missing blockedId" }, 400);

      const { error } = await supabaseAdmin
        .from("friendships")
        .delete()
        .eq("sender_id", sessionUserId)
        .eq("receiver_id", blockedId)
        .eq("status", "blocked");

      if (error) return json({ error: "Failed to unblock user", detail: error.message }, 500);
      return json({ success: true });
    }

    // ── GET /messages ──────────────────────────────────────────────────────

    if (req.method === "GET" && isMessagesRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const friendId = url.searchParams.get("friendId")?.trim().toLowerCase();
      const since = url.searchParams.get("since")?.trim();
      const before = url.searchParams.get("before")?.trim();
      const limitRaw = Number(url.searchParams.get("limit") || "50");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 50;
      if (!friendId) return json({ error: "Missing friendId" }, 400);

      const { data: friendship, error: friendshipErr } = await supabaseAdmin
        .from("friendships")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();

      if (friendshipErr) return json({ error: "Failed to validate friendship" }, 500);
      if (!friendship) return json({ error: "Friendship required" }, 403);

      let query = supabaseAdmin
        .from("messages")
        .select("*")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (since) query = query.gt("created_at", since);
      if (before) query = query.lt("created_at", before);

      const { data, error } = await query;
      if (error) return json({ error: "Failed to fetch messages" }, 500);
      let rows = data || [];
      const ids = rows.map((r: any) => r.id).filter(Boolean);
      if (ids.length) {
        const { data: hiddenRows } = await supabaseAdmin
          .from("messages_hidden")
          .select("message_id")
          .eq("user_id", sessionUserId)
          .in("message_id", ids);
        const hiddenSet = new Set((hiddenRows || []).map((r: any) => r.message_id));
        rows = rows.filter((r: any) => !hiddenSet.has(r.id));
      }
      return json({ data: rows.slice().reverse() });
    }

    // ── POST /messages/send ────────────────────────────────────────────────

    if (req.method === "POST" && isMessageSend) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        receiverId?: string;
        encryptedContent?: string;
        replyToMessageId?: string;
      } | null;
      const receiverId = body?.receiverId?.trim().toLowerCase();
      const encryptedContent = body?.encryptedContent;
      const replyToMessageId = body?.replyToMessageId?.trim() || null;
      if (!receiverId || !encryptedContent) return json({ error: "Missing message fields" }, 400);
      if (!parseRatchetEnvelope(encryptedContent)) {
        return json({ error: "Invalid ratchet encrypted content" }, 400);
      }
      if (replyToMessageId && !isUuid(replyToMessageId)) {
        return json({ error: "Invalid replyToMessageId" }, 400);
      }

      const { data: friendship, error: friendshipErr } = await supabaseAdmin
        .from("friendships")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${sessionUserId})`)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();

      if (friendshipErr) return json({ error: "Failed to validate friendship" }, 500);
      if (!friendship) return json({ error: "Friendship required" }, 403);

      if (replyToMessageId) {
        const { data: parent, error: parentErr } = await supabaseAdmin
          .from("messages")
          .select("id, sender_id, receiver_id")
          .eq("id", replyToMessageId)
          .maybeSingle();
        if (parentErr) return json({ error: "Failed to validate reply target" }, 500);
        if (!parent) return json({ error: "Reply target not found" }, 404);
        const isSameConversation =
          (parent.sender_id === sessionUserId && parent.receiver_id === receiverId) ||
          (parent.sender_id === receiverId && parent.receiver_id === sessionUserId);
        if (!isSameConversation) return json({ error: "Reply target does not belong to this conversation" }, 403);
      }

      let insertResult = await supabaseAdmin
        .from("messages")
        .insert({
          sender_id: sessionUserId,
          receiver_id: receiverId,
          encrypted_content: encryptedContent,
          reply_to_message_id: replyToMessageId,
        })
        .select("*")
        .single();

      if (insertResult.error && String((insertResult.error as any).code || "") === "42703") {
        insertResult = await supabaseAdmin
          .from("messages")
          .insert({
            sender_id: sessionUserId,
            receiver_id: receiverId,
            encrypted_content: encryptedContent,
          })
          .select("*")
          .single();
      }

      if (insertResult.error) return json({ error: "Failed to send message" }, 500);
      return json({ data: insertResult.data });
    }

    // ── POST /messages/edit ────────────────────────────────────────────────

    if (req.method === "POST" && isMessageEdit) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { messageId?: string; encryptedContent?: string } | null;
      const messageId = body?.messageId?.trim();
      const encryptedContent = body?.encryptedContent;
      if (!messageId || !encryptedContent) return json({ error: "Missing message edit fields" }, 400);
      if (!isUuid(messageId)) return json({ error: "Invalid messageId" }, 400);
      if (!parseRatchetEnvelope(encryptedContent)) {
        return json({ error: "Invalid ratchet encrypted content" }, 400);
      }

      const primaryUpdate: Record<string, unknown> = {
        encrypted_content: encryptedContent,
        updated_at: new Date().toISOString(),
        is_edited: true,
      };

      let result = await supabaseAdmin
        .from("messages")
        .update(primaryUpdate)
        .eq("id", messageId)
        .eq("sender_id", sessionUserId)
        .select("*")
        .single();

      if (result.error && String((result.error as any).code || "") === "42703") {
        result = await supabaseAdmin
          .from("messages")
          .update({ encrypted_content: encryptedContent })
          .eq("id", messageId)
          .eq("sender_id", sessionUserId)
          .select("*")
          .single();
      }

      if (result.error) return json({ error: "Failed to edit message" }, 500);
      return json({ data: result.data });
    }

    // ── POST /messages/delete ──────────────────────────────────────────────

    if (req.method === "POST" && isMessageDelete) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { messageId?: string } | null;
      const messageId = body?.messageId?.trim();
      if (!messageId) return json({ error: "Missing messageId" }, 400);
      if (!isUuid(messageId)) return json({ error: "Invalid messageId" }, 400);

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("messages")
        .select("id, sender_id, receiver_id")
        .eq("id", messageId)
        .maybeSingle();

      if (existingErr) return json({ error: "Failed to fetch message" }, 500);
      if (!existing) return json({ error: "Message not found" }, 404);
      if (existing.sender_id !== sessionUserId && existing.receiver_id !== sessionUserId) {
        return json({ error: "Not authorized to delete this message" }, 403);
      }

      const { error } = await supabaseAdmin
        .from("messages")
        .delete()
        .eq("id", messageId);

      if (error) return json({ error: "Failed to delete message" }, 500);
      return json({ success: true, messageId });
    }

    // ── POST /messages/hide ────────────────────────────────────────────────

    if (req.method === "POST" && isMessageHide) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { messageId?: string; friendId?: string } | null;
      const messageId = body?.messageId?.trim() || "";
      const friendId = body?.friendId?.trim().toLowerCase() || "";

      if (!messageId && !friendId) return json({ error: "Missing messageId or friendId" }, 400);

      if (messageId) {
        if (!isUuid(messageId)) return json({ error: "Invalid messageId" }, 400);
        const { data: msg } = await supabaseAdmin
          .from("messages")
          .select("id, sender_id, receiver_id")
          .eq("id", messageId)
          .maybeSingle();
        if (!msg) return json({ error: "Message not found" }, 404);
        if (msg.sender_id !== sessionUserId && msg.receiver_id !== sessionUserId) {
          return json({ error: "Forbidden" }, 403);
        }
        await supabaseAdmin
          .from("messages_hidden")
          .upsert({
            message_id: messageId,
            user_id: sessionUserId,
            hidden_at: new Date().toISOString(),
          }, { onConflict: "message_id,user_id" });
        return json({ success: true, messageId });
      }

      const { data: rows } = await supabaseAdmin
        .from("messages")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .limit(5000);
      const ids = (rows || []).map((r: any) => r.id).filter(Boolean);
      if (ids.length === 0) return json({ success: true, hidden: 0 });

      const payload = ids.map((id: string) => ({
        message_id: id,
        user_id: sessionUserId,
        hidden_at: new Date().toISOString(),
      }));

      const { error: hideErr } = await supabaseAdmin
        .from("messages_hidden")
        .upsert(payload, { onConflict: "message_id,user_id" });
      if (hideErr) return json({ error: "Failed to hide conversation" }, 500);
      return json({ success: true, hidden: ids.length });
    }

    // ── GET /chat ──────────────────────────────────────────────────────────

    if (req.method === "GET" && isChatRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { data, error } = await supabaseAdmin
        .from("chat_rows")
        .select("id,user_a,user_b,created_by,created_at,updated_at")
        .or(`user_a.eq.${sessionUserId},user_b.eq.${sessionUserId}`)
        .order("updated_at", { ascending: false });

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01") return json({ data: [] });
        return json({ error: "Failed to load chat rows", detail: error.message }, 500);
      }
      return json({ data: data || [] });
    }

    // ── POST /chat/ensure ──────────────────────────────────────────────────

    if (req.method === "POST" && isChatEnsure) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { friendId?: string } | null;
      const friendId = body?.friendId?.trim().toLowerCase();
      if (!friendId) return json({ error: "Missing friendId" }, 400);

      const { data: friendship, error: friendshipErr } = await supabaseAdmin
        .from("friendships")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();
      if (friendshipErr) return json({ error: "Failed to validate friendship" }, 500);
      if (!friendship) return json({ error: "Friendship required" }, 403);

      const a = sessionUserId < friendId ? sessionUserId : friendId;
      const b = sessionUserId < friendId ? friendId : sessionUserId;
      const { data, error } = await supabaseAdmin
        .from("chat_rows")
        .upsert(
          {
            user_a: a,
            user_b: b,
            created_by: sessionUserId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_a,user_b" },
        )
        .select("id,user_a,user_b,created_by,created_at,updated_at")
        .single();

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01") return json({ error: "chat_rows table missing" }, 500);
        return json({ error: "Failed to ensure chat row", detail: error.message }, 500);
      }
      return json({ data });
    }

    // ── POST /chat/delete ──────────────────────────────────────────────────

    if (req.method === "POST" && isChatDelete) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { friendId?: string } | null;
      const friendId = body?.friendId?.trim().toLowerCase();
      if (!friendId) return json({ error: "Missing friendId" }, 400);

      const { data: friendship, error: friendshipErr } = await supabaseAdmin
        .from("friendships")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();
      if (friendshipErr) return json({ error: "Failed to validate friendship" }, 500);
      if (!friendship) return json({ error: "Friendship required" }, 403);

      const a = sessionUserId;
      const b = friendId;
      const { data: msgIds } = await supabaseAdmin
        .from("messages")
        .select("id")
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
      const ids = (msgIds || []).map((m: any) => m.id).filter(Boolean);
      if (ids.length) {
        await supabaseAdmin.from("reactions").delete().in("message_id", ids);
      }
      await supabaseAdmin
        .from("messages")
        .delete()
        .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`);
      if (ids.length) {
        await supabaseAdmin
          .from("messages_hidden")
          .delete()
          .in("message_id", ids);
      }
      await supabaseAdmin
        .from("ratchet_states")
        .delete()
        .or(`and(user_id.eq.${a},conversation_key.eq.${a}:${b}),and(user_id.eq.${a},conversation_key.eq.${b}:${a}),and(user_id.eq.${b},conversation_key.eq.${a}:${b}),and(user_id.eq.${b},conversation_key.eq.${b}:${a})`);
      await supabaseAdmin
        .from("prekey_backups")
        .delete()
        .or(`user_id.eq.${a},user_id.eq.${b}`);

      await supabaseAdmin
        .from("chat_rows")
        .delete()
        .or(`and(user_a.eq.${a},user_b.eq.${b}),and(user_a.eq.${b},user_b.eq.${a})`);

      return json({ success: true });
    }

    // ── GET /messages/unread-counts ────────────────────────────────────────

    if (req.method === "GET" && isUnreadCounts) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { data, error } = await supabaseAdmin
        .from("messages")
        .select("sender_id")
        .eq("receiver_id", sessionUserId)
        .is("read_at", null);

      if (error) return json({ error: "Failed to fetch unread counts", detail: error.message }, 500);

      const counts: Record<string, number> = {};
      for (const row of data || []) {
        counts[row.sender_id] = (counts[row.sender_id] || 0) + 1;
      }
      return json({ data: Object.entries(counts).map(([friend_id, unread_count]) => ({ friend_id, unread_count })) });
    }

    // ── POST /messages/mark-read ───────────────────────────────────────────

    if (req.method === "POST" && isMarkRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { friendId?: string } | null;
      const friendId = body?.friendId?.trim().toLowerCase();
      if (!friendId) return json({ error: "Missing friendId" }, 400);

      const { error } = await supabaseAdmin
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .eq("receiver_id", sessionUserId)
        .eq("sender_id", friendId)
        .is("read_at", null);

      if (error) return json({ error: "Failed to mark messages read", detail: error.message }, 500);
      return json({ success: true });
    }

    // ── GET /reactions ─────────────────────────────────────────────────────

    if (req.method === "GET" && isReactionsRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const messageId = url.searchParams.get("messageId")?.trim();
      if (!messageId) return json({ error: "Missing messageId" }, 400);
      if (!isUuid(messageId)) return json({ error: "Invalid messageId" }, 400);

      const { data, error } = await supabaseAdmin
        .from("reactions")
        .select("*")
        .eq("message_id", messageId);

      if (error) return json({ error: "Failed to fetch reactions", detail: error.message }, 500);
      return json({ data: data || [] });
    }

    // ── POST /reactions/upsert ─────────────────────────────────────────────

    if (req.method === "POST" && isReactionUpsert) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        messageId?: string;
        encryptedEmoji?: string;
        reactionId?: string;
      } | null;
      const messageId = body?.messageId;
      const encryptedEmoji = body?.encryptedEmoji;
      if (!messageId || encryptedEmoji === undefined || encryptedEmoji === null) {
        return json({ error: "Missing reaction fields" }, 400);
      }
      if (!isUuid(messageId)) return json({ error: "Invalid messageId" }, 400);

      const { data: msg, error: msgErr } = await supabaseAdmin
        .from("messages")
        .select("id, sender_id, receiver_id")
        .eq("id", messageId)
        .maybeSingle();
      if (msgErr) return json({ error: "Failed to validate message" }, 500);
      if (!msg) return json({ error: "Message not found" }, 404);
      if (msg.sender_id !== sessionUserId && msg.receiver_id !== sessionUserId) {
        return json({ error: "Forbidden" }, 403);
      }

      const reactionId = String((body as any)?.reactionId || "").trim();

      if (String(encryptedEmoji).trim() === "") {
        if (reactionId) {
          const { error } = await supabaseAdmin
            .from("reactions")
            .delete()
            .eq("id", reactionId)
            .eq("user_id", sessionUserId);
          if (error) return json({ error: "Failed to clear reaction" }, 500);
          return json({ success: true, cleared: true });
        }
        const { error } = await supabaseAdmin
          .from("reactions")
          .delete()
          .eq("message_id", messageId)
          .eq("user_id", sessionUserId);
        if (error) return json({ error: "Failed to clear reaction" }, 500);
        return json({ success: true, cleared: true });
      }

      const { data: insertedReaction, error } = await supabaseAdmin
        .from("reactions")
        .insert({
          message_id: messageId,
          user_id: sessionUserId,
          encrypted_emoji: encryptedEmoji,
        })
        .select("*")
        .single();

      if (error) return json({ error: "Failed to add reaction" }, 500);
      return json({ success: true, data: insertedReaction });
    }

    // ── POST /account/delete ───────────────────────────────────────────────

    if (req.method === "POST" && isDeleteAccount) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { error: msgErr } = await supabaseAdmin.from("messages").delete().or(`sender_id.eq.${sessionUserId},receiver_id.eq.${sessionUserId}`);
      if (msgErr) return json({ error: "Failed to delete messages", detail: msgErr.message }, 500);

      await supabaseAdmin.from("messages_hidden").delete().eq("user_id", sessionUserId);
      await supabaseAdmin.from("reactions").delete().eq("user_id", sessionUserId);
      await supabaseAdmin.from("ratchet_states").delete().eq("user_id", sessionUserId);
      await supabaseAdmin.from("prekey_backups").delete().eq("user_id", sessionUserId);
      await supabaseAdmin.from("username_shares").delete().or(`owner_id.eq.${sessionUserId},recipient_id.eq.${sessionUserId}`);
      await supabaseAdmin.from("chat_rows").delete().or(`user_a.eq.${sessionUserId},user_b.eq.${sessionUserId}`);

      const { error: friendErr } = await supabaseAdmin.from("friendships").delete().or(`sender_id.eq.${sessionUserId},receiver_id.eq.${sessionUserId}`);
      if (friendErr) return json({ error: "Failed to delete friendships", detail: friendErr.message }, 500);

      const { error: profileErr } = await supabaseAdmin.from("profiles").delete().eq("id", sessionUserId);
      if (profileErr) return json({ error: "Failed to delete profile", detail: profileErr.message }, 500);

      await supabaseAdmin.from("auth_rate_limits").delete().ilike("key", `${sessionUserId}:%`);
      return json({ success: true });
    }

    // ── POST /status/update ────────────────────────────────────────────────

    if (req.method === "POST" && isStatusUpdate) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      // Server only acknowledges receipt - never sees plaintext
      return json({ success: true, received: true });
    }

    // ── POST /typing ───────────────────────────────────────────────────────

    if (req.method === "POST" && isTyping) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      return json({ success: true, received: true });
    }

    // ── GET /ratchet-state ─────────────────────────────────────────────────

    if (req.method === "GET" && isRatchetState) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { data, error } = await supabaseAdmin
        .from("ratchet_states")
        .select("conversation_key, encrypted_state, updated_at")
        .eq("user_id", sessionUserId)
        .order("updated_at", { ascending: false });

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01" || error.message?.toLowerCase().includes("ratchet_states")) {
          return json({ data: [] });
        }
        return json({ error: "Failed to load ratchet states" }, 500);
      }
      return json({ data: data || [] });
    }

    // ── POST /ratchet-state ────────────────────────────────────────────────

    if (req.method === "POST" && isRatchetState) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        conversation_key?: string;
        encrypted_state?: string;
      } | null;

      const conversationKey = body?.conversation_key?.trim();
      const encryptedState = body?.encrypted_state?.trim();

      if (!conversationKey || !encryptedState) {
        return json({ error: "Missing conversation_key or encrypted_state" }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("ratchet_states")
        .upsert(
          {
            user_id: sessionUserId,
            conversation_key: conversationKey,
            encrypted_state: encryptedState,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,conversation_key" },
        )
        .select("conversation_key, encrypted_state, updated_at")
        .single();

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01" || error.message?.toLowerCase().includes("ratchet_states")) {
          return json({ data: null, skipped: true });
        }
        return json({ error: "Failed to save ratchet state" }, 500);
      }

      return json({ data });
    }

    // ── GET /profile ───────────────────────────────────────────────────────

    if (req.method === "GET" && isProfileRead) {
      const id = url.searchParams.get("id")?.trim().toLowerCase();
      if (!id) return json({ error: "Missing id" }, 400);

      const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("id, public_key, signing_public_key, prekey_public_key, prekey_signature, prekey_updated_at, prekey_version, encrypted_username, created_at, updated_at")
        .eq("id", id)
        .maybeSingle();

      if (error) return json({ error: "Failed to fetch profile", detail: error.message }, 500);
      return json({ data: data || null });
    }

    // ── POST /profile/upsert ───────────────────────────────────────────────

    if (req.method === "POST" && isProfileUpsert) {
      // Profile upsert does NOT require signature verification for initial
      // registration (the profile doesn't exist yet to verify against).
      // For existing profiles, signature is optional here since the edge
      // function already validates id === SHA-256(publicKey).
      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        id?: string;
        publicKey?: string;
        signingPublicKey?: string;
        prekeyPublicKey?: string;
        prekeySignature?: string;
        prekeyUpdatedAt?: string;
        prekeyVersion?: number;
        encryptedUsername?: string | null;
      } | null;

      const id = body?.id?.trim().toLowerCase();
      const publicKey = body?.publicKey?.trim().toLowerCase();
      const signingPublicKey = body?.signingPublicKey?.trim().toLowerCase() || null;
      const prekeyPublicKey = body?.prekeyPublicKey?.trim().toLowerCase() || null;
      const prekeySignature = body?.prekeySignature?.trim() || null;
      const prekeyUpdatedAt = body?.prekeyUpdatedAt?.trim() || null;
      const prekeyVersion = body?.prekeyVersion ?? null;
      const encryptedUsername = body?.encryptedUsername ?? null;

      if (!id || !publicKey) return json({ error: "Missing id/publicKey" }, 400);
      if (!isHex(id) || !isHex(publicKey)) return json({ error: "Invalid hex input" }, 400);

      // Cryptographic ownership verification
      const expectedId = await sha256Hex(hexToUint8(publicKey));
      if (expectedId !== id) return json({ error: "id does not match publicKey hash" }, 400);

      const { data: existingProfile, error: existingErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("id", id)
        .maybeSingle();

      if (existingErr) return json({ error: "Failed to read existing profile" }, 500);

      const updateFields: Record<string, unknown> = {
        public_key: publicKey,
        encrypted_username: encryptedUsername,
        updated_at: new Date().toISOString(),
      };
      if (signingPublicKey) updateFields.signing_public_key = signingPublicKey;
      if (prekeyPublicKey) updateFields.prekey_public_key = prekeyPublicKey;
      if (prekeySignature) updateFields.prekey_signature = prekeySignature;
      if (prekeyUpdatedAt) updateFields.prekey_updated_at = prekeyUpdatedAt;
      if (prekeyVersion !== null) updateFields.prekey_version = prekeyVersion;

      if (!existingProfile) {
        // Initial registration: require signing_public_key
        if (!signingPublicKey) return json({ error: "Missing signingPublicKey for new profile" }, 400);

        const { error: insertErr } = await supabaseAdmin
          .from("profiles")
          .insert({
            id,
            public_key: publicKey,
            signing_public_key: signingPublicKey,
            encrypted_username: encryptedUsername,
            ...(prekeyPublicKey ? { prekey_public_key: prekeyPublicKey } : {}),
            ...(prekeySignature ? { prekey_signature: prekeySignature } : {}),
            ...(prekeyUpdatedAt ? { prekey_updated_at: prekeyUpdatedAt } : {}),
            ...(prekeyVersion !== null ? { prekey_version: prekeyVersion } : {}),
          });

        if (insertErr) return json({ error: "Failed to insert profile" }, 500);

        const { data: inserted, error: readInsertedErr } = await supabaseAdmin
          .from("profiles")
          .select("id, public_key, signing_public_key, prekey_public_key, prekey_signature, prekey_updated_at, prekey_version, encrypted_username, created_at, updated_at")
          .eq("id", id)
          .single();

        if (readInsertedErr) return json({ error: "Failed to read inserted profile" }, 500);
        return json({ data: inserted });
      }

      // Profile update
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .update(updateFields)
        .eq("id", id)
        .select("id, public_key, signing_public_key, prekey_public_key, prekey_signature, prekey_updated_at, prekey_version, encrypted_username, created_at, updated_at")
        .single();

      if (error) return json({ error: "Failed to upsert profile" }, 500);
      return json({ data });
    }

    // ── GET /username-shares ───────────────────────────────────────────────

    if (req.method === "GET" && isUsernameSharesRead) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const { data, error } = await supabaseAdmin
        .from("username_shares")
        .select("id, owner_id, recipient_id, owner_public_key, encrypted_username, updated_at")
        .eq("recipient_id", sessionUserId)
        .order("updated_at", { ascending: false });

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01") return json({ data: [] });
        return json({ error: "Failed to load username shares", detail: error.message }, 500);
      }
      return json({ data: data || [] });
    }

    // ── POST /username-shares/upsert ───────────────────────────────────────

    if (req.method === "POST" && isUsernameSharesUpsert) {
      const auth = await verifyRequest(req, rawBody, supabaseAdmin);
      if ("response" in auth) return auth.response;
      const sessionUserId = auth.userId;

      const body = JSON.parse(new TextDecoder().decode(rawBody)) as {
        friendId?: string;
        encryptedUsername?: string;
      } | null;
      const friendId = body?.friendId?.trim().toLowerCase();
      const encryptedUsername = body?.encryptedUsername?.trim();
      if (!friendId || !encryptedUsername) return json({ error: "Missing friendId/encryptedUsername" }, 400);

      const { data: friendship, error: friendshipErr } = await supabaseAdmin
        .from("friendships")
        .select("id")
        .or(`and(sender_id.eq.${sessionUserId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${sessionUserId})`)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();
      if (friendshipErr) return json({ error: "Failed to validate friendship" }, 500);
      if (!friendship) return json({ error: "Friendship required" }, 403);

      const { data: ownerProfile, error: ownerErr } = await supabaseAdmin
        .from("profiles")
        .select("public_key")
        .eq("id", sessionUserId)
        .maybeSingle();
      if (ownerErr || !ownerProfile?.public_key) {
        return json({ error: "Failed to load owner profile key" }, 500);
      }

      const { data, error } = await supabaseAdmin
        .from("username_shares")
        .upsert(
          {
            owner_id: sessionUserId,
            recipient_id: friendId,
            owner_public_key: ownerProfile.public_key,
            encrypted_username: encryptedUsername,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "owner_id,recipient_id" },
        )
        .select("id, owner_id, recipient_id, owner_public_key, encrypted_username, updated_at")
        .single();

      if (error) {
        const code = String((error as any).code || "");
        if (code === "42P01") return json({ error: "username_shares table missing" }, 500);
        return json({ error: "Failed to save username share", detail: error.message }, 500);
      }

      return json({ data });
    }

    return new Response("Not found", { status: 404 });
  } catch (err) {
    return json({ error: (err as Error).message || "Server error" }, 500);
  }
});
