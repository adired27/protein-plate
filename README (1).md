# Protein Plate

Track the protein you actually eat. Sign in with Google, photo your plate, enter your eggs, nuts and chicken, and Claude checks the numbers against the photo before they're saved.

## How it fits together

| Piece | Job | Cost |
|---|---|---|
| GitHub | Holds this code | Free |
| Vercel | Hosts the app and runs `api/check.js` | Free (Hobby plan) |
| Supabase | Google sign-in and each user's saved meals | Free tier |
| Anthropic API | The photo checks, on your key | Pay per use, capped by you |

Photos are never stored. They go to Claude for the check and are thrown away; only the numbers are saved.

## Files

- `index.html`, `app.js` — the app people use
- `config.js` — your public Supabase settings (safe to commit)
- `api/check.js` — server code; the only place your Anthropic key is used
- `supabase/schema.sql` — database tables and the rules that keep each user's data private
- `.env.example` — the secret settings Vercel needs (never commit real values)

---

## Setup (about 30–45 minutes, once)

### 1. Supabase: database and sign-in

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon** (or **publishable**) key. Put both in `config.js`.

### 2. Google: allow "Continue with Google"

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. Go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name and your email. While it's in testing mode, add your parents' Gmail addresses as test users (or publish the app so anyone can sign in).
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
4. Under **Authorized redirect URIs**, add `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (use your real Supabase project URL).
5. Copy the **Client ID** and **Client secret**.
6. Back in Supabase: **Authentication → Sign In / Providers → Google**. Turn it on and paste the ID and secret.

### 3. Anthropic: a key with a spending cap

1. In the [Claude Console](https://platform.claude.com), create a workspace called **Protein Plate**.
2. Create an API key inside that workspace. Copy it somewhere safe; you'll paste it into Vercel, nowhere else.
3. In the workspace's **Limits** tab, set a **monthly spend limit** (for example $5) and an email alert (for example at $2).

### 4. GitHub

Create a new repository and upload these files (or `git push`). `.gitignore` already keeps secret files out.

### 5. Vercel: put it online

1. At [vercel.com](https://vercel.com), click **Add New → Project** and import the GitHub repo. No build settings needed.
2. Before deploying, open **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` — the key from step 3
   - `SUPABASE_URL` — same as in `config.js`
   - `SUPABASE_ANON_KEY` — same as in `config.js`
   - Optional: `DAILY_CHECK_LIMIT` (default 10 per person per day), `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`)
3. Deploy. You'll get a link like `https://protein-plate.vercel.app`.

### 6. Tell Supabase where the app lives

In Supabase: **Authentication → URL Configuration**. Set **Site URL** to your Vercel link, and add it under **Redirect URLs** too.

Open the link on your phone, tap **Continue with Google**, and log a meal. Then use your browser's **Add to Home Screen** so it opens like an app.

---

## Safety built in

- **Your key stays secret.** It only exists in Vercel's environment variables and is used only by `api/check.js`.
- **Every user sees only their own data.** Row-level security in the database enforces this even if the app has a bug.
- **Per-person cap.** Each user gets `DAILY_CHECK_LIMIT` photo checks per day (resets at midnight UTC). A failed check still counts, so a stuck user may need to wait until the reset.
- **Monthly cap.** The workspace spend limit is your hard ceiling. If it's reached, photo checks pause and the app says so; saved history still works.

## Tuning

- **Accuracy vs. cost:** Haiku is the cheapest model. If chicken estimates look off on real plates, set `ANTHROPIC_MODEL=claude-sonnet-5` in Vercel. It's more accurate at judging portions and costs more per check.
- **Protein values** live at the top of `app.js` (`P = { eggs: 6, nuts: 6, chicken: 0.27 }`).
- **The AI's instructions** are in `buildPrompt()` in `api/check.js`.

## Testing on your computer (optional)

```
npm i -g vercel
cp .env.example .env.local   # fill in real values
vercel dev
```

Then open http://localhost:3000. Add `http://localhost:3000` to Supabase's Redirect URLs first so Google sign-in can return there.
