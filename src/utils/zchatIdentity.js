/**
 * ZChat Identity & Key Derivation
 *
 * Key hierarchy:
 *   Phrase (12/24 words)
 *     └── SHA-256 → 32-byte MASTER SEED
 *           ├── X25519 keypair (encryption identity) → user ID
 *           ├── Ed25519 keypair (request signing / authorization)
 *           └── PreKey vN = HMAC-SHA256("prekey:vN", seed) → X25519 keypair
 *
 * The 32-byte master seed is the root of all keys. It is derived once from
 * the phrase on first signup and persisted (encrypted) for quick login.
 * The phrase itself is NEVER stored.
 */

import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { encryptWithKey, deriveAESKeyFromPassword } from "./crypto";

// ── Hex helpers ──────────────────────────────────────────────────────────────

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex input");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Master seed derivation ───────────────────────────────────────────────────

/**
 * Derive the 32-byte master seed from a BIP39 phrase.
 * This is the root of ALL keys (X25519 identity, Ed25519 signing, PreKeys).
 * The phrase is NEVER stored — only this seed (encrypted) persists.
 */
export function deriveMasterSeed(phrase) {
  const normalized = phrase.trim().toLowerCase();
  const phraseBytes = new TextEncoder().encode(normalized);
  const seed = new Uint8Array(sha256(phraseBytes));
  return bytesToHex(seed);
}

// ── Identity derivation from master seed ─────────────────────────────────────

/**
 * Derive both X25519 (encryption) and Ed25519 (signing) keypairs
 * from the 32-byte master seed. Both curves use the same seed but
 * process it differently — producing independent, deterministic keypairs.
 */
export function deriveIdentityFromSeed(seedHex) {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error("Master seed must be 32 bytes");
  }

  // X25519 keypair (encryption identity)
  const x25519Keypair = nacl.box.keyPair.fromSecretKey(seed);

  // Ed25519 keypair (request signing / authorization)
  const ed25519Keypair = nacl.sign.keyPair.fromSeed(seed);

  // User ID = SHA-256 of X25519 public key (backward compatible)
  const userId = bytesToHex(sha256(x25519Keypair.publicKey));

  return {
    userId,
    // X25519 (encryption)
    x25519PublicKeyHex: bytesToHex(x25519Keypair.publicKey),
    x25519PrivateKeyHex: bytesToHex(seed),
    // Ed25519 (signing)
    ed25519PublicKeyHex: bytesToHex(ed25519Keypair.publicKey),
    ed25519PrivateKeyHex: bytesToHex(ed25519Keypair.secretKey),
    // Aliases for backward compatibility
    publicKeyHex: bytesToHex(x25519Keypair.publicKey),
    privateKeyHex: bytesToHex(seed),
    signingPublicKeyHex: bytesToHex(ed25519Keypair.publicKey),
    signingPrivateKeyHex: bytesToHex(ed25519Keypair.secretKey),
  };
}

// ── PreKey derivation (for forward-secure key rotation) ──────────────────────

/**
 * Derive a X25519 PreKey keypair for a given version number.
 * PreKeys are rotated periodically (daily) for forward secrecy.
 * Old PreKey private keys are encrypted with the master key, uploaded to
 * the server, and deleted from device memory. New devices deterministically
 * regenerate all PreKeys from the master seed.
 */
export function derivePreKeypair(seedHex, version) {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error("Master seed must be 32 bytes");
  }
  const n = Number(version) || 0;
  if (n < 0) throw new Error("PreKey version must be non-negative");

  // HMAC-SHA256("prekey:vN", master_seed) → 32-byte PreKey seed
  const tag = new TextEncoder().encode(`prekey:v${n}`);
  const preKeySeed = hmac(sha256, tag, seed);

  const keypair = nacl.box.keyPair.fromSecretKey(preKeySeed);
  return {
    publicKeyHex: bytesToHex(keypair.publicKey),
    privateKeyHex: bytesToHex(keypair.secretKey),
  };
}

// ── Ed25519 signing ─────────────────────────────────────────────────────────

/**
 * Sign a message with an Ed25519 private key.
 * Returns the 64-byte signature as a hex string.
 */
export function signMessage(ed25519PrivateKeyHex, messageBytes) {
  const secretKey = hexToBytes(ed25519PrivateKeyHex);
  if (secretKey.length !== 64) {
    // nacl.sign.secretKey is 64 bytes (seed + public key)
    throw new Error("Ed25519 secret key must be 64 bytes");
  }
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return bytesToHex(signature);
}

/**
 * Verify an Ed25519 signature.
 * Returns true if the signature is valid for the given public key and message.
 */
export function verifySignature(ed25519PublicKeyHex, messageBytes, signatureHex) {
  const publicKey = hexToBytes(ed25519PublicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (publicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  if (signature.length !== 64) {
    throw new Error("Ed25519 signature must be 64 bytes");
  }
  return nacl.sign.detached.verify(messageBytes, signature, publicKey);
}

// ── Backward-compatible API ─────────────────────────────────────────────────

/**
 * Derive full identity from a BIP39 phrase.
 * Returns both X25519 (encryption) and Ed25519 (signing) keypairs.
 * This is the primary entry point for signup and login.
 */
export function deriveZchatIdentityFromPhrase(phrase) {
  const seedHex = deriveMasterSeed(phrase);
  return deriveIdentityFromSeed(seedHex);
}

/**
 * Derive identity from a stored master seed (32-byte hex).
 * Used for "remember me" and PIN vault unlock.
 * Returns both X25519 and Ed25519 keypairs.
 */
export function deriveZchatIdentityFromSeed(seedHex) {
  return deriveIdentityFromSeed(seedHex);
}

/**
 * Derive identity from a stored X25519 private key.
 * The private key IS the master seed (32 bytes), so this also derives
 * the Ed25519 signing keypair from the same seed.
 * Used for loading identity from persistent storage.
 */
export function deriveZchatIdentityFromPrivateKey(privateKeyHex) {
  return deriveIdentityFromSeed(privateKeyHex);
}

/**
 * Derive the legacy auth challenge response (kept for transitional compatibility).
 * Uses the Ed25519 signing key to sign the challenge instead of the old
 * X25519 ECDH + HMAC approach.
 */
export async function createAuthChallengeResponse(
  privateKeyHex,
  _serverPublicKeyHex, // unused in new model — Ed25519 signing doesn't need server key
  challenge,
  timestamp,
) {
  const identity = deriveIdentityFromSeed(privateKeyHex);
  const payload = new TextEncoder().encode(`${challenge}:${timestamp}`);
  const signatureHex = signMessage(identity.ed25519PrivateKeyHex, payload);
  return {
    challengeResponseHex: signatureHex,
  };
}

// ── Username encryption (unchanged from original) ───────────────────────────

export async function deriveAesKeyFromPrivateKey(privateKeyHex) {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  return await deriveAESKeyFromPassword(
    bytesToHex(privateKeyBytes),
    "username-encryption"
  );
}

export async function encryptUsernameForProfile(username, privateKeyHex) {
  const aesKey = await deriveAesKeyFromPrivateKey(privateKeyHex);
  const encryptedUsername = await encryptWithKey(username, aesKey);
  return { encryptedUsername };
}

// ── Debug helpers ────────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__zchat_deriveIdentity", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: function (phrase) {
        return deriveZchatIdentityFromPhrase(phrase);
      },
    });
  } catch {
    // ignore
  }
}
