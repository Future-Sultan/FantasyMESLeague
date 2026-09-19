/* ===========================================================================
   Shared server logic. Everything that writes to the database lives behind
   these helpers, and every one of them checks who the caller is first.
   =========================================================================== */
const { createClient } = require('@supabase/supabase-js');
const E = require('./engine');

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

/* service-role client: bypasses row level security, server only, never shipped
   to the browser */
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

/* ------------------------------------------------------------ identity --- */
async function requireUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) fail(401, 'You are signed out. Sign in again.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data || !data.user) fail(401, 'Your session has expired. Sign in again.');
  const { data: profile } = await admin.from('profiles').select('*').eq('id', data.user.id).single();
  if (!profile) fail(403, 'This account has no manager profile yet.');
  return { user: data.user, profile };
}
async function requireAdmin(req) {
  const ctx = await requireUser(req);
  if (!ctx.profile.is_admin) fail(403, 'That action is for moderators only.');
  return ctx;
}
async function audit(actor, action, detail) {
  await admin.from('audit_log').insert({ actor, action, detail: detail || {} });
}

/* ------------------------------------------------------------ calendar --- */
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(new Date(s + 'T12:00:00Z').getTime() + n * 864e5));
const dowOf = s => new Date(s + 'T12:00:00Z').getUTCDay();

function tzOffset(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - ts;
}
/* the exact instant a given match day's lineup locks */
function deadlineAt(dateStr, hhmm, tz) {
  const base = Date.parse(`${dateStr}T${hhmm}:00Z`);
  let ts = base;
  for (let i = 0; i < 2; i++) ts = base - tzOffset(ts, tz);
  return new Date(ts);
}
function todayIn(tz) {
  const now = Date.now();
  return iso(new Date(now + tzOffset(now, tz)));
}

/* ---------------------------------------------- automatic fixture making --- */
async function ensureSchedule() {
  const { data: cfg } = await admin.from('config').select('*').eq('id', 1).single();
  const tz = cfg.timezone || 'Africa/Cairo';
  const today = todayIn(tz);

  let { data: gws } = await admin.from('gameweeks').select('*').order('number');
  if (!gws || !gws.length) {
    const start = addDays(today, -dowOf(today));      // back to Sunday
    await admin.from('gameweeks').insert({ number: 1, start_date: start, end_date: addDays(start, 6) });
    gws = [{ number: 1, start_date: start, end_date: addDays(start, 6), status: 'live', locked: false }];
    await admin.from('config').update({ current_gw: 1 }).eq('id', 1);
    cfg.current_gw = 1;
  }

  /* roll finished gameweeks forward, carrying squads and refreshing changes */
  let guard = 0;
  while (guard++ < 60) {
    const g = gws.find(x => x.number === cfg.current_gw);
    if (!g || today <= g.end_date) break;
    await admin.from('gameweeks').update({ status: 'complete' }).eq('number', g.number);
    const n = g.number + 1;
    const start = addDays(g.end_date, 1);
    await admin.from('gameweeks').upsert({ number: n, start_date: start, end_date: addDays(start, 6), status: 'live', locked: false });
    const { data: prev } = await admin.from('entries').select('*').eq('gw', g.number);
    for (const e of prev || []) {
      if (!e.squad || !e.squad.length) continue;
      await admin.from('entries').upsert({
        manager_id: e.manager_id, gw: n, squad: e.squad, xi: e.xi,
        captain: e.captain, vice: e.vice, changes_used: 0, wildcard: false, pending_chips: {}
      });
    }
    await admin.from('config').update({ current_gw: n }).eq('id', 1);
    cfg.current_gw = n;
    const { data: fresh } = await admin.from('gameweeks').select('*').order('number');
    gws = fresh;
  }

  /* one fixture per school day; the unique(gw, match_date) index means two
     people loading the page at once cannot create the same day twice */
  const g = gws.find(x => x.number === cfg.current_gw);
  if (g) {
    const school = cfg.school_days || [0, 1, 2, 3, 4];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(g.start_date, i);
      if (d > g.end_date) break;
      if (school.includes(dowOf(d))) days.push(d);
    }
    const { data: have } = await admin.from('matches').select('match_date').eq('gw', g.number);
    const haveSet = new Set((have || []).map(m => m.match_date));
    const missing = days.filter(d => !haveSet.has(d));
    if (missing.length) {
      await admin.from('matches').upsert(
        missing.map(d => ({ match_date: d, gw: g.number, state: 'upcoming', status: 'draft', auto: true })),
        { onConflict: 'gw,match_date', ignoreDuplicates: true });
    }
  }
  return cfg;
}

/* ------------------------------------------- freeze lineups at deadline --- */
async function lockDueLineups(cfg) {
  const tz = cfg.timezone || 'Africa/Cairo';
  const now = Date.now();
  const { data: ms } = await admin.from('matches').select('*').eq('gw', cfg.current_gw);
  const due = (ms || []).filter(m => deadlineAt(m.match_date, cfg.deadline, tz).getTime() <= now);
  if (!due.length) return;
  const { data: entries } = await admin.from('entries').select('*').eq('gw', cfg.current_gw);
  const { data: existing } = await admin.from('day_lineups').select('manager_id, match_id')
    .in('match_id', due.map(m => m.id));
  const done = new Set((existing || []).map(x => x.manager_id + '|' + x.match_id));

  for (const m of due) {
    const rows = [];
    for (const e of entries || []) {
      if (done.has(e.manager_id + '|' + m.id)) continue;
      if (!e.xi || e.xi.length !== E.XI_SIZE) continue;
      rows.push({
        manager_id: e.manager_id, match_id: m.id, xi: e.xi,
        bench: [],
        captain: e.captain, vice: e.vice,
        chips: e.pending_chips || {}, subs: {}
      });
    }
    if (rows.length) {
      await admin.from('day_lineups').upsert(rows, { onConflict: 'manager_id,match_id', ignoreDuplicates: true });
      /* an armed day chip is spent once it has been written into a lineup */
      for (const r of rows) {
        if (Object.keys(r.chips || {}).length) {
          await admin.from('entries').update({ pending_chips: {} })
            .eq('manager_id', r.manager_id).eq('gw', cfg.current_gw);
        }
      }
    }
  }
}

/* ------------------------------------------------------- recalculation --- */
/* Rewrites the official scores for one match. Safe to run repeatedly: every
   write is an upsert on a primary key, so a correction replaces a result
   instead of adding a second one. */
async function recomputeMatch(matchId) {
  const { data: m } = await admin.from('matches').select('*').eq('id', matchId).single();
  if (!m) fail(404, 'That match no longer exists.');
  const { data: stats } = await admin.from('match_stats').select('*').eq('match_id', matchId);
  const base = E.scoreMatch(stats || [], m.motm);

  const rows = Object.keys(base).map(pid => ({
    match_id: matchId, player_id: pid, points: base[pid].total,
    breakdown: base[pid].lines, played: base[pid].played
  }));
  await admin.from('player_match_scores').delete().eq('match_id', matchId);
  if (rows.length) {
    const { error } = await admin.from('player_match_scores').insert(rows);
    if (error) fail(500, 'Player scores could not be saved: ' + error.message);
  }

  const { data: lineups } = await admin.from('day_lineups').select('*').eq('match_id', matchId);
  const dayRows = (lineups || []).map(l => {
    const r = E.scoreManagerDay({ xi: l.xi, bench: l.bench, captain: l.captain, vice: l.vice, chips: l.chips, subs: l.subs }, base);
    return {
      manager_id: l.manager_id, match_id: matchId, gw: m.gw, points: r.total,
      detail: { lines: r.lines, swaps: r.swaps, notes: r.notes, captainId: r.captainId, captainSource: r.captainSource, multiplier: r.multiplier, gambler: r.gambler, halved: r.halved }
    };
  });
  await admin.from('manager_day_scores').delete().eq('match_id', matchId);
  if (dayRows.length) {
    const { error } = await admin.from('manager_day_scores').insert(dayRows);
    if (error) fail(500, 'Manager scores could not be saved: ' + error.message);
  }
  return { players: rows.length, managers: dayRows.length };
}

/* --------------------------------------------------------- read the world --- */
async function loadLeague(profile) {
  const cfg = await ensureSchedule();
  await lockDueLineups(cfg);

  const [players, profiles, gameweeks, matches, stats, pScores, entries, lineups, dScores, chips, posts] = await Promise.all([
    admin.from('players').select('*').order('name'),
    admin.from('profiles').select('id,name,team_name,is_admin,player_id'),
    admin.from('gameweeks').select('*').order('number'),
    admin.from('matches').select('*').order('match_date'),
    admin.from('match_stats').select('*'),
    admin.from('player_match_scores').select('*'),
    admin.from('entries').select('*'),
    admin.from('day_lineups').select('*'),
    admin.from('manager_day_scores').select('*'),
    admin.from('chip_usage').select('*'),
    admin.from('social_posts').select('*').order('created_at', { ascending: false }).limit(60)
  ]);
  const tz = cfg.timezone || 'Africa/Cairo';
  const deadlines = {};
  for (const m of matches.data || []) deadlines[m.id] = deadlineAt(m.match_date, cfg.deadline, tz).toISOString();

  return {
    me: profile.id,
    config: cfg,
    today: todayIn(tz),
    now: new Date().toISOString(),
    deadlines,
    players: players.data || [],
    managers: profiles.data || [],
    gameweeks: gameweeks.data || [],
    matches: matches.data || [],
    stats: stats.data || [],
    playerScores: pScores.data || [],
    entries: entries.data || [],
    lineups: (lineups.data || []).filter(l => l.manager_id === profile.id || profile.is_admin),
    dayScores: dScores.data || [],
    chipUsage: chips.data || [],
    posts: posts.data || []
  };
}

/* ------------------------------------------------------------- plumbing --- */
function handler(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.status(200).json(out);
    } catch (e) {
      const status = e.status || 500;
      if (!res.headersSent) res.status(status).json({ error: e.message || 'Something went wrong.' });
      if (status >= 500) console.error(e);
    }
  };
}
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));

module.exports = {
  admin, HttpError, fail, requireUser, requireAdmin, audit, handler, body,
  ensureSchedule, lockDueLineups, recomputeMatch, loadLeague,
  addDays, dowOf, iso, deadlineAt, todayIn, E
};
