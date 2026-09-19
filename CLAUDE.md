# CLAUDE.md — Fantasy MES League

Read this before changing anything. It is the whole context for this project:
what it is, what is already built, the rules it has to obey, and the decisions
that have already been argued out so they do not get re-litigated by accident.

---

## 1. What this is

Youssef is a student at Modern English School Cairo. He and roughly 15–25
friends play football at school most days. FML turns those real matches into a
fantasy league.

The twist that makes this different from FPL: **every participant is both a
fantasy manager and a fantasy player.** Youssef picks a team of nine of his
friends. When one of them scores in the real school match, Youssef gets the
points. Managers can pick themselves. The same player can be in many teams.
Real-life teams are irrelevant — two players on opposite sides in the real match
both score for whoever picked them.

**Stakes:** the manager with the lowest score each week does a forfeit. That is
settled off the site, but it is why data integrity matters more than in a
typical school project. People have a reason to cheat.

---

## 2. Current status

The app is **built and working**, deployed to Vercel with a Supabase backend.
Youssef is the moderator. The remaining work is refinement, not construction.

He is not a professional developer. Explain what you changed in plain language,
and tell him exactly which files to copy into his cloned repo. He uses **GitHub
Desktop** to commit and push; Vercel redeploys automatically.

---

## 3. The rules of FML — authoritative

These are the league's rules. They override any FPL convention you might assume.

**Squad**
- Nine players. **No bench.** No positions — anyone can fill any place.
- Budget **70.0**. Every registered player has a price set by moderators.
- Budget is enforced server-side. An over-budget squad is rejected.

**Team changes**
- Two per gameweek. A "team change" means changing your nine.
- Changing one player or all nine costs **exactly one change**. This is why the
  UI batches edits into a draft and applies them on Save.
- Free before the gameweek starts. Resets each gameweek. No carryover.
- Captain changes and chips never cost a team change.

**Captain**
- Captain scores 2×. Vice-captain is the backup.
- If the captain did not play, the armband passes to the vice automatically.
- If neither played, no multiplier at all.

**Scoring** (identical for every player, no positional differences)

| Action | Points |
|---|---|
| Goal | +5 |
| Assist | +3 |
| Save | +1 |
| Clean sheet | +3 |
| Man of the match | +5 |
| Yellow card | −1 |
| Red card | −4 |
| Own goal | −3 |
| Appearance | 0 |

Defensive contributions = tackles + interceptions, scored in bands:
0–4 → 0, 5–9 → +3, 10–14 → +5, 15+ → +7. The band, not per tackle.

Exactly one MOTM per match.

**Chips** — one use of each per term, refreshed when a moderator starts a new term
- **Triple Captain** — captain scores 3×
- **All or Nothing** — captain scores 4×, but if the captain finishes on zero or
  below, the whole day score is halved
- **The Gambler** — back one player: 10+ earns +10, 5–9 is neutral, under 5 costs 10
- **Wildcard** — unlimited changes to your nine for the rest of the gameweek

Bench Boost was removed when the bench was removed. Do not resurrect it.

**Time**
- A gameweek runs Sunday → Saturday. Gameweeks are numbered.
- Matchdays are named by weekday: "Tuesday Matchday". **Never** "Matchday 3".
- One fixture is created automatically for each school day (Sun–Thu by default).
- Lineups lock at a daily deadline (15:30 by default) and are frozen as a
  snapshot. Changing your team on Tuesday must never alter Sunday's score.
- Weekly scores reset; season totals accumulate. Ties for last share last place.

---

## 4. Rulings already made

The original spec left these open. They are decided — do not silently change them.

- **Clean sheets** are recorded per player by the moderator, not inferred from a
  scoreline. This sidesteps the contradiction that clean sheets are a team
  outcome in a game where real teams are irrelevant.
- **All or Nothing halves only a positive day.** Halving a negative total would
  reward a bad captain. Guarded and tested.
- **Halved scores round to nearest.**
- **The Gambler** is judged on the player's own score *before* any captain
  multiplier, and the pick must be in the scoring team.
- **Triple Captain and All or Nothing cannot both be armed on the same day** —
  they both replace the armband multiplier.
- **Repricing does not force sales.** Existing squads keep their players; the new
  price applies to squads built afterwards.
- **Deleting a player who has appeared in a published match is refused.**
  Deactivate instead. History outranks tidiness.

---

## 5. Architecture

No build step. No framework. No bundler. Deliberately.

```
index.html          the entire front end: one file, vanilla JS, inline CSS
api/config.js       returns the public Supabase URL + anon key
api/clubs.js        public list of club names (for the log-in dropdown)
api/bootstrap.js    creates a profile + player row after sign-up
api/league.js       the single read: returns the whole league state
api/team.js         all manager writes (squad, captain, chips, posts, club name)
api/admin.js        all moderator writes (players, prices, stats, publish, gameweeks)
api/_lib/engine.js  the scoring engine — pure functions, no I/O
api/_lib/core.js    auth, scheduling, deadline locking, recalculation, league load
supabase/schema.sql full schema with row level security
supabase/migration-prices.sql  for databases created before prices existed
```

**Security model — the important part.** The browser has *read-only* database
access. Row level security grants `select` to authenticated users and grants no
insert, update or delete to anyone. Every write goes through an API function
using the service-role key, after checking the caller's identity and role.

A manager cannot change a score, a stat, a chip, a price or another manager's
team from the browser console, because the browser holds no write permission at
all. **Never add a client-side write path.** If a new feature needs to write,
add an action to `api/team.js` or `api/admin.js` and validate it there.

**Scoring authority.** `api/_lib/engine.js` is the only place points are
calculated. On publish, the server writes `player_match_scores` and
`manager_day_scores` and the front end only ever displays those stored numbers.
`index.html` contains a *copy* of the engine used solely to preview a draft
match for the moderator before publishing. If you change scoring rules, change
both and say so.

**Recalculation is idempotent.** `recomputeMatch` deletes and rewrites a match's
scores, so correcting a statistic can never double-count.

---

## 6. Authentication

Supabase Auth with email and password, except managers never see an email.
The club name is the username; `Store.addressFor()` slugifies it into
`gattouz69-fc@fml-league.app` behind the scenes.

Consequences, already accepted:
- **Confirm email must be OFF** in Supabase, or nobody can sign in.
- **No password reset exists.** A forgotten password means a moderator deletes
  that user in Supabase → Authentication → Users.
- The club name must be typed identically each time, which is why the log-in tab
  uses a dropdown of existing clubs rather than a text box.

Log in refuses a club that was never created. Create club refuses a name that is
taken. The first account ever created becomes the moderator.

---

## 7. Front-end conventions

- Rendering is a single `render()` that rebuilds `#app` from string concatenation.
  There is no virtual DOM. Views are functions returning HTML strings.
- All user input goes through `esc()`.
- Events are delegated from one `document` click listener reading `data-*`
  attributes. Add a new attribute to the selector list when adding a control.
- `Store` holds everything. `Store.act()` sends a write and absorbs the whole
  refreshed league back, so the screen cannot drift from the database.
- Polling every 25 seconds keeps devices in step; it also refreshes on tab focus.
- State lives in `S`. `S.draft` is the unsaved team on the My Team pitch.

**Design tokens** (keep these — the logo and crest match them):
ink `#060F18`, panel `#0C1A26`, line `#1B3143`, chalk `#E8F1F5`,
muted `#7D96A8`, amber `#FFB23F`, teal `#34D8B2`, red `#FF6363`.
Display font Anton, body font Inter. Dark throughout.

**Navigation** is deliberately short: Dashboard, My Team, Gameweek, Leaderboard,
Player Stats, Scoring, Social Media, plus Admin for moderators only. Youssef has
pushed back on unnecessary tabs. Do not add one without asking.

**Player Stats shows exactly five categories**: goals, assists, clean sheets,
yellow cards, red cards. Tackles, interceptions, saves and MOTM are collected for
scoring but deliberately not displayed as leaderboards.

---

## 8. Testing

There is no test framework. Everything was verified with throwaway Node
harnesses that stub `document`, `window` and `fetch`, then call the view
functions and engine directly. Reproduce that approach rather than adding a
framework:

```bash
# extract the front-end JS out of index.html, then node --check it
python3 -c "s=open('index.html').read(); \
  js=s.split('\"use strict\";',1)[1].rsplit('</script>',1)[0]; \
  open('/tmp/front.js','w').write('\"use strict\";'+js)"
node --check /tmp/front.js
```

The engine has been checked against every rule including the worked examples:
a goal + 2 assists + 7 defensive contributions + clean sheet + MOTM + yellow =
21 points; captain-to-vice transfer; All or Nothing on a negative day; all three
Gambler outcomes. **If you touch the engine, re-verify those.**

---

## 9. Known gaps

- **No season reset.** Gameweeks and terms roll over; starting a fresh season
  would mean archiving the current tables. Not built.
- **No password reset**, by design of the username scheme.
- **Match state** (upcoming / live / final / postponed) is set by hand in Admin.
- **Updates poll** every 25 seconds rather than pushing. Supabase Realtime would
  make it instant.
- **No cover for absentees.** With the bench gone, a player who does not turn up
  scores 0 and nobody replaces them. Only the vice-captain inherits anything.
- **Only four chips** now that Bench Boost is gone. Youssef may want a fifth; it
  should be something new rather than a revived bench mechanic.

---

## 10. How to work with Youssef

- He iterates fast and changes direction. Expect rules to shift; when they do,
  check whether the change breaks something elsewhere (removing the bench killed
  Bench Boost, for instance) and **say so rather than quietly patching around it**.
- Tell him plainly when something cannot be done, and why. He would rather hear
  a limitation than discover it after deploying.
- He deploys by hand through GitHub Desktop. End changes with a short list of
  which files he needs to copy across.
- Verify before claiming. He has asked more than once not to be told something
  works when it has only been written. Run the checks.

---

## 11. Environment

Vercel project with three environment variables, set in project settings:

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY      # server only, never sent to the browser
```

Zero-config Vercel deploy: static `index.html` at the repo root, serverless
functions in `api/`. Files under `api/_lib/` are not routed because of the
leading underscore. Nothing is nested in a subfolder — the whole project sits at
the repo root, which broke the first deploy attempt and is worth checking if
functions go missing.
