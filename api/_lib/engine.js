/* ===========================================================================
   FML scoring engine — the only place fantasy points are ever calculated.
   Pure functions: same inputs always give the same numbers, so a published
   match can be recalculated at any time and land on the same result.
   =========================================================================== */

const RULES = {
  goal: 5, assist: 3, save: 1, cleanSheet: 3, motm: 5,
  yellow: -1, red: -4, ownGoal: -3, appearance: 0,
  defCon: [{ min: 15, pts: 7 }, { min: 10, pts: 5 }, { min: 5, pts: 3 }, { min: 0, pts: 0 }]
};
const BLANK = {
  played: false, goals: 0, assists: 0, saves: 0, tackles: 0,
  interceptions: 0, yellow: 0, red: 0, own_goals: 0, clean_sheet: false
};
const SQUAD_SIZE = 9, XI_SIZE = 9, BENCH_SIZE = 0;

function defConPoints(dc) {
  for (const b of RULES.defCon) if (dc >= b.min) return b.pts;
  return 0;
}

/* One player, one match. Returns the total and the line-by-line trail. */
function scorePlayer(raw, isMotm) {
  const s = Object.assign({}, BLANK, raw || {});
  if (!s.played) return { total: 0, lines: [{ label: 'Did not play', pts: 0 }], played: false, dc: 0 };
  const lines = [];
  const add = (label, pts) => { if (pts !== 0) lines.push({ label, pts }); };
  add(s.goals === 1 ? 'Goal' : `Goals ×${s.goals}`, s.goals * RULES.goal);
  add(s.assists === 1 ? 'Assist' : `Assists ×${s.assists}`, s.assists * RULES.assist);
  add(s.saves === 1 ? 'Save' : `Saves ×${s.saves}`, s.saves * RULES.save);
  const dc = (s.tackles || 0) + (s.interceptions || 0);
  const dcp = defConPoints(dc);
  if (dcp) lines.push({ label: `Defensive contributions: ${dc}`, pts: dcp });
  if (s.clean_sheet) add('Clean sheet', RULES.cleanSheet);
  if (isMotm) add('Man of the match', RULES.motm);
  add(s.yellow === 1 ? 'Yellow card' : `Yellow cards ×${s.yellow}`, s.yellow * RULES.yellow);
  add(s.red === 1 ? 'Red card' : `Red cards ×${s.red}`, s.red * RULES.red);
  add(s.own_goals === 1 ? 'Own goal' : `Own goals ×${s.own_goals}`, s.own_goals * RULES.ownGoal);
  const total = lines.reduce((a, l) => a + l.pts, 0);
  if (!lines.length) lines.push({ label: 'Played, no scoring actions', pts: 0 });
  return { total, lines, played: true, dc };
}

/* Every player's base score for one match. Shared by every manager. */
function scoreMatch(statRows, motmId) {
  const out = {};
  for (const row of statRows) out[row.player_id] = scorePlayer(row, motmId === row.player_id);
  return out;
}

/* ---------------------------------------------------------------------------
   One manager, one match day.
   lineup = {xi:[9], bench:[2], captain, vice, chips:{}, subs:{}}
   base   = {playerId: {total, played}}
--------------------------------------------------------------------------- */
function scoreManagerDay(lineup, base) {
  const chips = lineup.chips || {};
  const pts = id => (base[id] ? base[id].total : 0);
  const played = id => !!(base[id] && base[id].played);
  const xi = (lineup.xi || []).slice();
  const bench = (lineup.bench || []).slice();
  const notes = [], swaps = [];

  /* Bench cover — only for starters the moderators marked absent. */
  const used = new Set();
  const chosen = lineup.subs || {};
  const effective = xi.map(id => {
    if (played(id)) return id;
    let inId = chosen[id];
    if (!inId || used.has(inId) || !bench.includes(inId) || !played(inId)) {
      inId = bench.filter(b => !used.has(b) && played(b)).sort((a, b) => pts(b) - pts(a))[0];
      if (inId && chosen[id]) notes.push('A chosen replacement was unavailable, so the next best bench player came on.');
    }
    if (inId) { used.add(inId); swaps.push({ out: id, in: inId, auto: !chosen[id] }); return inId; }
    notes.push('An absent starter had no available bench cover and scored 0.');
    return id;
  });

  /* Captaincy, decided only after we know who actually played. */
  let capId = null, capWhy = '';
  if (lineup.captain && played(lineup.captain) && effective.includes(lineup.captain)) {
    capId = lineup.captain; capWhy = 'captain';
  } else if (lineup.vice && played(lineup.vice) && effective.includes(lineup.vice)) {
    capId = lineup.vice; capWhy = 'vice';
    notes.push('Captain did not play, so the armband passed to the vice-captain.');
  } else if (lineup.captain || lineup.vice) {
    notes.push('Neither captain nor vice-captain played, so no multiplier was applied.');
  }

  const mult = chips.allOrNothing ? 4 : chips.tripleCaptain ? 3 : 2;
  const lines = [];
  let total = 0;
  for (const id of effective) {
    const p = pts(id), m = id === capId ? mult : 1;
    lines.push({ id, base: p, mult: m, pts: p * m, role: id === capId ? capWhy : '', bench: false });
    total += p * m;
  }
  if (chips.benchBoost) {
    for (const id of bench) {
      if (effective.includes(id)) continue;
      lines.push({ id, base: pts(id), mult: 1, pts: pts(id), role: '', bench: true });
      total += pts(id);
    }
    notes.push('Bench Boost: both bench players scored.');
  }

  /* The Gambler — judged on the player's own score, before any multiplier. */
  let gambler = null;
  if (chips.gambler) {
    const g = chips.gambler;
    if (lines.some(l => l.id === g)) {
      const raw = pts(g);
      const delta = raw >= 10 ? 10 : raw >= 5 ? 0 : -10;
      gambler = { id: g, raw, delta };
      total += delta;
    } else notes.push('The Gambler pick was not in the scoring team, so it had no effect.');
  }

  /* All or Nothing — halves a finished positive day after a blank captain. */
  let halved = false;
  if (chips.allOrNothing) {
    const capBase = capId ? pts(capId) : 0;
    if (capBase <= 0) {
      if (total > 0) { total = Math.round(total / 2); halved = true; notes.push('All or Nothing: the captain blanked, so the day score was halved.'); }
      else notes.push('All or Nothing: the captain blanked, but the day was not positive so nothing was halved.');
    }
  }
  return { total, lines, swaps, notes, captainId: capId, captainSource: capWhy, multiplier: capId ? mult : 1, gambler, halved };
}

module.exports = { RULES, BLANK, SQUAD_SIZE, XI_SIZE, BENCH_SIZE, defConPoints, scorePlayer, scoreMatch, scoreManagerDay };
