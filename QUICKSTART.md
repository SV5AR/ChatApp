# Quick Start Guide - SecureChat

## For Users 👥

### First Time: Creating an Account

```
1. Open https://yourapp.com
2. Tap "Create new account"
3. Enter email & password
4. Tap "Generate Secure Phrase"
   → 12 random words appear
5. WRITE DOWN THE WORDS on paper
   (If lost, account is gone forever!)
6. Tap to reveal & copy phrase
7. Type the words back to confirm
8. Read the warning ⚠️
9. Tap "I Understand, Create Account"
10. Done! Account created & logged in
```

**Important**: 🔐 Your 12-word phrase is like your bank PIN.

- **Keep it safe**: Write on paper, store securely
- **Don't share**: Never tell anyone your phrase
- **Can't recover**: No "forgot phrase" option exists
- **Account access**: Anyone with phrase = full access

### Signing In

```
1. Open https://yourapp.com
2. Paste/type your 12-word phrase
3. Tap "Sign In"
4. All encrypted chats load instantly
```

### Viewing Your Phrase (Settings)

```
1. Tap ⚙️ Settings
2. Scroll to "Recovery Phrase"
3. Tap "View Recovery Phrase"
4. Tap eye icon to show/hide
5. Tap copy icon to copy to clipboard
```

**Remember**: Phrase is sensitive! Don't copy unless private.

---

## For Developers 👨‍💻

### Local Setup (5 minutes)

```bash
# 1. Clone repo
git clone <repo-url>
cd ChatApp

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env

# 4. Edit .env with your Supabase credentials
# Get from: https://supabase.com/dashboard
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...

# 5. Run Supabase migrations
# Go to Supabase Dashboard → SQL Editor
# Paste entire content of: supabase_phrase_auth_migration.sql

# 6. Start dev server
npm run dev

# Output:
# ➜  Local:   https://localhost:5173
# ➜  Network: https://192.168.x.x:5173
```

### Test on Phone

```
1. On iPhone/Android, go to: https://192.168.x.x:5173
2. Safari will warn about self-signed certificate
3. Tap "Show Details" → "Visit this website"
4. App fully loads with crypto support ✓
```

### File Structure

```
src/
├── utils/
│   ├── bip39Auth.js          ← Phrase generation & key derivation
│   ├── secureStorage.js      ← IndexedDB encrypted storage
│   ├── crypto.js             ← AES-GCM & ECDH encryption
│   └── cache.js
├── components/
│   ├── AuthPhrase.jsx        ← Login/signup with phrases (NEW)
│   ├── Settings.jsx          ← View recovery phrase (UPDATED)
│   ├── Header.jsx
│   ├── Conversation.jsx
│   ├── Friends.jsx
│   └── ...
├── context/
│   └── ThemeContext.jsx
├── App.jsx                   ← Uses AuthPhrase (UPDATED)
├── supabaseClient.js         ← Env vars (UPDATED)
└── main.jsx

SQL Migrations/
├── supabase_setup.sql
├── supabase_phrase_auth_migration.sql  ← NEW (run this!)
├── supabase_fix_rls.sql
└── ...
```

### Key Components Explained

**`bip39Auth.js`** (~200 lines)

```javascript
// Generate 12-word phrase
const phrase = generateSecurePhrase();

// Validate user input
if (!validatePhrase(userInput)) {
  /* invalid */
}

// Convert phrase to encryption key
const masterKey = await deriveMasterKeyFromPhrase(phrase);

// Hash phrase for database lookup
const hash = await hashPhraseForStorage(phrase);

// Encrypt phrase for storage
const encrypted = await encryptPhraseForLocalStorage(phrase, masterKey);
```

**`secureStorage.js`** (~150 lines)

```javascript
// Initialize IndexedDB
await initSecureStorage();

// Store encrypted phrase
await saveEncryptedPhrase(encrypted);

// Load encrypted phrase
const encrypted = await loadEncryptedPhrase();

// Decrypt phrase
const phrase = await decryptPhraseFromLocalStorage(encrypted, masterKey);

// Clear on logout
await clearSecureStorage();
```

**`AuthPhrase.jsx`** (~450 lines)

```javascript
// Complete authentication UI
// Replaces old Auth.jsx
// Handles:
// - Sign in with phrase
// - Sign up with phrase generation
// - Phrase confirmation
// - Warning screen
```

---

## Security Verification

### Before Deploying, Verify:

```bash
# ✓ No master key in localStorage
grep -r "localStorage" src/**/*.js
# Should NOT mention master key

# ✓ No hardcoded secrets in source
grep -r "supabase.co\|eyJhbGci" src/
# Should return nothing (only in .env)

# ✓ .env not committed
git status | grep ".env"
# Should show ".env" in status but NOT in committed files

# ✓ Build doesn't leak secrets
npm run build
grep -r "eyJhbGci\|anon_key" dist/
# Should return nothing

# ✓ Dependencies correct
npm list @scure/bip39 @noble/hashes
# Should show installed versions
```

---

## Common Issues & Fixes

### "Missing Supabase credentials"

```
Error: "Missing Supabase environment variables"

Fix: Make sure .env file exists with:
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...

(Get values from Supabase Dashboard → Settings → API)
```

### "Web Crypto not available" (HTTP)

```
Error: window.crypto.subtle is undefined

Fix: App requires HTTPS (or localhost)
- Local: dev server uses HTTPS ✓
- Production: Use Vercel/Netlify (auto HTTPS) ✓
- Custom hosting: Set up SSL certificate
```

### "Invalid phrase format"

```
Error: "Invalid BIP39 phrase"

Fix: Phrase must be 12 words from BIP39 wordlist
- Separate with spaces
- All lowercase
- Exact spelling
- No typos

Examples:
✓ "abandon ability able about above absence absorb abstract abuse access accident"
✗ "abandon ability" (only 2 words)
✗ "abandon abilityy able..." (typo)
```

### "Wrong master key"

```
Error: "OperationError: Wrong master key"

Fix: Master key is password you chose in Settings
- Not your phrase
- Not your password
- The key you set in Settings → Encryption

If forgotten:
1. Settings → Encryption
2. "Reset Encryption Keys"
3. You'll lose access to old encrypted messages
4. Can set new master key for new messages
```

---

## Testing Checklist

### Basic Flow

- [ ] Sign up with generated phrase works
- [ ] Typed-back phrase confirmation required
- [ ] Warning message appears
- [ ] Account created after warning
- [ ] Logged in automatically
- [ ] Can view phrase in Settings
- [ ] Can toggle show/hide phrase
- [ ] Can copy phrase
- [ ] Logout works
- [ ] Login with phrase works

### Security

- [ ] Master key not in localStorage
- [ ] Master key clears on tab close
- [ ] Phrase not in console logs
- [ ] HTTPS required (not HTTP)
- [ ] Invalid phrases rejected
- [ ] Wrong phrase login fails

### Performance

- [ ] Key derivation takes ~0.5s
- [ ] Phrase validation instant
- [ ] Message encryption fast
- [ ] No UI freezing

---

## Debugging Tips

### Enable Verbose Logging

```javascript
// In crypto.js, add:
console.log("Deriving master key...");
const mk = await deriveMasterKeyFromPhrase(phrase);
console.log("Master key ready:", mk.substring(0, 10) + "...");

// In secureStorage.js:
console.log("Saving to IndexedDB...");
await saveEncryptedPhrase(encrypted);
console.log("Saved successfully");
```

### Check IndexedDB Contents

```javascript
// In browser console:
const db = window.indexedDB.databases?.()[0];
console.log("IndexedDB:", db?.name);

// View stored data:
indexedDB.open("chatapp_secure").onsuccess = function (e) {
  const tx = e.target.result.transaction("auth", "readonly");
  const store = tx.objectStore("auth");
  store.getAll().onsuccess = (v) => console.log("Stored:", v.target.result);
};
```

### Check Supabase Auth State

```javascript
// In browser console:
const { data } = await supabase.auth.getSession();
console.log("Session:", data);

// Check user by phrase hash:
const { data } = await supabase
  .from("users")
  .select("*")
  .eq("id", "user-id-here");
console.log("User record:", data);
```

---

## Production Deployment

### Vercel/Netlify (Recommended)

```bash
# 1. Push code to GitHub
git push origin main

# 2. Connect repo to Vercel/Netlify
# - Go to vercel.com or netlify.com
# - Import repository
# - Add environment variables:
#   VITE_SUPABASE_URL
#   VITE_SUPABASE_ANON_KEY

# 3. Deploy
# - Automatic on push
# - HTTPS auto-configured
# - Runs npm build automatically
```

### Self-Hosted

```bash
# 1. Build
npm run build

# 2. Serve dist/ folder with web server
npm install -g serve
serve dist

# 3. Set up HTTPS (Let's Encrypt)
# Use nginx or Apache configuration

# 4. Set environment variables
export VITE_SUPABASE_URL=...
export VITE_SUPABASE_ANON_KEY=...
```

---

## Support & Questions

See **SECURITY.md** for detailed security information.
See **IMPLEMENTATION_COMPLETE.md** for full changelog.

Need help?

1. Check README.md
2. Review SECURITY.md
3. Look at test examples in SECURITY.md

---

**Happy secure chatting** 🚀

Built with 🔐 Bitcoin-grade security
