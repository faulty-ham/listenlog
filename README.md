# ListenLog

Personal music album tracker. Hosted on GitHub Pages, data stored in Supabase.

---

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Pick a name (e.g. `listenlog`), set a database password, choose a region
3. Wait ~2 minutes for it to provision

### 2. Create the database table

In your Supabase project, go to **SQL Editor** and run:

```sql
-- Table to store each user's full library
create table listenlog_data (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  albums    jsonb not null default '[]',
  originals jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Users can only read/write their own row
alter table listenlog_data enable row level security;

create policy "Users manage own data" on listenlog_data
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

### 3. Get your API credentials

In your Supabase project → **Project Settings** → **API**:

- Copy **Project URL** (looks like `https://abcdefgh.supabase.co`)
- Copy **anon public** key (long JWT string)

### 4. Add credentials to the app

Open `index.html` and find these two lines near the bottom:

```js
const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
```

Replace with your actual values:

```js
const SUPABASE_URL  = 'https://abcdefgh.supabase.co';
const SUPABASE_ANON = 'eyJhbGci...your full anon key...';
```

### 5. Create your account

Open the app (locally or after deploying) and click **Sign up** to create your account with email + password. Supabase sends a confirmation email — click the link, then sign in.

### 6. Deploy to GitHub Pages

1. Create a new GitHub repository (name it `listenlog` or anything you like)
2. Push this folder to it:
   ```bash
   git init
   git add .
   git commit -m "Initial deploy"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
3. In GitHub → **Settings** → **Pages** → Source: **GitHub Actions**
4. The workflow runs automatically and your app is live at:
   `https://YOUR_USERNAME.github.io/YOUR_REPO/`

### 7. Fix Supabase auth redirect (important)

In Supabase → **Authentication** → **URL Configuration**:
- Set **Site URL** to your GitHub Pages URL (e.g. `https://yourname.github.io/listenlog`)
- Add it to **Redirect URLs** as well

This ensures email confirmation links work correctly.

---

## Security

- The GitHub Pages URL is public but the app shows a login screen to anyone who visits
- Your data lives in Supabase behind row-level security — only your account can read or write it
- The anon key in the HTML is safe to expose — it only grants access after authentication

## Migrating existing data

If you've been using the app locally (localStorage), export your data first:
1. Open the old local copy → **Export** button → saves a `.json` file
2. Sign in to the hosted version → **Import JSON** → select that file
