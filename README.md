# Fantasy MES League

A real fantasy football league for MES, where the fantasy players are the
participants themselves. Every manager is also a footballer; their real-life
performances at school generate the points their rivals collect.

Squads are **9 players, no bench**, built from a **70.0 budget**. Every player
carries a price that moderators set.

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

## Which build is live

The sidebar shows a build number, and so does the sign-in screen. The current
one is **build 5 (nine-a-side)**. `api/config.js` reports its own version, and
**Check connection** compares the two:

- both on 5 → the update landed
- server on a lower number → the `api` folder did not update
- server higher than the page → `index.html` did not update, or your browser is
  serving a cached copy (hard-refresh with Ctrl+Shift+R, or Cmd+Shift+R)

If you ever think an update has not arrived, check there first rather than
guessing.

## Deploying it

You need a laptop for this. Roughly half an hour.

### 1. Create the database

1. Go to supabase.com, sign up, create a new project. Pick a strong database
   password and keep it somewhere safe.
2. Wait for it to finish provisioning (a minute or two).
3. Open **SQL Editor**, paste the entire contents of `supabase/schema.sql`,
   and run it. It creates every table and locks writes down.
   *Already ran an older schema?* Run `supabase/migration-prices.sql` instead —
   it adds the price and budget columns without touching your data.
4. Open **Authentication → Providers → Email**. Turn **Confirm email** OFF.
   This is required, not optional: managers sign in with a club name and
   password, never an email address, so there is no inbox to confirm from.
   If this is left on, nobody can get in.
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

1. Open the link and enter your club name, your name and a password. That one
   screen signs you in if the club exists and creates it if it does not —
   **the first account to be created becomes the moderator**, so do this
   before sending the link to anyone else.
2. Go to **Admin** and add every participant as a player.
3. Send the link to your friends. They create accounts, name their clubs, pick
   their 11 and set their nine.

Fixtures appear on their own for every school day, so there is nothing to
schedule. Gameweeks roll over on their own too.

---

## The daily routine

1. Everyone sets their nine and captain before the deadline (15:30 by default,
   changeable in Admin). Team edits are made on the pitch in **My Team** and
   applied together when you press Save, so swapping three players still costs
   one team change, not three.
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
- Mark a starter as not having played. They should score 0, and the armband
  should move to the vice-captain if the captain was the absentee.

---

## What is already verified

The scoring engine ships with the league's own worked examples as tests:
defensive contribution bands, the 21-point player, captain-to-vice transfer,
bench cover with both bench players, Triple Captain, Bench Boost, All or
Nothing including the negative-day edge case, and all three Gambler outcomes.

---

## Prices and the budget

Every registered player has a price, and a manager's nine must fit inside the
budget (70.0 by default). The limit is enforced on the server, so a manager
cannot get round it by editing anything in their browser — an over-budget squad
comes back rejected with the exact amount it is over by.

Moderators set prices on the Admin page: type a new number next to a player and
it saves when you click away. The budget itself is editable in **League
controls**. New players default to 5.0; you can set a price as you add them.

Repricing a player does not force anyone to sell. Existing squads stay as they
are; the new price applies to squads built from then on.

## Deleting accounts

Moderators can delete both managers and players from the Admin page. Both ask
you to type the name first, because neither can be undone.

Deleting a **manager** removes their login, squads, frozen lineups, scores,
chips and club posts. Everyone else keeps every point they scored. If that
person had already played in a published matchday, their *player* record is
kept but deactivated, so old results stay intact; if they never played, the
player record goes too.

Deleting a **player** takes them out of every squad that had picked them. A
player who has appeared in a published matchday is refused — deactivate them
instead, which keeps the history but stops anyone picking them again.

Deleting the only moderator account is blocked, and you cannot delete yourself.

## No bench

There are nine players and nothing behind them. If one of your nine does not
turn up, they score 0 and nobody comes on. The only cover is the vice-captain,
who inherits the armband when the captain is absent.

**Bench Boost has been removed** — with no bench it had nothing to boost. That
leaves four chips per term: Triple Captain, Wildcard, All or Nothing and The
Gambler. If you want a fifth, it has to be something new rather than a revived
Bench Boost.

## Known gaps

- **Season reset.** Gameweeks and terms roll over; there is no button yet for
  starting a brand-new season. Adding one means archiving the current tables.
- **No password reset.** Sign-in uses a club name rather than a real email, so
  there is no inbox to send a reset link to. If someone forgets their password,
  a moderator has to delete that user in Supabase (Authentication → Users) and
  let them enter again.
- **Club names are usernames**, so a typo creates a second, empty club rather
  than signing you in. Tell everyone to write theirs down exactly.
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
