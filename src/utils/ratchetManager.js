import { saveRatchetState, loadRatchetStates } from "../lib/schemaApi";
import { encryptRatchetState, decryptRatchetState } from "./crypto";

const _ratchetCache = {};

const DBG = typeof window !== "undefined" && window.__CHAT_DEBUG__ === true;

export function getConversationKey(userId, otherUserId) {
  // Create a deterministic conversation key (sorted to ensure both users generate same key)
  const sorted = [userId, otherUserId].sort();
  return sorted.join(":");
}

export async function initRatchetFromStorage(privateKey) {
  if (!privateKey) return;
  
  try {
    const states = await loadRatchetStates();
    
    for (const state of states || []) {
      try {
        const decrypted = await decryptRatchetState(state.encrypted_state, privateKey);
        if (decrypted) {
          _ratchetCache[state.conversation_key] = decrypted;
        }
      } catch (e) {
        console.warn("Failed to decrypt ratchet state for", state.conversation_key, e);
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
  // Derive initial chain key from ECDH
  const { deriveSharedKeyNaCl } = await import("./crypto");
  const chainKey = await deriveSharedKeyNaCl(myPrivateKeyHex, theirPublicKeyHex);

  const state = {
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

async function deriveMessageKey(chainKey, messageNumber) {
  // Derive unique message key from chain key + message number
  const encoder = new TextEncoder();
  const data = encoder.encode(chainKey + ":" + messageNumber);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

async function advanceChainKey(chainKey) {
  // Advance chain key (HMAC-like operation)
  const encoder = new TextEncoder();
  const data = encoder.encode(chainKey + "advance");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function encryptWithRatchet(plaintext, conversationKey, privateKey) {
  let state = _ratchetCache[conversationKey];
  
  if (DBG) {
    console.debug("[Ratchet] encryptWithRatchet", {
      conversationKey,
      hasState: !!state,
      messageNumber: state?.sendingMessageNumber || null,
      plaintextLength: plaintext?.length || 0,
    });
  }

  if (!state) {
    // Create new state (this shouldn't happen normally)
    console.warn("[Ratchet] No state found, creating new");
    return null;
  }
  
  const messageNumber = state.sendingMessageNumber;
  const messageKey = await deriveMessageKey(state.sendingChainKey, messageNumber);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    messageKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    plaintextBytes,
  );
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  const ciphertextB64 = btoa(String.fromCharCode(...packed));
  
  // Advance chain key and message number
  state.sendingChainKey = await advanceChainKey(state.sendingChainKey);
  state.sendingMessageNumber++;
  
  // Update cache
  _ratchetCache[conversationKey] = state;
  
  // Save to server (debounced in practice)
  await saveRatchetStateToServer(conversationKey, privateKey);
  
  if (DBG) {
    console.debug("[Ratchet] encrypt success", {
      conversationKey,
      messageNumber,
      ciphertextLength: ciphertextB64?.length || 0,
      encryptedContent: JSON.stringify({ c: ciphertextB64, n: messageNumber }).slice(0, 60),
    });
  }

  return {
    ciphertext: ciphertextB64,
    messageNumber,
  };
}

export async function decryptWithRatchet(ciphertext, conversationKey, privateKey, messageNumber = null) {
  let state = _ratchetCache[conversationKey];
  
  if (!state) {
    console.warn("[Ratchet] No state found for decryption");
    return null;
  }
  
  const targetNumber =
    Number.isInteger(messageNumber) && messageNumber >= 0
      ? messageNumber
      : state.receivingMessageNumber;

  while (state.receivingMessageNumber < targetNumber) {
    state.receivingChainKey = await advanceChainKey(state.receivingChainKey);
    state.receivingMessageNumber++;
  }

  const messageKey = await deriveMessageKey(state.receivingChainKey, state.receivingMessageNumber);

  if (DBG) {
    try {
      console.debug("[Ratchet] decryptWithRatchet", {
        conversationKey,
        targetNumber,
        ciphertextPreview: typeof ciphertext === "string" ? ciphertext.slice(0, 40) : null,
      });
    } catch (e) {
      // ignore debug errors
    }
  }

  const packed = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const encrypted = packed.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    messageKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encrypted,
  );
  const plaintextStr = new TextDecoder().decode(decrypted);
  
  // Advance chain key and message number
  state.receivingChainKey = await advanceChainKey(state.receivingChainKey);
  state.receivingMessageNumber++;
  
  // Update cache
  _ratchetCache[conversationKey] = state;
  
  // Save to server
  await saveRatchetStateToServer(conversationKey, privateKey);
  
  if (DBG) {
    try {
      console.debug("[Ratchet] decrypt success", {
        conversationKey,
        messageNumber: state.receivingMessageNumber - 1,
        plaintextLength: plaintextStr?.length || 0,
      });
    } catch (e) {
      // ignore
    }
  }

  return plaintextStr;
}

async function saveRatchetStateToServer(conversationKey, privateKey) {
  try {
    const state = _ratchetCache[conversationKey];
    if (!state || !privateKey) return;
    
    const encrypted = await encryptRatchetState(state, privateKey);
    if (encrypted) {
      await saveRatchetState(conversationKey, encrypted);
    }
  } catch (e) {
    console.warn("Failed to save ratchet state:", e);
  }
}

export function clearRatchetCache() {
  Object.keys(_ratchetCache).forEach((key) => delete _ratchetCache[key]);
}

// DEV helper: expose ratchet cache for debugging when DBG is enabled
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
    // ignore if environment disallows
  }
}
