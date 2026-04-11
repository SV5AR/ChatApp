/**
 * Auth Profile Service — Phrase/privateKey sign-in & sign-up.
 *
 * New flow (no session tokens):
 * 1. Derive identity from phrase (Ed25519 + X25519 from master seed)
 * 2. Register/update profile on the server (includes signing_public_key)
 * 3. Store keys in sessionStorage for request signing
 * 4. Optionally persist encrypted master key for Remember Me
 */

import {
  deriveZchatIdentityFromPhrase,
  deriveZchatIdentityFromSeed,
  encryptUsernameForProfile,
} from "../utils/zchatIdentity";
import { edgeGet, edgePost, setSigningKeys, persistMasterKey } from "./edgeApi";

function randomUsername() {
  return `user${Math.floor(100000 + Math.random() * 900000)}`;
}

function normalizeId(id) {
  return String(id || "").trim().toLowerCase();
}

async function loadProfileById(id) {
  const clean = normalizeId(id);
  if (!clean) return null;
  const body = await edgeGet("/profile", { id: clean });
  return body?.data || null;
}

async function ensureProfile(identity, usernameOverride = null) {
  const existing = await loadProfileById(identity.userId).catch(() => null);
  if (existing) {
    // Verify identity matches existing profile
    if (
      String(existing.public_key || "").trim().toLowerCase() !==
      String(identity.publicKeyHex || "").trim().toLowerCase()
    ) {
      throw new Error("Identity mismatch for existing account profile");
    }
    if (
      String(existing.signing_public_key || "").trim().toLowerCase() !==
      String(identity.signingPublicKeyHex || "").trim().toLowerCase()
    ) {
      throw new Error("Signing key mismatch for existing account profile");
    }
    return {
      profile: existing,
      username: null,
      created: false,
    };
  }

  const username = String(usernameOverride || randomUsername()).trim();
  const { encryptedUsername } = await encryptUsernameForProfile(
    username,
    identity.privateKeyHex, // X25519 private key (= master seed)
  );

  const result = await edgePost("/profile/upsert", {
    id: identity.userId,
    publicKey: identity.publicKeyHex, // X25519 public key
    signingPublicKey: identity.signingPublicKeyHex, // Ed25519 public key
    encryptedUsername,
  });

  return {
    profile: result?.data || null,
    username,
    created: true,
  };
}

/**
 * Store identity keys in sessionStorage for request signing.
 */
function activateSession(identity) {
  sessionStorage.setItem("userId", identity.userId);
  sessionStorage.setItem("userPublicKey", identity.publicKeyHex);
  sessionStorage.setItem("userPrivateKey", identity.privateKeyHex);
  sessionStorage.setItem("userEd25519SecretKey", identity.ed25519PrivateKeyHex);
  sessionStorage.setItem("userEd25519PublicKey", identity.ed25519PublicKeyHex);
  setSigningKeys(identity.ed25519PrivateKeyHex, identity.ed25519PublicKeyHex);
}

export async function signUpWithPhrase(phrase, remember = false) {
  const identity = deriveZchatIdentityFromPhrase(phrase);
  const check = await loadProfileById(identity.userId).catch(() => null);
  if (check) {
    throw new Error(
      "This phrase is already registered. Please sign in instead.",
    );
  }

  const { username } = await ensureProfile(identity);
  activateSession(identity);

  // Persist master key for Remember Me
  if (remember) {
    // master seed = X25519 private key in current architecture
    await persistMasterKey(identity.privateKeyHex, identity.chainCodeHex || "");
  }

  return {
    userId: identity.userId,
    privateKey: identity.privateKeyHex,
    publicKey: identity.publicKeyHex,
    username: username || randomUsername(),
  };
}

export async function signInWithPhrase(phrase, remember = false) {
  const identity = deriveZchatIdentityFromPhrase(phrase);
  const profile = await loadProfileById(identity.userId).catch(() => null);
  if (!profile) {
    throw new Error("Phrase not found. Check your words or sign up first.");
  }
  if (
    String(profile.public_key || "").trim().toLowerCase() !==
    String(identity.publicKeyHex || "").trim().toLowerCase()
  ) {
    throw new Error("Identity signature mismatch for this account profile");
  }

  activateSession(identity);

  if (remember) {
    await persistMasterKey(identity.privateKeyHex, identity.chainCodeHex || "");
  }

  return {
    userId: identity.userId,
    privateKey: identity.privateKeyHex,
    publicKey: identity.publicKeyHex,
    encryptedUsername: profile.encrypted_username || null,
  };
}

export async function signInWithPrivateKey(privateKeyHex, remember = false) {
  const identity = deriveZchatIdentityFromSeed(privateKeyHex);
  const profile = await loadProfileById(identity.userId).catch(() => null);
  if (!profile) {
    throw new Error("Account not found for this private key.");
  }
  if (
    String(profile.public_key || "").trim().toLowerCase() !==
    String(identity.publicKeyHex || "").trim().toLowerCase()
  ) {
    throw new Error("Identity signature mismatch for this account profile");
  }

  activateSession(identity);

  if (remember) {
    await persistMasterKey(identity.privateKeyHex, identity.chainCodeHex || "");
  }

  return {
    userId: identity.userId,
    privateKey: identity.privateKeyHex,
    publicKey: identity.publicKeyHex,
    encryptedUsername: profile.encrypted_username || null,
  };
}

export async function getActiveProfile(userId) {
  return loadProfileById(userId);
}
