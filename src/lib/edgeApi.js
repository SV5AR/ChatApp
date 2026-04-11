/**
 * Edge API — Supabase Edge Function client with Ed25519 request signing.
 *
 * Every request is signed with the user's Ed25519 private key.
 * No session tokens, no JWT rotation, no expiry tracking.
 * The edge function verifies the signature against the stored signing_public_key.
 */

import nacl from "tweetnacl";

const BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/auth-signin`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ── Utility helpers ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = String(hex || "").trim().toLowerCase();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function fetchWithRetry(url, options, { retries = 2 } = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (isRetryableStatus(res.status) && attempt < retries) {
        await sleep(200 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return res;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt >= retries) throw error;
      await sleep(200 * 2 ** attempt);
      attempt += 1;
    }
  }

  throw lastError || new Error("Network request failed");
}

// ── Nonce generation ─────────────────────────────────────────────────────────

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

// ── Signing key management ───────────────────────────────────────────────────

/**
 * Store the Ed25519 signing keys in sessionStorage after identity derivation.
 * Called once during signup/login after keys are derived.
 */
export function setSigningKeys(secretKeyHex, publicKeyHex) {
  try {
    sessionStorage.setItem("userEd25519SecretKey", secretKeyHex);
    sessionStorage.setItem("userEd25519PublicKey", publicKeyHex);
  } catch {
    // Storage might be unavailable
  }
}

/**
 * Get the Ed25519 secret key (64 bytes = seed + public key).
 * Returns null if no signing key is available.
 */
function getSigningSecretKey() {
  try {
    return sessionStorage.getItem("userEd25519SecretKey") || null;
  } catch {
    return null;
  }
}

/**
 * Get the Ed25519 public key (32 bytes).
 */
function getSigningPublicKey() {
  try {
    return sessionStorage.getItem("userEd25519PublicKey") || null;
  } catch {
    return null;
  }
}

/**
 * Ensure signing keys are available. If Ed25519 keys aren't stored but
 * the X25519 private key (master seed) is, derive them on the fly.
 * This handles sessions created before Ed25519 key storage was added.
 */
let _signingKeysPromise = null;
async function ensureSigningKeys() {
  if (getSigningSecretKey() && getSigningPublicKey()) return true;
  if (_signingKeysPromise) return _signingKeysPromise;
  _signingKeysPromise = (async () => {
    try {
      const seedHex = sessionStorage.getItem("userPrivateKey") || "";
      if (!/^[0-9a-f]{64}$/i.test(seedHex)) return false;
      const { deriveZchatIdentityFromSeed } = await import("../utils/zchatIdentity");
      const identity = deriveZchatIdentityFromSeed(seedHex);
      setSigningKeys(identity.ed25519PrivateKeyHex, identity.ed25519PublicKeyHex);
      return true;
    } catch (e) {
      console.warn("[edgeApi] Failed to derive signing keys:", e);
      return false;
    } finally {
      _signingKeysPromise = null;
    }
  })();
  return _signingKeysPromise;
}


/**
 * Clear signing keys from session storage (logout/lock).
 */
export function clearSigningKeys() {
  try {
    sessionStorage.removeItem("userEd25519SecretKey");
    sessionStorage.removeItem("userEd25519PublicKey");
  } catch {
    // ignore
  }
}

// ── Request signing ──────────────────────────────────────────────────────────

/**
 * Sign a request body with the user's Ed25519 private key.
 * Returns the signed headers object, or null if signing keys are unavailable.
 */
function signRequest(bodyBytes) {
  const secretKeyHex = getSigningSecretKey();
  const publicKeyHex = getSigningPublicKey();

  if (!secretKeyHex || !publicKeyHex) {
    // No signing keys available — the edge function will reject with 401
    return null;
  }

  try {
    const secretKey = hexToBytes(secretKeyHex);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonce();

    // Ed25519 sign the raw body bytes
    const signature = nacl.sign.detached(bodyBytes, secretKey);
    const signatureHex = bytesToHex(signature);

    return {
      "x-signature": signatureHex,
      "x-public-key": publicKeyHex,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
    };
  } catch (e) {
    console.warn("[edgeApi] Request signing failed:", e);
    return null;
  }
}

// ── Response parsing ─────────────────────────────────────────────────────────

async function parseResponse(res) {
  const text = await res.text().catch(() => "");
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    console.warn("Failed to parse response as JSON:", text.substring(0, 200));
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized: signing key not recognized");
    }
    const message = body?.detail || body?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  // Normalize response shape
  if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body;
  }
  return { data: body };
}

// ── Public API: edgeGet / edgePost ───────────────────────────────────────────

export async function edgeGet(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;

  // Ensure signing keys are available (derive from seed if needed)
  await ensureSigningKeys();

  // GET requests have empty body — sign empty bytes
  const emptyBody = new Uint8Array(0);
  const authHeaders = signRequest(emptyBody) || {};

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      ...authHeaders,
    },
  });

  return parseResponse(res);
}

export async function edgePost(path, payload = {}) {
  const url = `${BASE_URL}${path}`;
  const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));

  // Ensure signing keys are available (derive from seed if needed)
  await ensureSigningKeys();

  const authHeaders = signRequest(bodyBytes) || {};

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    },
    { retries: 1 },
  );

  return parseResponse(res);
}

// ── Remember Me: persist/recover master key (NOT the phrase) ─────────────────


// ── Remember Me: persist/recover master key (NOT the phrase) ─────────────────

const MK_PLAIN_KEY = "zchat_master_key";
const MK_ENCRYPTED_KEY = "zchat_master_key_encrypted";

/**
 * Persist the master key to localStorage (Remember Me).
 *
 * If a password is provided → encrypt with PBKDF2-derived key (secure).
 * If no password → store plaintext directly (honest — user chose convenience over security).
 */
export async function persistMasterKey(masterKeyHex, password = "") {
  try {
    if (password && password.trim().length > 0) {
      // Secure: derive key from password via PBKDF2
      const { encryptPhraseWithPin } = await import("../utils/pinVault");
      const vault = await encryptPhraseWithPin(masterKeyHex, password);
      localStorage.setItem(MK_ENCRYPTED_KEY, JSON.stringify(vault));
      localStorage.removeItem(MK_PLAIN_KEY);
    } else {
      // Convenience: store plaintext (user chose this intentionally)
      localStorage.setItem(MK_PLAIN_KEY, masterKeyHex);
      localStorage.removeItem(MK_ENCRYPTED_KEY);
    }
  } catch (e) {
    console.warn("[edgeApi] Failed to persist master key:", e);
  }
}

/**
 * Load the master key from localStorage.
 * Tries plaintext first (no-password mode).
 * If password-encrypted vault exists, returns null — user must enter password in overlay.
 * Returns { masterKeyHex } or null if not available.
 */
export async function loadMasterKey() {
  try {
    // Try plaintext (no-password mode — auto-unlock)
    const plainKey = localStorage.getItem(MK_PLAIN_KEY);
    if (plainKey && /^[0-9a-f]{64}$/i.test(plainKey)) {
      return { masterKeyHex: plainKey };
    }

    // Check if password-encrypted vault exists — can't auto-decrypt
    const encryptedRaw = localStorage.getItem(MK_ENCRYPTED_KEY);
    if (encryptedRaw) {
      return { encrypted: true };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Check if a remembered master key exists (either encrypted or plaintext).
 */
export function hasRememberedMasterKey() {
  try {
    if (localStorage.getItem(MK_PLAIN_KEY)) return true;
    if (localStorage.getItem(MK_ENCRYPTED_KEY)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Clear all remembered master key data.
 */
export function clearRememberedMasterKey() {
  try {
    localStorage.removeItem(MK_PLAIN_KEY);
    localStorage.removeItem(MK_ENCRYPTED_KEY);
  } catch {
    // ignore
  }
}

// ── Legacy aliases (for transitional compatibility) ──────────────────────────

export function persistSessionTokenToLocal() {
  // Legacy alias — does nothing in the new model.
}

export function disableRememberMe() {
  clearRememberedMasterKey();
}

export function isRememberMeEnabled() {
  return hasRememberedMasterKey();
}
