import { saveRatchetState, loadRatchetStates } from "../lib/schemaApi";
import { encryptRatchetState, decryptRatchetState } from "./crypto";
import nacl from "tweetnacl";

const _ratchetCache = {};
const _ratchetLocks = {};
const _ratchetSaveQueues = {};

const DBG = typeof window !== "undefined" && window.__CHAT_DEBUG__ === true;

export function getConversationKey(userId, otherUserId) {
  const sorted = [userId, otherUserId].sort();
  return sorted.join(":");
}

export async function initRatchetFromStorage(privateKey) {
  if (!privateKey) return;

  try {
    const states = await loadRatchetStates();

    if (DBG) console.debug("[Ratchet] Loading", states?.length || 0, "states from server");

    for (const state of states || []) {
      try {
        const decrypted = await decryptRatchetState(state.encrypted_state, privateKey);
        if (decrypted) {
          _ratchetCache[state.conversation_key] = decrypted;
          if (DBG) console.debug("[Ratchet] Loaded state for:", state.conversation_key, {
            recvMsgNum: decrypted.receivingMessageNumber,
            sendMsgNum: decrypted.sendingMessageNumber,
            hasOriginalKey: !!decrypted.originalChainKey,
          });
        }
      } catch (e) {
        // Silently skip undecryptable ratchet states (e.g., from old sessions/key rotations)
        if (DBG) console.debug("[Ratchet] Skipping undecryptable state for", state.conversation_key);
      }
    }

    if (DBG) console.debug("[Ratchet] Loaded", Object.keys(_ratchetCache).length, "conversation states");
  } catch (e) {
    console.warn("Failed to load ratchet states:", e);
  }
}

export async function getRatchetState(conversationKey) {
  return _ratchetCache[conversationKey] || null;
}

export async function createRatchetState(
  myPrivateKeyHex,
  theirPublicKeyHex,
  conversationKey = null,
) {
  return createRatchetStateFromKeys(myPrivateKeyHex, theirPublicKeyHex, conversationKey);
}

export async function ensureRatchetStateWithOriginalKey(conversationKey, myPrivateKeyHex, theirPublicKeyHex) {
  const { deriveSharedKeyNaCl } = await import("./crypto");
  const state = _ratchetCache[conversationKey];

  if (state && state.originalChainKey) return state;

  const originalKey = await deriveSharedKeyNaCl(myPrivateKeyHex, theirPublicKeyHex);
  if (!originalKey) return state;

  if (state) {
    state.originalChainKey = originalKey;
    _ratchetCache[conversationKey] = state;
    if (DBG) console.debug("[Ratchet] Added originalChainKey to existing state");
    return state;
  }

  return createRatchetStateFromKeys(myPrivateKeyHex, theirPublicKeyHex, conversationKey);
}

async function createRatchetStateFromKeys(
  myPrivateKeyHex,
  theirPublicKeyHex,
  conversationKey = null,
) {
  const { deriveSharedKeyNaCl } = await import("./crypto");
  const chainKey = await deriveSharedKeyNaCl(myPrivateKeyHex, theirPublicKeyHex);

  const state = {
    originalChainKey: chainKey,
    sendingChainKey: chainKey,
    receivingChainKey: chainKey,
    sendingMessageNumber: 0,
    receivingMessageNumber: 0,
    previousChainLength: 0,
  };

  if (conversationKey) {
    _ratchetCache[conversationKey] = state;
    await saveRatchetStateToServer(conversationKey, myPrivateKeyHex);
  }

  return state;
}

/**
 * HKDF-SHA256 extract step: PRK = HMAC-SHA256(salt, IKM)
 */
async function hkdfExtract(salt, inputKeyMaterial) {
  const saltBytes = new TextEncoder().encode(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    saltBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, inputKeyMaterial);
  return new Uint8Array(signature);
}

/**
 * HKDF-SHA256 expand step: OKM = HMAC-SHA256(PRK, info || 0x01)
 * Produces 32 bytes of output keying material.
 */
async function hkdfExpand(pseudorandomKey, info) {
  const infoBytes = new TextEncoder().encode(info + "\x01");
  const key = await crypto.subtle.importKey(
    "raw",
    pseudorandomKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, infoBytes);
  return new Uint8Array(signature);
}

/**
 * Full HKDF-SHA256: extract then expand.
 */
async function hkdfSha256(inputKeyMaterial, salt, info) {
  const prk = await hkdfExtract(salt, inputKeyMaterial);
  return hkdfExpand(prk, info);
}

/**
 * Derive a message key using HKDF-SHA256 from the original chain key + message number.
 * Uses proper extract+expand for cryptographic key separation.
 */
async function deriveMessageKey(originalChainKey, messageNumber) {
  // Advance the chain `messageNumber` times using HKDF
  let chainKeyBytes = new TextEncoder().encode(originalChainKey);
  for (let i = 0; i < messageNumber; i++) {
    chainKeyBytes = await advanceChainKey(chainKeyBytes);
  }
  // Derive the message key via HKDF-SHA256
  const msgKeyBytes = await hkdfSha256(
    chainKeyBytes,
    "ratchet-message-salt",
    "message-key:" + messageNumber,
  );
  return msgKeyBytes;
}

/**
 * Advance the chain key using HKDF-SHA256 extract+expand.
 * Each advance produces a cryptographically separate chain key.
 */
async function advanceChainKey(chainKeyBytes) {
  return hkdfSha256(
    chainKeyBytes,
    "ratchet-chain-salt",
    "ratchet-chain-key",
  );
}

async function withRatchetLock(conversationKey, fn) {
  const key = String(conversationKey || "");
  if (!key) return fn();
  const prev = _ratchetLocks[key] || Promise.resolve();
  const run = prev.then(fn, fn);
  _ratchetLocks[key] = run.catch(() => {});
  return run;
}

export async function encryptWithRatchet(plaintext, conversationKey, privateKey) {
  return withRatchetLock(conversationKey, async () => {
    let state = _ratchetCache[conversationKey];
    if (!state) {
      console.warn("[Ratchet] No state for encryption:", conversationKey);
      return null;
    }

    const messageNumber = state.sendingMessageNumber || 0;
    const originalKey = state.originalChainKey || state.sendingChainKey;
    const messageKey = await deriveMessageKey(originalKey, messageNumber);

    // XSalsa20-Poly1305 (nacl.secretbox) — 192-bit nonce, same security as XChaCha20
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const msg = new TextEncoder().encode(plaintext);
    const cipher = nacl.secretbox(msg, nonce, messageKey);

    // Pack: nonce (24) + ciphertext+tag
    const packed = new Uint8Array(nonce.length + cipher.length);
    packed.set(nonce, 0);
    packed.set(cipher, nonce.length);
    const ciphertextB64 = btoa(String.fromCharCode(...packed));

    state.sendingMessageNumber = messageNumber + 1;
    _ratchetCache[conversationKey] = state;

    saveRatchetStateToServer(conversationKey, privateKey).catch(() => {});

    return { ciphertext: ciphertextB64, messageNumber };
  });
}

export async function decryptWithRatchet(ciphertext, conversationKey, privateKey, messageNumber = null, isOutgoing = false) {
  return withRatchetLock(conversationKey, async () => {
    const targetNumber = Number.isInteger(messageNumber) && messageNumber >= 0 ? messageNumber : 0;

    if (DBG) console.debug("[Ratchet] Attempting decrypt:", {
      convKey: conversationKey.slice(0, 20),
      targetNumber,
      isOutgoing,
    });

    let state = _ratchetCache[conversationKey];

    if (!state && privateKey) {
      await initRatchetFromStorage(privateKey);
      state = _ratchetCache[conversationKey];
    }

    if (!state) {
      if (DBG) console.warn("[Ratchet] No state for conversation:", conversationKey);
      return null;
    }

    const originalKey = state.originalChainKey || state.receivingChainKey;

    try {
      const messageKey = await deriveMessageKey(originalKey, targetNumber);

      // Unpack: nonce (24) + ciphertext+tag
      const packed = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
      const nonce = packed.slice(0, 24);
      const cipher = packed.slice(24);
      const plain = nacl.secretbox.open(cipher, nonce, messageKey);
      if (!plain) return null;
      const plaintext = new TextDecoder().decode(plain);

      if (DBG) console.debug("[Ratchet] SUCCESS decrypting at msgNum:", targetNumber);

      if (isOutgoing) {
        state.sendingMessageNumber = Math.max(state.sendingMessageNumber || 0, targetNumber + 1);
      } else {
        state.receivingMessageNumber = Math.max(state.receivingMessageNumber || 0, targetNumber + 1);
      }
      _ratchetCache[conversationKey] = state;

      return plaintext;
    } catch (e) {
      if (DBG) console.warn("[Ratchet] Failed to decrypt at msgNum", targetNumber, ":", e.message);
      return null;
    }
  });
}

async function saveRatchetStateToServer(conversationKey, privateKey) {
  try {
    const key = String(conversationKey || "");
    if (!_ratchetSaveQueues[key]) {
      _ratchetSaveQueues[key] = Promise.resolve();
    }

    const prev = _ratchetSaveQueues[key];
    const run = prev.then(async () => {
      const state = _ratchetCache[conversationKey];
      if (!state || !privateKey) return;
      const encrypted = await encryptRatchetState(state, privateKey);
      if (encrypted) {
        await saveRatchetState(conversationKey, encrypted);
        if (DBG) console.debug("[Ratchet] Saved state to server for:", key);
      }
    }).catch(() => {});
    _ratchetSaveQueues[key] = run;

    await run;
  } catch (e) {
    console.warn("Failed to save ratchet state:", e.message || e);
  }
}

export function flushRatchetSaveQueue(conversationKey) {
  const key = String(conversationKey || "");
  return _ratchetSaveQueues[key] || Promise.resolve();
}

export function clearRatchetCache() {
  Object.keys(_ratchetCache).forEach((key) => delete _ratchetCache[key]);
}

if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__getRatchetStates__", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: function () {
        return DBG ? JSON.parse(JSON.stringify(_ratchetCache || {})) : null;
      },
    });
  } catch (e) {
    // ignore
  }
}
