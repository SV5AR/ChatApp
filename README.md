# ZChat

ZChat is a security-focused messaging app with a modern multi-layout UI (Default, Telegram-style, Discord-style), encrypted message transport, hardened session validation, and background sync designed to keep chats fresh without manual refresh.

## What ZChat Does

- Secure direct messaging between accepted friends
- Contacts / requests / blocked management with strict action rules
- Real-time + fallback background sync for messages, reactions, and requests
- Multiple responsive layouts with theming, shape styles, and motion polish
- Device features: remember-me, PIN vault, biometric guard, app auto-lock

## Security Model (High Level)

- **Session security:** every protected action is validated server-side via session token checks
- **Replay protection:** mutation endpoints consume one-time nonces to reject replays
- **Encrypted payloads:** message bodies are encrypted; server stores ciphertext blobs
- **Scoped authorization:** server verifies action ownership/scope (friendship, message, block, chat)
- **RLS + edge enforcement:** database access is protected by policies and edge function guards

Important caveat:

- Delivery metadata (timing/routing identifiers) may still be visible to backend infrastructure as part of normal messaging operation.

## Core Behavior Rules

- Chats are listed from `chat_rows` (source of truth for conversation existence)
- Accepted friendship alone does not auto-create a chat row
- Chat row is created when user explicitly starts chat
- Delete/block/unfriend paths cascade cleanup of related chat artifacts

## Tech Stack

- React + Vite
- Supabase (Postgres, Edge Functions, Realtime)
- Web Crypto + app-side secure storage helpers

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Configure env:

```bash
cp .env.example .env
```

Set at least:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

3. Apply database migrations:

```bash
supabase db push
```

4. Deploy edge function (when function code changes):

```bash
supabase functions deploy auth-signin
```

5. Run dev server:

```bash
npm run dev
```

6. Production build:

```bash
npm run build
```

## Repo Hygiene

- Sensitive/local files are ignored via `.gitignore`
- Do **not** commit `.env` or private key material
- Prefer small, reviewable commits for security-sensitive changes

## Recommended Release Flow

- **Commit/push source first**, then build in CI (recommended)
- If no CI yet, run `npm run build` locally **before push** to catch breakage
- Do not commit `dist/` unless your hosting platform explicitly requires it

## License

Add your preferred license in `LICENSE` (MIT/Apache-2.0/etc.) before publishing publicly.
