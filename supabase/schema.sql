-- ===========================================================================
-- Fantasy MES League — database schema
-- Run this once in the Supabase SQL editor.
--
-- Security model: every table denies INSERT / UPDATE / DELETE to logged-in
-- users. Reads are allowed. All writes happen in the serverless API using the
-- service-role key, which bypasses RLS, and only after the API has checked who
-- the caller is and what they are allowed to do. A manager cannot change a
-- score, a stat, a chip or someone else's team from the browser console,
-- because the browser has no write access at all.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- people ---
create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  price       numeric(4,1) not null default 5.0,   -- squad cost, in millions
  created_at  timestamptz not null default now()
);

-- one row per signed-up account; id matches auth.users.id
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  team_name   text not null default 'Unnamed FC',
  is_admin    boolean not null default false,
  player_id   uuid references players(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- league ---
create table if not exists config (
  id            int primary key default 1 check (id = 1),
  league        text not null default 'Fantasy MES League',
  current_gw    int  not null default 1,
  current_term  int  not null default 1,
  deadline      text not null default '15:30',      -- local time, HH:MM
  timezone      text not null default 'Africa/Cairo',
  school_days   int[] not null default '{0,1,2,3,4}', -- 0 = Sunday
  budget        numeric(5,1) not null default 70.0    -- squad budget per manager
);

create table if not exists gameweeks (
  number     int primary key,
  start_date date not null,
  end_date   date not null,
  status     text not null default 'live',   -- live | complete
  locked     boolean not null default false
);

-- one matchday. Named by weekday on screen ("Tuesday Matchday"), never numbered.
create table if not exists matches (
  id         uuid primary key default gen_random_uuid(),
  match_date date not null,
  kickoff    text not null default '12:00',   -- local time, HH:MM
  gw         int  not null references gameweeks(number) on delete cascade,
  state      text not null default 'upcoming', -- upcoming | live | final | postponed
  status     text not null default 'draft',    -- draft | published (fantasy scoring)
  home_score int,                              -- real-life result, display only
  away_score int,
  motm       uuid references players(id) on delete set null,
  auto       boolean not null default false,
  created_at timestamptz not null default now(),
  unique (gw, match_date)                      -- stops duplicate fixtures
);

-- club announcements: the social layer
create table if not exists social_posts (
  id         uuid primary key default gen_random_uuid(),
  manager_id uuid not null references profiles(id) on delete cascade,
  kind       text not null default 'statement', -- statement | signing | injury | result
  content    text not null,
  mention    uuid references players(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_posts_at on social_posts(created_at desc);

-- ------------------------------------------------------- official results ---
create table if not exists match_stats (
  match_id      uuid not null references matches(id) on delete cascade,
  player_id     uuid not null references players(id) on delete cascade,
  played        boolean not null default false,
  goals         int not null default 0,
  assists       int not null default 0,
  saves         int not null default 0,
  tackles       int not null default 0,
  interceptions int not null default 0,
  yellow        int not null default 0,
  red           int not null default 0,
  own_goals     int not null default 0,
  clean_sheet   boolean not null default false,
  primary key (match_id, player_id)
);

-- one authoritative score per player per match, written only on publish
create table if not exists player_match_scores (
  match_id   uuid not null references matches(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  points     int not null,
  breakdown  jsonb not null default '[]',
  played     boolean not null default false,
  primary key (match_id, player_id)
);

-- ------------------------------------------------------------ fantasy ------
create table if not exists entries (
  manager_id    uuid not null references profiles(id) on delete cascade,
  gw            int  not null references gameweeks(number) on delete cascade,
  squad         uuid[] not null default '{}',
  xi            uuid[] not null default '{}',
  captain       uuid,
  vice          uuid,
  changes_used  int not null default 0,
  wildcard      boolean not null default false,
  pending_chips jsonb not null default '{}',
  primary key (manager_id, gw)
);

-- the lineup frozen for one match day; never rewritten by a later change
create table if not exists day_lineups (
  manager_id uuid not null references profiles(id) on delete cascade,
  match_id   uuid not null references matches(id) on delete cascade,
  xi         uuid[] not null,
  bench      uuid[] not null default '{}',
  captain    uuid,
  vice       uuid,
  chips      jsonb not null default '{}',
  subs       jsonb not null default '{}',
  locked_at  timestamptz not null default now(),
  primary key (manager_id, match_id)
);

create table if not exists manager_day_scores (
  manager_id uuid not null references profiles(id) on delete cascade,
  match_id   uuid not null references matches(id) on delete cascade,
  gw         int not null,
  points     int not null,
  detail     jsonb not null default '{}',
  primary key (manager_id, match_id)
);

create table if not exists chip_usage (
  manager_id uuid not null references profiles(id) on delete cascade,
  term       int  not null,
  chip       text not null,
  ref        text,
  used_at    timestamptz not null default now(),
  primary key (manager_id, term, chip)   -- makes a second use impossible
);

create table if not exists audit_log (
  id       bigserial primary key,
  actor    uuid references profiles(id) on delete set null,
  action   text not null,
  detail   jsonb not null default '{}',
  at       timestamptz not null default now()
);

create index if not exists idx_mds_gw     on manager_day_scores(gw);
create index if not exists idx_matches_gw on matches(gw);
create index if not exists idx_audit_at   on audit_log(at desc);

-- ===========================================================================
-- Row level security: read for signed-in users, write for nobody.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['players','profiles','config','gameweeks','matches',
                           'match_stats','player_match_scores','entries',
                           'day_lineups','manager_day_scores','chip_usage','audit_log',
                           'social_posts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists read_all on %I', t);
    execute format(
      'create policy read_all on %I for select to authenticated using (true)', t);
    -- deliberately no insert / update / delete policy: the API does all writing
  end loop;
end $$;

insert into config (id) values (1) on conflict (id) do nothing;
