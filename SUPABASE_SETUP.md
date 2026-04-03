# Supabase Setup Instructions

## 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Create a new project
4. Save your project URL and API key

## 2. Configure Environment Variables

Update `.env` file:

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## 3. Set Up Database Schema

1. In Supabase dashboard, go to SQL Editor
2. Create a new query
3. Copy contents of `supabase_setup.sql` and execute

## 4. Enable Authentication

1. In Supabase dashboard, go to Authentication > Providers
2. Enable Email authentication (enabled by default)
3. Configure email settings if needed

## 5. Run App

```bash
npm run dev
```

The app now supports:

- **User authentication**: Sign up/Sign in with Supabase
- **Friend management**: Send, accept, reject friend requests
- **Settings**: Profile display and master key management (mock for now)
- **Mobile responsive UI**: Built with Tailwind CSS

## Next Steps

- Implement WebCrypto API for key generation
- Integrate private key (master key) storage
- Implement message encryption/decryption
- Build friend conversations view
