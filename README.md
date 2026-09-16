# Fantasy MES League

A real fantasy football league for MES, where the fantasy players are the
participants themselves. Every manager is also a footballer; their real-life
performances at school generate the points their rivals collect.

Squads are **11 players: 9 starters and 2 bench.**

---

## What this is

| Layer | Where it lives |
|---|---|
| Front end | `index.html` — one self-contained page, no build step |
| API | `api/*.js` — serverless functions on Vercel |
| Scoring engine | `api/_lib/engine.js` — pure functions, the only place points are calculated |
| Database | Supabase Postgres, schema in `supabase/schema.sql` |
| Accounts | Supabase Auth, email and password |

The browser has **read-only** access to the database. Every write goes through
the API, which checks who you are first. A manager cannot change a score, a
match statistic, a chip or anyone else's team from the developer console,
because the browser holds no write permission at all.

---

## Deploying it

You need a laptop for this. Roughly half an hour.

### 1. Create the database

1. Go to supabase.com, sign up, create a new project. Pick a strong database
   password and keep it somewhere safe.
2. Wait for it to finish provisioning (a minute or two).
3. Open **SQL Editor**, paste the entire contents of `supabase/schema.sql`,
   and run it. It creates every table and locks writes down.
4. Open **Authentication → Providers → Email**. Turn **Confirm email** off
   while you are setting the league up, so your friends can sign in
   immediately. Turn it back on later if you want.
5. Open **Project Settings → API** and copy three values:
   - Project URL
   - `anon` `public` key
   - `service_role` `secret` key — treat this one like a password, it bypasses
     every security rule

### 2. Put the code on GitHub

```bash
cd fml-app
git init
git add .
git commit -m "Fantasy MES League"
```

Create an empty repository on GitHub, then follow the two lines it shows you to
push.

### 3. Deploy on Vercel

1. vercel.com → sign in with GitHub → **Add New Project** → import the repo.
2. Framework preset: **Other**. No build command. Leave the output directory
   blank.
3. Before deploying, add three environment variables:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your project URL |
   | `SUPABASE_ANON_KEY` | the anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service role key |

4. Deploy. You get a link like `fml.vercel.app`.

### 4. Start the league

1. Open the link and create your account first — **the first account to sign up
   becomes the moderator.**
2. Go to **Admin** and add every participant as a player.
3. Send the link to your friends. They create accounts, name their clubs, pick
   their 11 and set their nine.

Fixtures appear on their own for every school day, so there is nothing to
schedule. Gameweeks roll over on their own too.

---

## The daily routine

1. Everyone sets their nine and captain before the deadline (15:30 by default,
   changeable in Admin).
2. The deadline passes. Lineups freeze automatically — that snapshot is what
   gets scored, so changing your team on Tuesday never alters Sunday's result.
3. You play the real match.
4. A moderator opens the matchday in Admin, ticks who played, enters the stats,
   sets the real-life score, and hits **Publish and score**.
5. Points, leaderboards, player stats and everyone's dashboard update. Managers
   see it within about 25 seconds without touching anything.

If a statistic was wrong, fix it and publish again. Scores are recalculated from
scratch rather than added on top, so a correction can never double-count.

---

## Testing it properly

Sign in on your laptop, and on your phone in a private window as a second
account. Then:

- Both accounts pick squads. Check each sees the other on the leaderboard.
- As moderator, publish a matchday. The second account's points should change
  without reloading.
- Sign out on the phone and back in. The team should be exactly as you left it.
- On the manager account, open developer tools and try to write to the
  database. Every write is rejected — that is row level security doing its job.
- Mark a starter as not having played. The manager should get bench cover, and
  the armband should move to the vice-captain if the captain was the absentee.

---

## What is already verified

The scoring engine ships with the league's own worked examples as tests:
defensive contribution bands, the 21-point player, captain-to-vice transfer,
bench cover with both bench players, Triple Captain, Bench Boost, All or
Nothing including the negative-day edge case, and all three Gambler outcomes.

---

## Known gaps

- **Season reset.** Gameweeks and terms roll over; there is no button yet for
  starting a brand-new season. Adding one means archiving the current tables.
- **Password reset** relies on Supabase's built-in email flow, which needs an
  email provider configured in Supabase before it will actually send.
- **Live match state** is set by hand in Admin. Nothing detects a match
  starting on its own.
- **Updates poll every 25 seconds** rather than pushing instantly. Supabase
  Realtime would make it immediate; polling is simpler and costs nothing.

---

## Where team management lives

The brief allows only six manager tabs, so squad selection, the starting nine,
captaincy, chips and bench cover all sit **inside the Gameweek tab**, underneath
the matchdays. That keeps the navigation to six and puts team decisions next to
the fixtures they apply to.
