# ZChat — Complete Agent Build Specification
> **Version:** 1.0  
> **Purpose:** Full system specification for an AI agent to implement ZChat end-to-end.  
> **Scope:** Cryptographic protocols · Backend schema · Frontend architecture · UI/UX rules · All feature logic.  
> **Rule:** Every decision in this document is a hard requirement unless explicitly marked `[OPTIONAL]`.

---

## Table of Contents

1. [Project Philosophy](#1-project-philosophy)
2. [Technology Stack](#2-technology-stack)
3. [Cryptographic Architecture](#3-cryptographic-architecture)
4. [Key Derivation Chain](#4-key-derivation-chain)
5. [Session Establishment — Hybrid X3DH](#5-session-establishment--hybrid-x3dh)
6. [Messaging — Double Ratchet Protocol](#6-messaging--double-ratchet-protocol)
7. [Identity & UUID System](#7-identity--uuid-system)
8. [Username Privacy System](#8-username-privacy-system)
9. [Wire Packet Format](#9-wire-packet-format)
10. [Backend — Supabase Schema](#10-backend--supabase-schema)
11. [Backend — Edge Functions & API Routes](#11-backend--edge-functions--api-routes)
12. [Local Storage — SQLCipher Cache](#12-local-storage--sqlcipher-cache)
13. [Web Worker — Crypto Thread](#13-web-worker--crypto-thread)
14. [Auth Flow — Sign Up (3 Steps)](#14-auth-flow--sign-up-3-steps)
15. [Auth Flow — Sign In](#15-auth-flow--sign-in)
16. [Session Management & Remember Me](#16-session-management--remember-me)
17. [Friend System](#17-friend-system)
18. [Messaging Feature Set](#18-messaging-feature-set)
19. [Reactions](#19-reactions)
20. [Message Indicators & Metadata](#20-message-indicators--metadata)
21. [Delete Logic — All Variants](#21-delete-logic--all-variants)
22. [Block System](#22-block-system)
23. [Optimistic UI Rules](#23-optimistic-ui-rules)
24. [Real-time Sync](#24-real-time-sync)
25. [UI Theme System](#25-ui-theme-system)
26. [Localization — RTL/LTR](#26-localization--rtlltr)
27. [Notification & Background Sync](#27-notification--background-sync)
28. [Performance Targets](#28-performance-targets)
29. [Security Invariants](#29-security-invariants)
30. [File & Folder Structure](#30-file--folder-structure)
31. [Environment Variables](#31-environment-variables)
32. [Agent Build Order](#32-agent-build-order)

---

## 1. Project Philosophy

ZChat is a **zero-knowledge, end-to-end encrypted** messaging application. The server is treated as a fully untrusted adversary. Every piece of user data that touches the network or the database must be encrypted in a way that only the intended recipients can decrypt.

**Core axioms the agent must never violate:**

- The server must never see plaintext usernames, message content, reactions, typing indicators, read receipts, friend lists, or any user-generated content.
- The mnemonic phrase must never be stored anywhere — not in RAM beyond the derivation step, not in LocalStorage, not sent to the server.
- Every packet leaving the device must use a freshly ratcheted key. No key is ever reused.
- The local database is always encrypted. Plaintext data exists only in RAM at the moment of use.
- The UI never waits for cryptography or network. All crypto happens in a Web Worker. The UI applies optimistic updates instantly.

---

## 2. Technology Stack

### Frontend
| Layer | Choice | Notes |
|---|---|---|
| Framework | React 18 + Vite | TypeScript strict mode |
| Styling | Tailwind CSS v3 | Logical properties for RTL |
| State | Zustand | Per-store slices |
| Local DB | IndexedDB via `idb` (web) / SQLCipher (native) | Encrypted |
| Crypto Worker | Web Worker API + `comlink` | Off main thread |
| Routing | React Router v6 | Hash-based for offline |
| i18n | `react-i18next` | RTL auto-detection |
| Icons | Inline SVG only | No emoji, no icon font |

### Cryptography Libraries
| Library | Purpose |
|---|---|
| `@noble/curves` | Ed25519, X25519 — audited, zero-dep |
| `@noble/hashes` | HKDF, SHA-512, SHA-256, HMAC |
| `argon2-browser` | Argon2id in WASM, Worker-safe |
| `mlkem` | ML-KEM-768 (Kyber) — post-quantum KEM |
| `@signalapp/libsignal-client` | Double Ratchet, X3DH reference |
| `tweetnacl` | ChaCha20-Poly1305 fallback |

### Backend
| Layer | Choice | Notes |
|---|---|---|
| Database | Supabase (PostgreSQL) | RLS enforced on every table |
| Auth | Supabase Auth (custom JWT) | UUID-keyed, no email |
| Realtime | Supabase Realtime channels | Encrypted payload relay |
| Edge Functions | Deno (Supabase Edge Functions) | Signal routing, OPK management |
| Storage | Supabase Storage | Encrypted file blobs only |

---

## 3. Cryptographic Architecture

### Overview of layers

```
[User Phrase]
      │
      ▼
[Argon2id KDF]  ← 256 MiB memory, 3 iterations, 4 parallelism, 64-byte output
      │
      ▼
[Master Seed]  512-bit
      │
      ▼ HKDF-SHA-512 fan-out (unique `info` label per key)
      │
      ├──► IK_sign       (Ed25519)       identity signing
      ├──► IK_dh         (X25519)        long-term DH
      ├──► SPK_seed       (X25519)        signed prekey
      ├──► OPK_seed       (X25519)        one-time prekey pool
      ├──► username_key   (AES-256-GCM)   username encryption
      ├──► auth_key       (HMAC-SHA-256)  auth token signing
      └──► storage_key    (AES-256-GCM)   SQLCipher unlock
            │
            ▼
      [Per-friendship session via Hybrid X3DH]
            │
            ▼
      [Session Root Key]  256-bit, unique per friend pair
            │
            ├──► message ratchet     (Double Ratchet)
            ├──► reaction ratchet    (KDF chain)
            ├──► metadata ratchet    (KDF chain)
            └──► friend-req ratchet  (KDF chain)
                  │
                  ▼
            [Wire packets] → padded to 256-byte boundary → ChaCha20-Poly1305
```

### Encryption algorithm selection rationale

| Data | Algorithm | Reason |
|---|---|---|
| Key derivation | Argon2id | Memory-hard, defeats GPU/ASIC |
| Key fan-out | HKDF-SHA-512 | RFC 5869, keys are independent |
| Identity signing | Ed25519 | Fast, compact, safe |
| DH exchange | X25519 | Constant-time, RFC 7748 |
| Post-quantum KEM | ML-KEM-768 | NIST PQC standard (Kyber) |
| Symmetric encryption | AES-256-GCM | AEAD, authenticated |
| Wire packets | ChaCha20-Poly1305 | AEAD, no IV reuse risk |
| Local database | AES-256-GCM (SQLCipher) | Page-level encryption |
| Password/PIN wrap | Argon2id | Same hardness as phrase KDF |

---

## 4. Key Derivation Chain

### Step 1 — BIP-39 to raw seed
```
raw_seed = PBKDF2-SHA512(
  password  = mnemonic_phrase,
  salt      = "mnemonic",
  rounds    = 2048,
  keylen    = 64          // 512 bits
)
```

### Step 2 — Argon2id hardening
```
master_seed = Argon2id(
  password   = raw_seed,
  salt       = random_16_byte_salt,   // stored in plaintext on device (not secret)
  memory     = 262144,                // 256 MiB
  iterations = 3,
  parallelism= 4,
  hashlen    = 64                     // 512 bits
)
```

> **Note on the Argon2id salt:** The salt is not secret. It is generated once at account creation and stored in plaintext in the local DB and on the server (associated with the UUID). Its purpose is to prevent rainbow tables, not to add entropy.

### Step 3 — HKDF fan-out
```typescript
function deriveKey(master_seed: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha512, master_seed, new Uint8Array(0), info, length)
}

const IK_sign_seed  = deriveKey(master_seed, "zchat-identity-sign-v1",   32)
const IK_dh_seed    = deriveKey(master_seed, "zchat-identity-dh-v1",     32)
const SPK_seed      = deriveKey(master_seed, "zchat-spk-seed-v1",        32)
const OPK_seed      = deriveKey(master_seed, "zchat-opk-seed-v1",        64) // seed for pool generation
const username_key  = deriveKey(master_seed, "zchat-username-enc-v1",    32)
const auth_key      = deriveKey(master_seed, "zchat-auth-v1",            32)
const storage_key   = deriveKey(master_seed, "zchat-sqlcipher-v1",       32)
```

### Step 4 — Keypair generation from seeds
```typescript
const IK_sign  = ed25519.fromSeed(IK_sign_seed)      // { privateKey, publicKey }
const IK_dh    = x25519.scalarMultBase(IK_dh_seed)   // { privateKey, publicKey }

// SPK: new key every 30 days, signed by IK_sign
const SPK_private = deriveKey(SPK_seed, `zchat-spk-${rotation_epoch}`, 32)
const SPK_public  = x25519.scalarMultBase(SPK_private)
const SPK_sig     = ed25519.sign(SPK_public, IK_sign.privateKey)

// OPK pool: generate 100 keys at registration, replenish when <20 remain
function generateOPK(index: number): KeyPair {
  const seed = deriveKey(OPK_seed, `zchat-opk-${index}`, 32)
  return { privateKey: seed, publicKey: x25519.scalarMultBase(seed) }
}
```

### Step 5 — PIN/Biometric wrapping of storage_key
```typescript
// When "Remember Me" is enabled:
const pin_salt        = randomBytes(16)
const pin_derived_key = await argon2id({ password: pin, salt: pin_salt, ... })
const wrapped         = aesgcm.encrypt(storage_key, pin_derived_key)
// Store { wrapped, pin_salt } in OS keychain only. Never in app storage.

// On biometric unlock (native only):
// TEE/Secure Enclave holds a hardware-bound key that wraps storage_key
// Biometric authentication unlocks the TEE key, which unwraps storage_key
```

---

## 5. Session Establishment — Hybrid X3DH

### Participants
- **Alice** — initiator (sends friend request)
- **Bob** — responder (accepts friend request)

### Bob's published PreKey Bundle (server-stored, plaintext)
```json
{
  "uuid": "bob-uuid-v4",
  "IK_pub": "<base64 X25519 public key>",
  "SPK_pub": "<base64 X25519 signed prekey>",
  "SPK_sig": "<base64 Ed25519 signature over SPK_pub>",
  "OPK_pub": "<base64 X25519 one-time prekey — server picks one>",
  "Kyber_pub": "<base64 ML-KEM-768 public key>"
}
```

### X3DH handshake (Alice's side)
```typescript
// 1. Generate ephemeral key
const EK = x25519.generateKeypair()

// 2. Four classical DH computations
const DH1 = x25519.dh(alice.IK_dh.private, bob.SPK_pub)
const DH2 = x25519.dh(EK.private,          bob.IK_pub)
const DH3 = x25519.dh(EK.private,          bob.SPK_pub)
const DH4 = x25519.dh(EK.private,          bob.OPK_pub)  // may be empty if OPKs exhausted

// 3. ML-KEM-768 encapsulation
const { ciphertext, sharedSecret: kyber_secret } = mlkem768.encapsulate(bob.Kyber_pub)

// 4. Classical secret concatenation
const classical_secret = concat(DH1, DH2, DH3, DH4)

// 5. Hybrid combine
const session_root_key = hkdf(
  sha256,
  concat(classical_secret, kyber_secret),
  new Uint8Array(0),
  "zchat-x3dh-hybrid-v1",
  32
)

// 6. Initial message to Bob (sent via friend request ratchet)
const initial_message = {
  EK_pub:         EK.publicKey,
  OPK_id:         bob.OPK_id,   // so Bob knows which OPK was consumed
  Kyber_ct:       ciphertext,
  ratchet_payload: <Double Ratchet encrypted first message>
}
```

### X3DH handshake (Bob's side — upon acceptance)
```typescript
// Bob recomputes the same four DH values (reversed roles)
const DH1 = x25519.dh(bob.SPK_private,  alice.IK_pub)
const DH2 = x25519.dh(bob.IK_dh.private,alice.EK_pub)
const DH3 = x25519.dh(bob.SPK_private,  alice.EK_pub)
const DH4 = x25519.dh(bob.OPK_private,  alice.EK_pub)

const kyber_secret = mlkem768.decapsulate(kyber_ct, bob.Kyber_private)

const session_root_key = hkdf(
  sha256,
  concat(concat(DH1,DH2,DH3,DH4), kyber_secret),
  new Uint8Array(0),
  "zchat-x3dh-hybrid-v1",
  32
)
// Both sides now have the same session_root_key
```

### Sub-ratchet seeding from session_root_key
```typescript
const msg_root      = hkdf(sha256, session_root_key, "zchat-msg-ratchet-v1",    32)
const react_root    = hkdf(sha256, session_root_key, "zchat-react-ratchet-v1",  32)
const meta_root     = hkdf(sha256, session_root_key, "zchat-meta-ratchet-v1",   32)
const friend_root   = hkdf(sha256, session_root_key, "zchat-friend-ratchet-v1", 32)
```

---

## 6. Messaging — Double Ratchet Protocol

### Ratchet state (per friendship, persisted encrypted in local DB)
```typescript
interface RatchetState {
  DHs:          KeyPair         // current sending DH ratchet key
  DHr:          PublicKey       // current receiving DH ratchet key
  RK:           Uint8Array      // 32-byte root key
  CKs:          Uint8Array      // sending chain key
  CKr:          Uint8Array      // receiving chain key
  Ns:           number          // sending message number
  Nr:           number          // receiving message number
  PN:           number          // messages in previous sending chain
  MKSKIPPED:    Map<string, Uint8Array> // skipped message keys
}
```

### KDF chain step (symmetric ratchet)
```typescript
function kdfChainStep(CK: Uint8Array): { CK_next: Uint8Array, MK: Uint8Array } {
  const MK      = hmac(sha256, CK, Uint8Array.from([0x01]))  // message key
  const CK_next = hmac(sha256, CK, Uint8Array.from([0x02]))  // next chain key
  return { CK_next, MK }
}
```

### DH ratchet step
```typescript
function dhRatchetStep(state: RatchetState, header_dh_pub: PublicKey): RatchetState {
  const dh_out = x25519.dh(state.DHs.private, header_dh_pub)
  // Derive new root key and receiving chain key
  const [RK_new, CKr_new] = kdfRK(state.RK, dh_out)
  // Generate new DH sending keypair
  const DHs_new = x25519.generateKeypair()
  const [RK_new2, CKs_new] = kdfRK(RK_new, x25519.dh(DHs_new.private, header_dh_pub))
  return { ...state, DHs: DHs_new, DHr: header_dh_pub, RK: RK_new2, CKs: CKs_new, CKr: CKr_new }
}

function kdfRK(RK: Uint8Array, dh_out: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dh_out, RK, "zchat-ratchet-v1", 64)
  return [out.slice(0, 32), out.slice(32)]
}
```

### Encrypt (send message)
```typescript
function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array, associated_data: Uint8Array) {
  const { CK_next, MK } = kdfChainStep(state.CKs)
  state.CKs = CK_next
  const header = encryptHeader({ DHs_pub: state.DHs.publicKey, PN: state.PN, N: state.Ns }, state.HKs)
  state.Ns++
  const ciphertext = aesgcm.encrypt(MK, plaintext, concat(associated_data, header))
  // MK is immediately zeroized after use
  zeroize(MK)
  return { header, ciphertext }
}
```

### Decrypt (receive message)
```typescript
function ratchetDecrypt(state: RatchetState, header_ct: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array) {
  const header = decryptHeader(header_ct, state.HKr, state.NHKr)
  // Check skipped message keys first
  const skipped_key = state.MKSKIPPED.get(`${header.dh_pub}:${header.N}`)
  if (skipped_key) {
    state.MKSKIPPED.delete(`${header.dh_pub}:${header.N}`)
    return aesgcm.decrypt(skipped_key, ciphertext, concat(ad, header_ct))
  }
  // DH ratchet if new ratchet key
  if (!equals(header.dh_pub, state.DHr)) {
    skipMessageKeys(state, header.PN)
    state = dhRatchetStep(state, header.dh_pub)
  }
  skipMessageKeys(state, header.N)
  const { CK_next, MK } = kdfChainStep(state.CKr)
  state.CKr = CK_next
  state.Nr++
  const plaintext = aesgcm.decrypt(MK, ciphertext, concat(ad, header_ct))
  zeroize(MK)
  return plaintext
}
```

### Header encryption
Message headers (sender DH key, message index) are encrypted with a separate header key (`HKs`/`HKr`) so the server cannot perform traffic analysis on sequence numbers or sender ratchet keys.

### Per-event ratchet usage
Every single event that leaves the device consumes exactly one ratchet step:

| Event type | Ratchet used |
|---|---|
| Text message (send/edit) | `message ratchet` |
| Message deletion (for everyone) | `message ratchet` — "Shred Instruction" payload |
| Reaction add/remove/change | `reaction ratchet` |
| Typing indicator start/stop | `metadata ratchet` |
| Read receipt | `metadata ratchet` |
| "Edited" flag + timestamp | `metadata ratchet` |
| Friend request payload | `friend ratchet` |
| Username exchange | `friend ratchet` |

---

## 7. Identity & UUID System

### UUID rules
- The public UUID is **random UUIDv4** generated server-side at registration.
- It is **not derived** from the private key or phrase.
- It is the only publicly visible identifier.
- It is used for: adding friends, routing encrypted packets, database foreign keys.
- The server mapping is: `uuid → public_identity_key_bundle`.

### Public identity key bundle (server-stored)
```json
{
  "uuid":        "550e8400-e29b-41d4-a716-446655440000",
  "IK_pub":      "<base64>",
  "SPK_pub":     "<base64>",
  "SPK_sig":     "<base64>",
  "SPK_epoch":   1234567890,
  "OPK_count":   87,
  "Kyber_pub":   "<base64>",
  "created_at":  "2025-01-01T00:00:00Z",
  "argon2_salt": "<base64 16 bytes>"
}
```

### SPK rotation
- SPK rotates every **30 days**.
- The new SPK is signed by `IK_sign` and uploaded to the server.
- The old SPK private key is kept for **7 more days** to decrypt any in-flight messages that used it, then wiped.

### OPK replenishment
- Upload 100 OPKs at registration.
- Edge Function monitors count. When below 20, triggers client to upload 50 more.
- OPK private keys are stored encrypted in local DB keyed by `opk_id`.
- Once an OPK is consumed (server confirms its use), the private key is wiped.

---

## 8. Username Privacy System

### At-rest encryption
```typescript
function encryptUsername(username: string, username_key: Uint8Array): string {
  const iv         = randomBytes(12)
  const plaintext  = new TextEncoder().encode(username)
  const ciphertext = aesgcm.encrypt(username_key, plaintext, iv)
  return base64url(concat(iv, ciphertext))
}
```

The encrypted blob is stored in the `users` table. The server never has access to `username_key`.

### Username exchange flow
1. Alice sends Bob a friend request. The request payload (encrypted via `friend ratchet`) contains Alice's `encrypted_username` + `username_key`.
2. Bob decrypts the payload → decrypts Alice's username → sees it in friend list.
3. Bob's acceptance response (also through `friend ratchet`) contains Bob's `encrypted_username` + `username_key`.
4. Both users now hold each other's `username_key` in their local DB (encrypted at rest under `storage_key`).

### On unfriend/block
- Both devices wipe the stored `username_key` for the other party.
- Usernames become invisible to each other again.
- The friendship record is deleted from the server, cascade-deleting all related data.

---

## 9. Wire Packet Format

Every packet, regardless of content type, is formatted identically to prevent traffic analysis.

### Packet structure
```
[  2 bytes  ] Packet version (always 0x0001)
[  2 bytes  ] Payload length (before padding)
[ 12 bytes  ] ChaCha20-Poly1305 nonce
[ variable  ] Encrypted ratchet payload (AES-256-GCM ciphertext from ratchet)
[ padding   ] Zero bytes to reach next 256-byte boundary (Padmé scheme)
[ 16 bytes  ] Poly1305 authentication tag
```

### Padmé padding
```typescript
function padmeSize(len: number): number {
  if (len === 0) return 256
  const e = Math.floor(Math.log2(len))
  const s = Math.floor(Math.log2(e)) + 1
  const last_bits = e - s
  const bit_mask  = (1 << last_bits) - 1
  return (len + bit_mask) & ~bit_mask
}
```

### Transport encryption (outer layer)
The ratchet ciphertext is the inner layer. The outer ChaCha20-Poly1305 layer uses a per-connection transport key negotiated at the WebSocket level using a fresh X25519 ECDH, independent of the ratchet.

---

## 10. Backend — Supabase Schema

### Table: `users`
```sql
CREATE TABLE users (
  uuid               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encrypted_username TEXT        NOT NULL,
  IK_pub             TEXT        NOT NULL,
  SPK_pub            TEXT        NOT NULL,
  SPK_sig            TEXT        NOT NULL,
  SPK_epoch          BIGINT      NOT NULL,
  Kyber_pub          TEXT        NOT NULL,
  argon2_salt        TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: users can only read their own row or rows of accepted friends
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_self_read" ON users
  FOR SELECT USING (auth.uid()::uuid = uuid);

CREATE POLICY "user_friend_read" ON users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM friendships
      WHERE status = 'accepted'
      AND ((user_a = auth.uid()::uuid AND user_b = users.uuid)
        OR (user_b = auth.uid()::uuid AND user_a = users.uuid))
    )
  );
```

### Table: `opk_pool`
```sql
CREATE TABLE opk_pool (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid  UUID    NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  opk_id     INTEGER NOT NULL,
  opk_pub    TEXT    NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE opk_pool ENABLE ROW LEVEL SECURITY;
-- Only the owner can insert. Anyone can claim (set used=true) when sending a request.
```

### Table: `friendships`
```sql
CREATE TABLE friendships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a          UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  user_b          UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  initiated_by    UUID NOT NULL,
  -- Encrypted X3DH initial message for the recipient to compute session key
  x3dh_payload    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ,
  UNIQUE(user_a, user_b)
);
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
-- Only the two parties can read their friendship row
CREATE POLICY "friendship_parties" ON friendships
  FOR ALL USING (auth.uid()::uuid IN (user_a, user_b));
```

### Table: `chats`
```sql
CREATE TABLE chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a      UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  user_b      UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_a, user_b)
);
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_parties" ON chats FOR ALL USING (auth.uid()::uuid IN (user_a, user_b));
```

### Table: `messages`
```sql
CREATE TABLE messages (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          UUID    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_uuid      UUID    NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  -- Encrypted Double Ratchet packet (outer ChaCha20 layer)
  encrypted_packet TEXT    NOT NULL,
  -- Ratchet header (header-encrypted, server cannot read message number or DH key)
  encrypted_header TEXT    NOT NULL,
  -- Server-visible metadata (intentionally minimal)
  packet_size      INTEGER NOT NULL,   -- always a multiple of 256
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Per-user soft-delete flags (NULL = visible)
  deleted_for_a    BOOLEAN,
  deleted_for_b    BOOLEAN
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "message_parties" ON messages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM chats WHERE id = messages.chat_id
            AND auth.uid()::uuid IN (user_a, user_b))
  );
```

### Table: `message_events`
```sql
-- Stores reactions, edit signals, shred instructions — all encrypted
CREATE TABLE message_events (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chat_id          UUID    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  encrypted_packet TEXT    NOT NULL,
  encrypted_header TEXT    NOT NULL,
  event_type       TEXT    NOT NULL CHECK (event_type IN ('reaction','edit','shred','read','typing')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE message_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "event_parties" ON message_events
  FOR ALL USING (
    EXISTS (SELECT 1 FROM chats WHERE id = message_events.chat_id
            AND auth.uid()::uuid IN (user_a, user_b))
  );
```

### Table: `blocks`
```sql
CREATE TABLE blocks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  blocked_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(blocker_uuid, blocked_uuid)
);
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "block_owner" ON blocks FOR ALL USING (auth.uid()::uuid = blocker_uuid);
```

### Table: `ratchet_states`
```sql
-- Encrypted ratchet state backup (optional, for multi-device recovery)
CREATE TABLE ratchet_states (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_uuid        UUID    NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  peer_uuid         UUID    NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  encrypted_state   TEXT    NOT NULL,  -- AES-256-GCM under storage_key
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_uuid, peer_uuid)
);
ALTER TABLE ratchet_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ratchet_owner" ON ratchet_states FOR ALL USING (auth.uid()::uuid = owner_uuid);
```

### Table: `chat_visibility`
```sql
-- Tracks per-user "delete for me" on chats
CREATE TABLE chat_visibility (
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_uuid  UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_uuid)
);
ALTER TABLE chat_visibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vis_owner" ON chat_visibility FOR ALL USING (auth.uid()::uuid = user_uuid);
```

---

## 11. Backend — Edge Functions & API Routes

All Edge Functions receive and return **only encrypted blobs**. They never inspect payload content.

### `POST /auth/register`
**Input:**
```json
{
  "IK_pub":      "<base64>",
  "SPK_pub":     "<base64>",
  "SPK_sig":     "<base64>",
  "SPK_epoch":   1234567890,
  "Kyber_pub":   "<base64>",
  "OPKs":        ["<base64>", ...],  // 100 OPK public keys
  "encrypted_username": "<base64>",
  "argon2_salt": "<base64>",
  "auth_token":  "<HMAC-SHA256 challenge response>"
}
```
**Output:** `{ "uuid": "<v4>", "jwt": "<supabase jwt>" }`

**Server actions:**
1. Verify `auth_token` challenge.
2. Generate random UUIDv4.
3. Insert row into `users`.
4. Bulk insert OPKs into `opk_pool`.
5. Return UUID + signed JWT.

### `POST /auth/login`
**Input:**
```json
{
  "IK_pub":     "<base64>",
  "challenge":  "<server nonce>",
  "auth_token": "<HMAC-SHA256(challenge, auth_key)>"
}
```
**Output:** `{ "uuid": "<v4>", "jwt": "<supabase jwt>", "argon2_salt": "<base64>" }`

### `GET /prekey-bundle/:uuid`
Returns the target user's PreKey Bundle (including one OPK, marked as used).

### `POST /friend-request`
**Input:** `{ "to_uuid": "<v4>", "encrypted_x3dh_payload": "<base64>" }`

Server inserts into `friendships` with `status='pending'` and stores the encrypted X3DH payload. Server cannot read the payload.

### `POST /friend-accept/:friendship_id`
Server updates `friendships.status = 'accepted'`, creates a `chats` row, records `accepted_at`.

### `POST /message/send`
**Input:** `{ "chat_id": "<v4>", "encrypted_packet": "<base64>", "encrypted_header": "<base64>", "packet_size": 512 }`

Server inserts into `messages`. Triggers Realtime event to the other party's channel.

### `POST /message/event`
**Input:** `{ "message_id": "<v4>", "chat_id": "<v4>", "encrypted_packet": "<base64>", "encrypted_header": "<base64>", "event_type": "reaction|edit|shred|read|typing" }`

Server inserts into `message_events`. Triggers Realtime.

### `DELETE /message/:id/everyone`
Cascade-deletes: `message_events` → `messages`. Sends Shred Instruction realtime event to peer.

### `DELETE /chat/:id/everyone`
Cascade-deletes: `message_events` → `messages` → `chats`. Sends Shred Instruction to peer.

### `POST /block/:uuid`
1. Insert into `blocks`.
2. Delete `friendships` row (cascade → `chats` → `messages` → `message_events`).
3. Delete `ratchet_states` for the pair.

### `POST /opk/replenish`
Client uploads new batch of OPK public keys when pool is low.

### Realtime channels
Each user subscribes to a private Supabase Realtime channel: `private:${uuid}`.

Events pushed to the channel:
- `new_message` — `{ chat_id, message_id, encrypted_packet, encrypted_header }`
- `new_event` — `{ message_id, event_type, encrypted_packet }`
- `friend_request` — `{ from_uuid, friendship_id, x3dh_payload }`
- `friend_accepted` — `{ friendship_id, chat_id }`
- `shred_message` — `{ message_id }`
- `shred_chat` — `{ chat_id }`
- `unfriended` — `{ peer_uuid }`
- `blocked` — `{ by_uuid }`

---

## 12. Local Storage — SQLCipher Cache

### Philosophy
The local DB is the **source of truth for the UI**. The UI never reads directly from the network. All data fetched from the server is decrypted and written to the local DB, and the UI reads from there.

### Schema (SQLCipher / IndexedDB equivalent)

```sql
-- All data here is plaintext (decrypted). The DB file is AES-256-GCM encrypted at rest.

CREATE TABLE local_users (
  uuid        TEXT PRIMARY KEY,
  username    TEXT NOT NULL,   -- decrypted
  IK_pub      TEXT NOT NULL,
  is_me       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE local_friends (
  uuid          TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  status        TEXT NOT NULL,  -- 'pending_sent' | 'pending_received' | 'accepted' | 'blocked'
  friendship_id TEXT,
  username_key  TEXT,           -- base64, their username decryption key
  added_at      TEXT
);

CREATE TABLE local_chats (
  id               TEXT PRIMARY KEY,
  peer_uuid        TEXT NOT NULL,
  last_message_id  TEXT,
  last_message_at  TEXT,
  unread_count     INTEGER DEFAULT 0,
  hidden           INTEGER DEFAULT 0   -- "delete for me"
);

CREATE TABLE local_messages (
  id             TEXT PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  sender_uuid    TEXT NOT NULL,
  content        TEXT NOT NULL,   -- decrypted plaintext
  content_type   TEXT NOT NULL,   -- 'text' | 'deleted_for_me' | 'deleted_for_everyone'
  sent_at        TEXT NOT NULL,
  edited_at      TEXT,
  read_at        TEXT,
  deleted_for_me INTEGER DEFAULT 0
);

CREATE TABLE local_reactions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  sender_uuid TEXT NOT NULL,
  emoji_code TEXT NOT NULL,   -- e.g. 'heart', 'thumbs_up' (SVG icon name, not unicode emoji)
  created_at TEXT NOT NULL
);

CREATE TABLE local_ratchet_states (
  peer_uuid TEXT PRIMARY KEY,
  state_json TEXT NOT NULL   -- serialized RatchetState, JSON
);

CREATE TABLE local_opk_keys (
  opk_id      INTEGER PRIMARY KEY,
  opk_private TEXT NOT NULL  -- base64 private key
);

CREATE TABLE local_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Settings keys: theme_palette, theme_material, theme_shape, language, font_size
```

### Cache sync rules

| Event | Cache action |
|---|---|
| Send message | Write to `local_messages` immediately (optimistic) |
| Receive message (Realtime) | Decrypt → write to `local_messages` |
| Send reaction | Write to `local_reactions` immediately |
| Receive reaction | Decrypt → write to `local_reactions` |
| Delete for me | Mark `local_messages.deleted_for_me = 1`, hide from UI |
| Delete for everyone (self) | Delete from `local_messages` + `local_reactions` |
| Receive shred instruction | Delete from `local_messages` + `local_reactions` |
| Accept friend | Write to `local_friends`, create `local_chats` row |
| Unfriend/Block | Delete `local_chats`, all `local_messages`, `local_reactions` for that chat |

---

## 13. Web Worker — Crypto Thread

### Architecture

```
Main Thread (React UI)
      │  comlink RPC  │
      ▼               ▼
CryptoWorker (crypto.worker.ts)
      │
      ├── argon2id (WASM)
      ├── hkdf / hmac (@noble/hashes)
      ├── ed25519 / x25519 (@noble/curves)
      ├── mlkem768
      ├── aesgcm / chacha20poly1305
      └── Double Ratchet state machine
```

### Worker API (comlink interface)
```typescript
export interface CryptoWorkerAPI {
  // Key derivation
  deriveMasterSeed(mnemonic: string, argon2_salt: Uint8Array): Promise<Uint8Array>
  deriveAllKeys(master_seed: Uint8Array): Promise<KeyBundle>

  // X3DH
  computeX3DH_Alice(alice_keys: KeyBundle, bob_bundle: PreKeyBundle): Promise<X3DHResult>
  computeX3DH_Bob(bob_keys: KeyBundle, initial_msg: X3DHInitialMessage): Promise<Uint8Array> // session_root_key

  // Double Ratchet
  ratchetEncrypt(state: RatchetState, plaintext: Uint8Array, ad: Uint8Array): Promise<EncryptedPacket>
  ratchetDecrypt(state: RatchetState, packet: EncryptedPacket, ad: Uint8Array): Promise<{ plaintext: Uint8Array, state: RatchetState }>

  // Username
  encryptUsername(username: string, username_key: Uint8Array): Promise<string>
  decryptUsername(blob: string, username_key: Uint8Array): Promise<string>

  // Storage key
  wrapStorageKey(storage_key: Uint8Array, pin: string): Promise<WrappedKey>
  unwrapStorageKey(wrapped: WrappedKey, pin: string): Promise<Uint8Array>

  // Verification
  verifyMnemonic(phrase: string, stored_IK_pub: string): Promise<boolean>
}
```

### Key lifecycle in memory
1. After derivation, the raw mnemonic string is overwritten with zeros in the Worker.
2. The master seed is used only for HKDF and immediately cleared.
3. Message keys (MK) are zeroized immediately after encrypt/decrypt.
4. The `storage_key` lives in Worker memory only while the session is active.
5. On logout, the Worker receives a `zeroizeAll()` call that clears all key material.

---

## 14. Auth Flow — Sign Up (3 Steps)

### Step 1 — Generate Phrase

**UI elements:**
- Toggle: 12 words / 24 words (default: 12)
- Word grid: read-only cells displaying the phrase
- Button: "Regenerate" (dice SVG icon) — generates a fresh phrase
- Button: "Copy to clipboard" (clipboard SVG icon)
- Checkbox: "I understand this phrase will never be shown again and cannot be recovered. I have saved it securely."
- Button: "Continue" — disabled until checkbox is checked
- Loading indicator: shown while Argon2id WASM initializes in the background

**Logic:**
```typescript
// Generate phrase
const entropy = randomBytes(wordCount === 12 ? 16 : 32)
const mnemonic = bip39.entropyToMnemonic(entropy)
// Show phrase. Do NOT store anywhere yet.

// When user clicks Continue:
// Pass mnemonic to Step 2 only via React state (in-memory)
// Never write to localStorage, IndexedDB, or sessionStorage
```

### Step 2 — Verify Phrase

**UI elements:**
- Word count selector (same as chosen): 12 or 24 input fields
- Button: "Paste" — pastes from clipboard into all fields
- Fields can also be filled word-by-word
- Error state: highlights incorrect words in red
- Loading indicator: shown during Worker key derivation
- Button: "Verify" — runs derivation if all fields filled

**Logic:**
```typescript
// Compare entered phrase to original (memory only)
if (entered !== original_mnemonic) {
  showError("Phrase does not match. Please check each word.")
  return
}
// Phrase verified. Start derivation in Worker:
const argon2_salt = randomBytes(16)
const master_seed = await cryptoWorker.deriveMasterSeed(mnemonic, argon2_salt)
const keys        = await cryptoWorker.deriveAllKeys(master_seed)
// Zeroize mnemonic from React state immediately
setMnemonic(null)
// Proceed to Step 3
```

### Step 3 — Set Username & Create Account

**UI elements:**
- Text input: "Choose a username" (3–32 chars, alphanumeric + underscore + hyphen)
- Validation: inline character counter, regex check
- Loading indicator: account creation in progress
- Success: auto-navigate to main app

**Logic:**
```typescript
// Encrypt username
const encrypted_username = await cryptoWorker.encryptUsername(username, keys.username_key)

// Build registration payload
const payload = {
  IK_pub:               base64(keys.IK_sign.publicKey),
  SPK_pub:              base64(keys.SPK.publicKey),
  SPK_sig:              base64(keys.SPK_sig),
  SPK_epoch:            Math.floor(Date.now() / 1000),
  Kyber_pub:            base64(keys.Kyber.publicKey),
  OPKs:                 keys.OPKs.map(k => base64(k.publicKey)),
  encrypted_username,
  argon2_salt:          base64(argon2_salt),
  auth_token:           computeAuthToken(challenge, keys.auth_key)
}

// POST to /auth/register
const { uuid, jwt } = await api.register(payload)

// Store session
sessionStore.init(uuid, keys, jwt)
// Navigate to main app
```

---

## 15. Auth Flow — Sign In

**UI elements:**
- Word count selector: 12 / 24
- Word input grid (same as verify step)
- Button: "Paste"
- Section: "Saved logins" — dropdown listing accounts with "Remember Me" enabled
  - Each saved login item shows: UUID (first 8 chars), creation date
  - Tap to log in with PIN/Biometric if set, or directly if not
- Loading indicator during derivation

**Logic:**
```typescript
// User enters phrase
const master_seed   = await cryptoWorker.deriveMasterSeed(phrase, stored_argon2_salt)
// argon2_salt is fetched from server by matching IK_pub:
// GET /auth/salt?IK_pub=<base64> → { argon2_salt, uuid }

const keys          = await cryptoWorker.deriveAllKeys(master_seed)
const challenge     = await api.getChallenge()
const auth_token    = computeAuthToken(challenge, keys.auth_key)
const { uuid, jwt } = await api.login({ IK_pub: base64(keys.IK_sign.publicKey), challenge, auth_token })

sessionStore.init(uuid, keys, jwt)
// Load initial data (see §16)
```

### Saved login flow (Remember Me)
```typescript
// On tap of saved login item:
if (hasPinOrBiometric(saved_login)) {
  const pin = await promptPIN()  // or biometric
  const storage_key = await cryptoWorker.unwrapStorageKey(saved_login.wrapped_key, pin)
  sessionStore.unlockFromCache(storage_key)
  // Derive keys from local cache — no phrase needed
} else {
  sessionStore.unlockFromCache(saved_login.storage_key)  // directly stored if no PIN
}
```

---

## 16. Session Management & Remember Me

### On first login (before showing main app)
```
1. Issue session token (JWT)
2. Derive all keys in Worker
3. Fetch: own account data (uuid, encrypted_username → decrypt)
4. Write to local_users
5. Navigate to main app
6. In background (parallel fetch + decrypt + cache):
   - All accepted friends → local_friends
   - All pending friend requests (sent + received) → local_friends
   - Blocked users → local_friends (status='blocked')
   - All chats (with last message) → local_chats
   - All messages (paginated, most recent 50 per chat) → local_messages
   - All reactions → local_reactions
   - All ratchet states → local_ratchet_states
```

### Remember Me storage
```typescript
interface SavedLogin {
  uuid:          string
  wrapped_key:   WrappedKey    // storage_key wrapped under PIN or null
  has_pin:       boolean
  has_biometric: boolean
  created_at:    string
}
// Stored in OS keychain (Capacitor SecureStorage / browser CredentialsAPI)
// Never in localStorage or IndexedDB
```

### App lock (when Remember Me + PIN/Biometric enabled)
- When app goes to background (visibilitychange = hidden), start a 60-second timer.
- If app returns within 60 seconds: stay unlocked.
- If app stays in background > 60 seconds: clear `storage_key` from RAM, show lock screen.
- Lock screen shows PIN input or biometric prompt.
- Successful entry: unwrap `storage_key` → unlock DB → resume session.
- This mirrors Telegram's app lock behavior.

---

## 17. Friend System

### States
```
none → pending_sent (Alice sent request) → accepted (Bob accepted)
     → pending_received (Bob sees Alice's request)
accepted → unfriended (either party)
any → blocked (either party blocks)
```

### Add friend flow
1. Alice searches by UUID (the only public identifier).
2. Alice taps "Send friend request".
3. App fetches Bob's PreKey Bundle from server.
4. Optimistic UI: show Bob in friends list as `pending_sent`.
5. Worker: compute Hybrid X3DH → `session_root_key` → seed ratchets → encrypt username + key in `friend_ratchet`.
6. POST `/friend-request` with encrypted X3DH payload.

### Accept friend flow
1. Bob sees notification in "Friend Requests" tab (from Realtime event).
2. Optimistic UI: move Bob from pending to accepted.
3. Worker: recompute `session_root_key` from stored X3DH payload → seed ratchets → decrypt Alice's username.
4. POST `/friend-accept/:friendship_id` with Bob's encrypted username in response.
5. Both sides now have a full ratchet session and each other's username.

### Unfriend
1. Optimistic UI: remove friend + chat.
2. POST `/unfriend/:friendship_id`.
3. Server cascade-deletes: `friendships` → `chats` → `messages` → `message_events` → `ratchet_states`.
4. Worker: zeroize all ratchet state + stored username keys for that peer.
5. Local DB: delete `local_chats`, `local_messages`, `local_reactions`, `local_ratchet_states` for peer.

---

## 18. Messaging Feature Set

### Send message
1. UI: message appears in bubble instantly (optimistic, status: `sending`).
2. Worker: `ratchetEncrypt(message_ratchet, plaintext)` → encrypted packet.
3. POST `/message/send` → server stores blob.
4. On server ACK: update message status to `sent`.
5. On delivery to peer (Realtime ACK): update to `delivered`.
6. On read receipt: update to `read`.

### Edit message
1. UI: message content updates instantly (optimistic).
2. Worker: `ratchetEncrypt(message_ratchet, edited_content + message_id)` → packet.
3. POST `/message/event` with `event_type: 'edit'`.
4. Peer receives Realtime event → decrypt → update `local_messages.content` + `edited_at`.
5. Show "edited" indicator below message (small text, no SVG needed — just text label).

### Message content types
- Plain text (with full Unicode support including Kurdish, Arabic, Emoji rendered as text)
- `[deleted for everyone]` — tombstone shown for both parties
- `[deleted for me]` — hidden from local view only

### Message list rules
- Paginate: load 50 messages at a time, infinite scroll upward loads more.
- Messages from the local cache only. Never from network directly.
- Timestamps: show time for today, date+time for older messages.
- Show sender indicator only for messages sent by the other party (no label needed for self).

---

## 19. Reactions

### Reaction types (SVG icon names, not emoji unicode)
```
heart, thumbs_up, thumbs_down, laugh, wow, sad, fire, clap
```
Reactions are displayed as SVG icons rendered by the app, not as OS emoji characters. This ensures consistent rendering across all platforms.

### Reaction logic
- One reaction per user per message (replacing existing reaction counts as a change).
- Tap reaction icon → optimistic update in UI → Worker encrypts via `reaction_ratchet` → POST `/message/event`.
- Tap own reaction again → remove it.
- Reactions displayed as small icon + count below the message bubble.

---

## 20. Message Indicators & Metadata

All indicators travel through the `metadata ratchet`. The server sees only the event type label, not the decrypted content.

### Typing indicator
```typescript
// On keypress in message input:
throttle(200ms, () => {
  worker.ratchetEncrypt(meta_ratchet, { type: 'typing_start' })
  POST /message/event { event_type: 'typing', ... }
})
// On input blur or 3s silence:
worker.ratchetEncrypt(meta_ratchet, { type: 'typing_stop' })
POST /message/event { event_type: 'typing', ... }
```

### Read receipt
- Sent when the message is visible in the viewport for > 500ms.
- Encrypted via `metadata ratchet`.
- Show: single checkmark (sent), double checkmark (delivered), filled double checkmark (read).
- All checkmarks use SVG path icons, not unicode characters.

### Online/offline indicator  
`[OPTIONAL]` — only show if the user enables "Show online status" in settings. When enabled: presence is a boolean encrypted ping sent every 30 seconds.

---

## 21. Delete Logic — All Variants

### Delete message — for me
- **Scope:** Only the local device of the user who performed this action.
- **Irreversible:** Yes. Cannot be undone.
- **Both parties can delete:** Both the sender and the receiver can "delete for me" any message (sent or received).
- **Local action only:**
  1. Overwrite `local_messages.content` with null, set `content_type = 'deleted_for_me'`, `deleted_for_me = 1`.
  2. Physically overwrite the DB sector (SQLCipher vacuum/overwrite).
  3. Update server: POST `/message/delete-for-me/:id` → sets `deleted_for_a` or `deleted_for_b` flag on server row.
- **Other party:** Sees the message unchanged.

### Delete message — for everyone
- **Scope:** Both devices + server.
- **Irreversible:** Yes.
- **Both parties can delete:** Both sender and receiver can delete any message for everyone.
- **Flow:**
  1. Optimistic UI: replace message with `[deleted]` tombstone instantly.
  2. Worker: encrypt a "Shred Instruction" payload via `message_ratchet` referencing `message_id`.
  3. DELETE `/message/:id/everyone` → server cascade-deletes reactions + events + message row.
  4. Realtime "shred_message" event to peer.
  5. Peer app: delete `local_messages` row, delete `local_reactions` for that message.
  6. Peer app: physically overwrite DB sector.

### Delete chat — for me
- **Scope:** Local device only.
- **Irreversible:** Yes.
- **Flow:**
  1. Optimistic UI: remove chat from list instantly.
  2. Delete all `local_messages` + `local_reactions` + `local_ratchet_states` for the peer.
  3. Insert into `chat_visibility` on server (soft-hide).
  4. Future messages from the peer are **silently discarded** (never shown).

### Delete chat — for everyone
- **Scope:** Both devices + server. Full cascade wipe.
- **Both parties can trigger.**
- **Flow:**
  1. Optimistic UI: remove chat instantly.
  2. Worker: encrypt Shred Instruction for the entire chat.
  3. DELETE `/chat/:id/everyone` → server cascade: `message_events` → `messages` → `chats` row.
  4. Realtime "shred_chat" event to peer.
  5. Both devices: delete all local data for the chat.
  6. Ratchet states for the peer are zeroized and deleted.

### Unfriend (also triggers cascade chat wipe)
Same as "Delete chat for everyone" plus:
- Delete `friendships` row.
- Delete `ratchet_states`.
- Remove peer from `local_friends`.
- Block does not automatically re-add on unfriend (block is a separate action).

---

## 22. Block System

### Block action
Performs in sequence (all must succeed — wrap in transaction):
1. Optimistic UI: immediately remove friend + chat from all views.
2. POST `/block/:uuid`.
3. Server:
   a. Insert into `blocks`.
   b. Delete `friendships` (cascade → `chats` → `messages` → `message_events`).
   c. Delete `ratchet_states` for the pair.
4. Local device: full wipe of peer data (same as unfriend cascade).

### Block effects
- Blocked user cannot send a friend request until the block is lifted.
- Blocker does not appear in the blocked user's friend list (they simply disappear).
- The blocked user cannot view the blocker's profile or UUID-linked data.

### Unblock
1. DELETE `/block/:uuid`.
2. Remove from `local_friends` (status='blocked').
3. Peer can now send a new friend request (X3DH ratchet will be freshly initialized).

---

## 23. Optimistic UI Rules

Every action that can be reflected in the UI must be applied to the local cache **before** the network request is made. The network request and crypto happen in the background.

| Action | Optimistic behavior |
|---|---|
| Send message | Message bubble appears immediately with `sending` spinner |
| Send friend request | Friend appears in list as `pending` |
| Accept friend request | Friend moves to `accepted`, chat created |
| React to message | Reaction icon appears immediately |
| Edit message | Content updates immediately |
| Delete message (for me) | Message disappears from view immediately |
| Delete message (everyone) | Tombstone appears immediately |
| Delete chat (for me) | Chat removed from list immediately |
| Block user | Friend + chat removed immediately |
| Typing indicator | "..." bubble appears within 200ms |
| Read receipt | Checkmark updates immediately on viewport visibility |

### Rollback strategy
If the network request fails after an optimistic update:
1. Show a toast notification: "Failed to send. Tap to retry." (with retry SVG icon).
2. Revert the local cache to its pre-action state.
3. The message/action moves to a `failed` state in the UI (red indicator).
4. Tap-to-retry re-queues the Worker encryption + network call.

---

## 24. Real-time Sync

### Supabase Realtime subscription
```typescript
const channel = supabase.channel(`private:${myUUID}`)

channel
  .on('broadcast', { event: 'new_message' }, async ({ payload }) => {
    const { plaintext, state } = await worker.ratchetDecrypt(
      getState(payload.sender_uuid), payload.encrypted_packet, payload.encrypted_header, ad
    )
    saveState(payload.sender_uuid, state)
    const msg = JSON.parse(plaintext)
    db.insertMessage(msg)
    uiStore.refreshChat(payload.chat_id)
  })
  .on('broadcast', { event: 'shred_message' }, ({ payload }) => {
    db.deleteMessage(payload.message_id)
    uiStore.removeMessage(payload.message_id)
  })
  // ... other event handlers
  .subscribe()
```

### Background sync (when app is minimized)
- Keep the Realtime WebSocket open.
- Decrypt and cache incoming messages in the Worker.
- Show OS notification for new messages (notification text: "New message" — never reveal content in the notification).

### Reconnect handling
On reconnect after disconnection:
1. Fetch all missed events since `last_sync_timestamp`.
2. Decrypt + cache in order.
3. Re-render affected UI views.

---

## 25. UI Theme System

### Palette definitions

```typescript
const PALETTES = {
  NORDIC: {
    bg:      '#2E3440', surface: '#3B4252', border: '#434C5E',
    text:    '#ECEFF4', muted:   '#D8DEE9', accent: '#88C0D0',
    accent2: '#81A1C1', danger:  '#BF616A', success: '#A3BE8C'
  },
  DRACULA: {
    bg:      '#282A36', surface: '#44475A', border: '#6272A4',
    text:    '#F8F8F2', muted:   '#6272A4', accent: '#BD93F9',
    accent2: '#FF79C6', danger:  '#FF5555', success: '#50FA7B'
  },
  GRUVBOX: {
    bg:      '#282828', surface: '#3C3836', border: '#504945',
    text:    '#EBDBB2', muted:   '#A89984', accent: '#D79921',
    accent2: '#689D6A', danger:  '#CC241D', success: '#98971A'
  },
  GOLD_DARK: {
    bg:      '#1A1612', surface: '#2A2218', border: '#3D3020',
    text:    '#F0D080', muted:   '#B09040', accent: '#D4A017',
    accent2: '#8B6914', danger:  '#CC3300', success: '#4A7C3F'
  },
  BLUE_DARK: {
    bg:      '#0D1117', surface: '#161B22', border: '#21262D',
    text:    '#C9D1D9', muted:   '#8B949E', accent: '#1F6FEB',
    accent2: '#388BFD', danger:  '#F85149', success: '#3FB950'
  },
  GREEN_DARK: {
    bg:      '#0D1F0D', surface: '#122912', border: '#1A3A1A',
    text:    '#CCFFCC', muted:   '#66CC66', accent: '#00CC44',
    accent2: '#009933', danger:  '#CC2200', success: '#00FF44'
  },
  FLAT_UI: {
    bg:      '#ECF0F1', surface: '#FFFFFF', border: '#BDC3C7',
    text:    '#2C3E50', muted:   '#7F8C8D', accent: '#3498DB',
    accent2: '#9B59B6', danger:  '#E74C3C', success: '#2ECC71'
  },
  MOOD_LOGIC: {
    bg:      '#13111C', surface: '#1E1B2E', border: '#2D2A45',
    text:    '#E8E4F0', muted:   '#9B93B8', accent: '#7C4DFF',
    accent2: '#FF4DB8', danger:  '#FF4444', success: '#4DFFB4'
  }
}
```

### Material definitions

```typescript
const MATERIALS = {
  GLASSMORPHISM: {
    css: `
      background: rgba(var(--surface-rgb), 0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(var(--border-rgb), 0.25);
    `
  },
  NEUMORPHISM: {
    css: `
      background: var(--bg);
      box-shadow: 6px 6px 12px rgba(0,0,0,0.35), -4px -4px 8px rgba(255,255,255,0.05);
      border: none;
    `
  },
  BENTO_GRID: {
    css: `
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      /* Bento: asymmetric grid sizing, items can span 1-3 columns */
    `
  },
  CLAYMORPHISM: {
    css: `
      background: var(--surface);
      border-radius: 20px;
      box-shadow: 0 8px 0 rgba(0,0,0,0.2), inset 0 -4px 0 rgba(0,0,0,0.15);
      border: none;
    `
  },
  SOLID: {
    css: `
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: none;
    `
  }
}
```

### Shape definitions

```typescript
const SHAPES = {
  SHARP_EDGE:      { '--radius': '0px',   '--radius-sm': '0px',   '--radius-lg': '0px'   },
  SOFT_ROUNDED:    { '--radius': '8px',   '--radius-sm': '4px',   '--radius-lg': '12px'  },
  FULLY_ROUNDED:   { '--radius': '999px', '--radius-sm': '999px', '--radius-lg': '999px' },
  ORGANIC:         { '--radius': '30% 70% 70% 30% / 30% 30% 70% 70%', '--radius-lg': '60% 40% 50% 50% / 40% 60% 40% 60%' }
}
```

### Settings screen
- Settings accessible via gear SVG icon in sidebar.
- Palette selector: 8 color swatches in a grid. Tap to preview + apply instantly.
- Material selector: 5 options shown as card previews.
- Shape selector: 4 options shown as rounded rectangle previews.
- All changes apply immediately (no save button needed — persisted to `local_settings`).

---

## 26. Localization — RTL/LTR

### Requirements
- Full support for: English (LTR), Arabic (RTL), Kurdish (RTL — Sorani & Kurmanji), and all other languages.
- All layout uses CSS logical properties exclusively:
  - `margin-inline-start` instead of `margin-left`
  - `padding-inline-end` instead of `padding-right`
  - `border-inline-start` instead of `border-left`
  - `inset-inline-end` instead of `right`
  - `text-align: start` instead of `text-align: left`
- The `dir` attribute is set on `<html>` based on detected or selected language.
- RTL languages flip the entire layout automatically via CSS logical properties.

### Language files
```
/src/locales/
  en.json   (English)
  ar.json   (Arabic)
  ku.json   (Kurdish Sorani)
  ku-kmr.json (Kurdish Kurmanji)
```

### Auto-detection
```typescript
const userLang = navigator.language || 'en'
const rtlLangs = ['ar', 'ku', 'fa', 'he', 'ur']
const isRTL    = rtlLangs.some(l => userLang.startsWith(l))
document.documentElement.dir = isRTL ? 'rtl' : 'ltr'
i18n.changeLanguage(userLang)
```

### Font stack
```css
font-family:
  'Noto Sans Arabic',   /* Arabic / Kurdish */
  'Noto Sans',          /* Latin fallback   */
  system-ui,
  sans-serif;
```

---

## 27. Notification & Background Sync

### Web Push Notifications
- Notification title: app name only ("ZChat")
- Notification body: "New message" — **never reveal sender, content, or any metadata**
- Notification click: deep-link to the specific chat (chat is opened, data decrypted locally)

### Service Worker
- Cache app shell for offline use.
- Push notification handler: receive encrypted event → pass to Worker for decryption → show notification with generic text only.
- Background sync: queue failed outbound messages and retry on reconnect.

---

## 28. Performance Targets

| Metric | Target |
|---|---|
| App shell load (cached) | < 300ms |
| Message send (optimistic UI) | < 16ms (one frame) |
| Ratchet encrypt (Worker) | < 50ms |
| Argon2id derivation (sign-in) | 2–4 seconds (by design — brute-force resistance) |
| Chat list render (100 chats) | < 100ms |
| Message list render (50 msgs) | < 50ms |
| Theme switch | < 32ms (two frames) |
| Realtime message delivery to UI | < 200ms from server push |

### Virtualization
- Use `react-window` or `@tanstack/virtual` for message lists > 50 items.
- Use `react-window` for friend lists > 30 items.

---

## 29. Security Invariants

These must be checked and enforced throughout the entire codebase:

1. **Mnemonic phrase** — must never appear in: localStorage, sessionStorage, IndexedDB, cookies, network requests, logs, error messages.
2. **Master seed** — exists only in the CryptoWorker's memory scope during derivation. Zeroized immediately after fan-out.
3. **Message keys (MK)** — must be zeroized immediately after use in encrypt/decrypt.
4. **storage_key** — must never be written to disk unencrypted.
5. **Plaintext messages** — must never be sent over the network. Only encrypted packets.
6. **Usernames** — must never appear in network requests as plaintext. Only encrypted blobs.
7. **RLS policies** — every table in Supabase must have RLS enabled. No table may have a policy that allows access without verifying `auth.uid()`.
8. **Padding** — every outbound packet must be padded to a 256-byte boundary. No variable-length packets.
9. **Header encryption** — Double Ratchet message headers must always be encrypted. Raw headers must never be transmitted.
10. **Key reuse** — the same (nonce, key) pair must never be used twice. Nonces for AES-GCM must be random 12-byte values or counters that never wrap.
11. **OPK consumption** — each OPK is used exactly once. The server deletes it after claiming. The local private key is deleted after the X3DH computation.
12. **Content Security Policy** — the web app must have a strict CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' <supabase-url> wss://<supabase-url>`.

---

## 30. File & Folder Structure

```
zchat/
├── apps/
│   └── web/                         # React + Vite frontend
│       ├── index.html
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── workers/
│       │   │   └── crypto.worker.ts          # All crypto
│       │   ├── lib/
│       │   │   ├── crypto/
│       │   │   │   ├── kdf.ts                # Argon2id, HKDF
│       │   │   │   ├── ratchet.ts            # Double Ratchet
│       │   │   │   ├── x3dh.ts               # X3DH hybrid
│       │   │   │   ├── keys.ts               # Key types
│       │   │   │   └── padding.ts            # Padmé
│       │   │   ├── db/
│       │   │   │   ├── schema.ts             # IDB schema
│       │   │   │   └── queries.ts            # All DB queries
│       │   │   ├── api/
│       │   │   │   ├── client.ts             # Supabase client
│       │   │   │   └── routes.ts             # All API calls
│       │   │   └── realtime/
│       │   │       └── channel.ts            # Realtime subscription
│       │   ├── stores/
│       │   │   ├── session.store.ts
│       │   │   ├── chats.store.ts
│       │   │   ├── friends.store.ts
│       │   │   ├── messages.store.ts
│       │   │   └── settings.store.ts
│       │   ├── pages/
│       │   │   ├── Auth/
│       │   │   │   ├── SignIn.tsx
│       │   │   │   └── SignUp/
│       │   │   │       ├── Step1GeneratePhrase.tsx
│       │   │   │       ├── Step2VerifyPhrase.tsx
│       │   │   │       └── Step3Username.tsx
│       │   │   └── App/
│       │   │       ├── Layout.tsx            # Sidebar + main area
│       │   │       ├── ChatList.tsx
│       │   │       ├── ChatView.tsx
│       │   │       ├── FriendsList.tsx
│       │   │       ├── FriendRequests.tsx
│       │   │       └── Settings.tsx
│       │   ├── components/
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── ReactionBar.tsx
│       │   │   ├── TypingIndicator.tsx
│       │   │   ├── CheckmarkIcon.tsx        # SVG checkmarks
│       │   │   ├── LoadingSpinner.tsx
│       │   │   └── PhraseGrid.tsx
│       │   ├── icons/                        # All SVG icons as React components
│       │   │   ├── Send.tsx
│       │   │   ├── Edit.tsx
│       │   │   ├── Delete.tsx
│       │   │   ├── Block.tsx
│       │   │   ├── Settings.tsx
│       │   │   └── ... (all SVG-based, no emoji, no icon fonts)
│       │   ├── i18n/
│       │   │   └── locales/
│       │   │       ├── en.json
│       │   │       ├── ar.json
│       │   │       └── ku.json
│       │   ├── themes/
│       │   │   ├── palettes.ts
│       │   │   ├── materials.ts
│       │   │   └── shapes.ts
│       │   └── hooks/
│       │       ├── useCryptoWorker.ts
│       │       ├── useOptimisticAction.ts
│       │       └── useRealtime.ts
│       └── public/
│           └── sw.js                        # Service Worker
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_users.sql
│   │   ├── 002_friendships.sql
│   │   ├── 003_chats_messages.sql
│   │   ├── 004_reactions_events.sql
│   │   ├── 005_blocks.sql
│   │   └── 006_rls_policies.sql
│   └── functions/
│       ├── auth-register/
│       │   └── index.ts
│       ├── auth-login/
│       │   └── index.ts
│       ├── prekey-bundle/
│       │   └── index.ts
│       ├── friend-request/
│       │   └── index.ts
│       ├── message-send/
│       │   └── index.ts
│       ├── message-event/
│       │   └── index.ts
│       └── block/
│           └── index.ts
│
├── package.json
└── ZCHAT_AGENT_SPEC.md              # This file
```

---

## 31. Environment Variables

```env
# Supabase
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# App
VITE_APP_NAME=ZChat
VITE_APP_VERSION=1.0.0

# Crypto parameters (do not change after launch — changing breaks existing accounts)
VITE_ARGON2_MEMORY=262144
VITE_ARGON2_ITERATIONS=3
VITE_ARGON2_PARALLELISM=4
VITE_SPK_ROTATION_DAYS=30
VITE_OPK_BATCH_SIZE=100
VITE_OPK_REPLENISH_THRESHOLD=20
VITE_PACKET_PAD_BLOCK=256
```

---

## 32. Agent Build Order

The agent must build the application in this exact order to avoid dependency issues:

```
Phase 1 — Foundation
  1.1  Set up Vite + React + TypeScript + Tailwind
  1.2  Set up Supabase project + run all migrations
  1.3  Implement crypto primitives (kdf.ts, keys.ts, padding.ts)
  1.4  Implement CryptoWorker + comlink interface
  1.5  Implement IndexedDB schema (db/schema.ts, db/queries.ts)

Phase 2 — Identity & Auth
  2.1  Implement Argon2id + HKDF key derivation (Worker)
  2.2  Implement BIP-39 mnemonic generation + verification
  2.3  Implement Sign Up Step 1, 2, 3 (UI + Worker integration)
  2.4  Implement Sign In (phrase + saved logins)
  2.5  Implement session store + Remember Me + PIN wrap
  2.6  Implement /auth/register + /auth/login Edge Functions

Phase 3 — X3DH & Ratchet
  3.1  Implement ML-KEM-768 encap/decap
  3.2  Implement Hybrid X3DH (Alice + Bob sides)
  3.3  Implement Double Ratchet (full state machine)
  3.4  Implement per-purpose sub-ratchets
  3.5  Implement header encryption
  3.6  Implement Padmé padding + ChaCha20 outer layer

Phase 4 — Backend Routes
  4.1  /prekey-bundle Edge Function
  4.2  /friend-request + /friend-accept Edge Functions
  4.3  /message/send + /message/event Edge Functions
  4.4  /message delete variants + /chat delete variants
  4.5  /block + /unblock Edge Functions
  4.6  /opk/replenish Edge Function
  4.7  Supabase Realtime channel configuration

Phase 5 — Core UI
  5.1  App layout (sidebar + main area, responsive mobile/desktop)
  5.2  Chat list page
  5.3  Chat view + message bubbles + scroll
  5.4  Message input + send
  5.5  Friends list + friend requests tabs
  5.6  Optimistic UI hooks (useOptimisticAction)
  5.7  Realtime subscription + cache sync

Phase 6 — Features
  6.1  Edit message
  6.2  Delete message (for me + for everyone)
  6.3  Delete chat (for me + for everyone)
  6.4  Reactions (8 types, SVG icons)
  6.5  Typing indicator
  6.6  Read receipts + checkmark icons
  6.7  Block/unblock

Phase 7 — Settings & Themes
  7.1  8 palette themes
  7.2  5 material styles
  7.3  4 shape styles
  7.4  Settings screen
  7.5  Live theme switching

Phase 8 — Localization
  8.1  i18next setup
  8.2  English, Arabic, Kurdish translation files
  8.3  RTL layout with CSS logical properties
  8.4  RTL auto-detection

Phase 9 — Polish & Hardening
  9.1  Service Worker + offline cache
  9.2  Push notification (generic text only)
  9.3  Background sync + retry queue
  9.4  App lock screen (PIN + biometric placeholder)
  9.5  OPK replenishment trigger
  9.6  SPK rotation logic
  9.7  Security audit: verify all 12 invariants from §29
  9.8  Performance audit: verify all targets from §28
  9.9  CSP headers
```

---

## Appendix A — HKDF Info Labels Registry

All HKDF `info` labels used in the system. Labels must never be reused for different purposes.

```
zchat-identity-sign-v1       → Ed25519 identity signing key
zchat-identity-dh-v1         → X25519 long-term DH key
zchat-spk-seed-v1            → Signed PreKey seed
zchat-opk-seed-v1            → One-Time PreKey pool seed
zchat-opk-{N}-v1             → Individual OPK derivation (N = index)
zchat-spk-{epoch}-v1         → SPK rotation (epoch = unix timestamp / 86400 / 30)
zchat-username-enc-v1        → Username AES-256-GCM key
zchat-auth-v1                → Auth token HMAC key
zchat-sqlcipher-v1           → Local DB AES-256-GCM key
zchat-x3dh-hybrid-v1         → X3DH classical + Kyber combine
zchat-ratchet-v1             → KDF ratchet (kdfRK)
zchat-msg-ratchet-v1         → Message ratchet root
zchat-react-ratchet-v1       → Reaction ratchet root
zchat-meta-ratchet-v1        → Metadata ratchet root
zchat-friend-ratchet-v1      → Friend request ratchet root
```

---

## Appendix B — SVG Icon List

All icons must be implemented as inline SVG React components. No emoji. No icon font. No external icon library (to avoid CDN dependency and ensure RTL rendering correctness).

```
Send, Edit, Delete, DeleteForEveryone, Block, Unblock,
Settings, FriendAdd, FriendAccept, FriendReject,
CheckSingle, CheckDouble, CheckDoubleRead,
Dice (regenerate phrase), Clipboard (copy),
Lock, Unlock, Fingerprint, EyeOpen, EyeClosed,
Search, Back (arrow), MenuHamburger,
React_Heart, React_ThumbsUp, React_ThumbsDown,
React_Laugh, React_Wow, React_Sad, React_Fire, React_Clap,
Palette, Material, Shape, Language,
NotificationBell, TypingDots (animated), Spinner (animated)
```

---

*End of ZChat Agent Specification v1.0*
*This document is the single source of truth for the AI agent. All implementation decisions must reference and comply with this document.*
