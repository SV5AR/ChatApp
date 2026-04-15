# ZChat Development & Tracking

This file tracks the ongoing goals, architectural mandates, and the active TODO list for ZChat.

## 🎯 Core Project Goals
- [ ] **Security First:** Maintain Ed25519 signature-based auth and Double Ratchet E2EE.
- [ ] **UI Flexibility:** Ensure all features work across **Default**, **Telegram**, and **Sidebar** layouts.
- [ ] **Reliability:** Bulletproof realtime sync with fallback reconciliation.
- [ ] **Consistency:** Adhere to Palette x Material x Shape x Layout theme dimensions.

## 🏗️ Architectural Pillars (The "Golden Rules")
1. **Confirmation Protocol:** NEVER proceed with code changes until the user has verified my "Understanding & Strategy" and issued a "Proceed" directive.
2. **The `chat_rows` Truth:** Conversations only exist if present in `chat_rows`.
3. **Edge Gatekeeper:** All mutations must pass through the `auth-signin` Edge Function.
4. **Deterministic ID:** User ID = SHA-256(Public Key).
5. **Cache Integrity:** Keep `schemaApi`, `App.jsx`, and `Chat.jsx` caches in sync.

## 📝 TODO List

### 🚀 Active Tasks
*None yet. Awaiting your next directive!*

### ⏳ Backlog
- [ ] Refactor `Chat.jsx` (Currently ~6k lines) into modular hooks.
- [ ] Improve Realtime reconciliation for long-term offline states.
- [ ] Audit performance of multi-layer caching.

### ✅ Completed
- [x] Initial Project Audit & Schema Mapping.
- [x] Creation of `GEMINI_TODO.md` tracking system.
- [x] Standardize Appearance, Friends, and Settings modals (Dimensions, Z-Index, and Overlay).
- [x] Fix Appearance modal clickability (Z-Index: 999) and exact dimensional matching.
- [x] Fix Appearance modal "whole-page" shadow by removing `createPortal`.
- [x] Verify project stability with `npm run build`.
- [x] Synchronize modal roundness with theme shape variables (`var(--app-radius-xl)`).
- [x] Remove the "Pill" shape option and implement fallback logic.
- [x] Fix tab misalignment and implement dynamic "fill" layout for tab containers in all layouts.
- [x] Resolve React padding style conflicts in Telegram layout tabs.

---
*Note: Before any task moves to 'Active', I will state my understanding for your verification.*
