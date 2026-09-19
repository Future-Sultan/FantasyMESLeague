/* ===========================================================================
   Moderator actions. requireAdmin runs before anything here, so a manager
   calling this endpoint directly gets a 403 no matter what they send.
   =========================================================================== */
const {
  admin, fail, requireAdmin, handler, body, audit, loadLeague,
  recomputeMatch, lockDueLineups, addDays, E
} = require('./_lib/core');

/* A squad is a plain array of ids, so nothing cascades into it. When a player
   disappears their id has to be lifted out of every squad and starting nine by
   hand, or managers end up with phantom names in their team. */
async function stripFromSquads(playerId) {
  const { data: entries } = await admin.from('entries').select('*');
  for (const e of entries || []) {
    if (!(e.squad || []).includes(playerId) && !(e.xi || []).includes(playerId)) continue;
    await admin.from('entries').update({
      squad: (e.squad || []).filter(p => p !== playerId),
      xi: (e.xi || []).filter(p => p !== playerId),
      captain: e.captain === playerId ? null : e.captain,
      vice: e.vice === playerId ? null : e.vice
    }).eq('manager_id', e.manager_id).eq('gw', e.gw);
  }
}

module.exports = handler(async (req) => {
  if (req.method !== 'POST') fail(405, 'Use POST.');
  const { profile } = await requireAdmin(req);
  const b = body(req);
  const { data: cfg } = await admin.from('config').select('*').eq('id', 1).single();

  switch (b.action) {

    case 'addPlayer': {
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) fail(400, 'Enter a name.');
      const { data: dupe } = await admin.from('players').select('id').ilike('name', name).maybeSingle();
      if (dupe) fail(409, 'A player with that name is already registered.');
      const { error } = await admin.from('players').insert({ name, active: true });
      if (error) fail(500, 'The player could not be added: ' + error.message);
      await audit(profile.id, 'player.added', { name });
      break;
    }

    case 'togglePlayer': {
      const { data: p } = await admin.from('players').select('*').eq('id', b.playerId).maybeSingle();
      if (!p) fail(404, 'No such player.');
      const { error } = await admin.from('players').update({ active: !p.active }).eq('id', p.id);
      if (error) fail(500, 'Could not update that player: ' + error.message);
      await audit(profile.id, 'player.toggled', { playerId: p.id, active: !p.active });
      break;
    }

    case 'newMatch': {
      const date = b.date;
      if (!date) fail(400, 'Choose a date.');
      const gw = b.gw || cfg.current_gw;
      const { data: clash } = await admin.from('matches').select('id').eq('gw', gw).eq('match_date', date).maybeSingle();
      if (clash) fail(409, 'That gameweek already has a match on that date.');
      const { error } = await admin.from('matches').insert({ match_date: date, gw, kickoff: b.kickoff || '12:00', status: 'draft', state: 'upcoming' });
      if (error) fail(500, 'The match could not be created: ' + error.message);
      await audit(profile.id, 'match.created', { date, gw });
      break;
    }

    case 'updateMatch': {
      const patch = {};
      if (b.date) patch.match_date = b.date;
      if (b.kickoff !== undefined) patch.kickoff = b.kickoff;
      if (b.gw) patch.gw = b.gw;
      if (b.motm !== undefined) patch.motm = b.motm || null;
      if (b.state !== undefined) {
        if (!['upcoming', 'live', 'final', 'postponed'].includes(b.state)) fail(400, 'That is not a valid match state.');
        patch.state = b.state;
      }
      if (b.homeScore !== undefined) patch.home_score = b.homeScore === '' ? null : +b.homeScore;
      if (b.awayScore !== undefined) patch.away_score = b.awayScore === '' ? null : +b.awayScore;
      const { error } = await admin.from('matches').update(patch).eq('id', b.matchId);
      if (error) fail(500, 'The match could not be updated: ' + error.message);
      const { data: m } = await admin.from('matches').select('status').eq('id', b.matchId).single();
      if (m && m.status === 'published') await recomputeMatch(b.matchId);
      break;
    }

    case 'saveStats': {
      const { data: m } = await admin.from('matches').select('*').eq('id', b.matchId).maybeSingle();
      if (!m) fail(404, 'No such match.');
      const rows = (b.stats || []).map(s => ({
        match_id: m.id, player_id: s.player_id,
        played: !!s.played,
        goals: Math.max(0, +s.goals || 0), assists: Math.max(0, +s.assists || 0),
        saves: Math.max(0, +s.saves || 0), tackles: Math.max(0, +s.tackles || 0),
        interceptions: Math.max(0, +s.interceptions || 0),
        yellow: Math.max(0, +s.yellow || 0), red: Math.max(0, +s.red || 0),
        own_goals: Math.max(0, +s.own_goals || 0), clean_sheet: !!s.clean_sheet
      }));
      if (rows.length) {
        const { error } = await admin.from('match_stats').upsert(rows, { onConflict: 'match_id,player_id' });
        if (error) fail(500, 'Statistics could not be saved: ' + error.message);
      }
      if (b.motm !== undefined) await admin.from('matches').update({ motm: b.motm || null }).eq('id', m.id);
      if (m.status === 'published') {
        await recomputeMatch(m.id);
        await audit(profile.id, 'match.corrected', { matchId: m.id });
      }
      break;
    }

    case 'publish': {
      const { data: m } = await admin.from('matches').select('*').eq('id', b.matchId).maybeSingle();
      if (!m) fail(404, 'No such match.');
      const { data: stats } = await admin.from('match_stats').select('player_id, played').eq('match_id', m.id);
      if (!stats || !stats.some(s => s.played)) fail(400, 'Nobody is marked as having played, so there is nothing to score.');

      /* freeze any lineup that has not already been frozen by the deadline */
      const { data: entries } = await admin.from('entries').select('*').eq('gw', m.gw);
      const { data: have } = await admin.from('day_lineups').select('manager_id').eq('match_id', m.id);
      const done = new Set((have || []).map(x => x.manager_id));
      const rows = (entries || [])
        .filter(e => !done.has(e.manager_id) && (e.xi || []).length === E.XI_SIZE)
        .map(e => ({
          manager_id: e.manager_id, match_id: m.id, xi: e.xi,
          bench: [],
          captain: e.captain, vice: e.vice, chips: e.pending_chips || {}, subs: {}
        }));
      if (rows.length) {
        const { error } = await admin.from('day_lineups').upsert(rows, { onConflict: 'manager_id,match_id', ignoreDuplicates: true });
        if (error) fail(500, 'Lineups could not be frozen, so nothing was published: ' + error.message);
        for (const r of rows) {
          if (Object.keys(r.chips || {}).length)
            await admin.from('entries').update({ pending_chips: {} }).eq('manager_id', r.manager_id).eq('gw', m.gw);
        }
      }

      const result = await recomputeMatch(m.id);          // throws before publishing if it fails
      const { error } = await admin.from('matches').update({ status: 'published', state: 'final' }).eq('id', m.id);
      if (error) fail(500, 'Scores were calculated but the match could not be marked published: ' + error.message);
      await audit(profile.id, 'match.published', { matchId: m.id, ...result });
      break;
    }

    case 'unpublish': {
      const { error } = await admin.from('matches').update({ status: 'draft' }).eq('id', b.matchId);
      if (error) fail(500, 'Could not return that match to draft: ' + error.message);
      await admin.from('player_match_scores').delete().eq('match_id', b.matchId);
      await admin.from('manager_day_scores').delete().eq('match_id', b.matchId);
      await audit(profile.id, 'match.unpublished', { matchId: b.matchId });
      break;
    }

    case 'deleteMatch': {
      const { error } = await admin.from('matches').delete().eq('id', b.matchId);
      if (error) fail(500, 'The match could not be deleted: ' + error.message);
      await audit(profile.id, 'match.deleted', { matchId: b.matchId });
      break;
    }

    case 'endGameweek': {
      const n = cfg.current_gw;
      const { data: g } = await admin.from('gameweeks').select('*').eq('number', n).single();
      await admin.from('gameweeks').update({ status: 'complete' }).eq('number', n);
      const next = n + 1;
      const start = addDays(g.end_date, 1);
      await admin.from('gameweeks').upsert({ number: next, start_date: start, end_date: addDays(start, 6), status: 'live', locked: false });
      const { data: prev } = await admin.from('entries').select('*').eq('gw', n);
      for (const e of prev || []) {
        if (!e.squad || !e.squad.length) continue;
        await admin.from('entries').upsert({
          manager_id: e.manager_id, gw: next, squad: e.squad, xi: e.xi,
          captain: e.captain, vice: e.vice, changes_used: 0, wildcard: false, pending_chips: {}
        });
      }
      await admin.from('config').update({ current_gw: next }).eq('id', 1);
      await audit(profile.id, 'gameweek.ended', { ended: n, started: next });
      break;
    }

    case 'lockGameweek': {
      const { error } = await admin.from('gameweeks').update({ locked: !!b.locked }).eq('number', cfg.current_gw);
      if (error) fail(500, 'Could not change the lock: ' + error.message);
      break;
    }

    case 'newTerm': {
      const term = (cfg.current_term || 1) + 1;
      await admin.from('config').update({ current_term: term }).eq('id', 1);
      await admin.from('entries').update({ pending_chips: {}, wildcard: false }).eq('gw', cfg.current_gw);
      await audit(profile.id, 'term.started', { term });
      break;
    }

    case 'settings': {
      const patch = {};
      if (b.deadline) {
        if (!/^\d{2}:\d{2}$/.test(b.deadline)) fail(400, 'The deadline must look like 15:30.');
        patch.deadline = b.deadline;
      }
      if (b.schoolDays) patch.school_days = b.schoolDays.filter(d => d >= 0 && d <= 6);
      if (b.timezone) patch.timezone = b.timezone;
      if (Object.keys(patch).length) {
        const { error } = await admin.from('config').update(patch).eq('id', 1);
        if (error) fail(500, 'Settings could not be saved: ' + error.message);
      }
      await audit(profile.id, 'settings.changed', patch);
      break;
    }

    case 'makeMod': {
      if (b.managerId === profile.id && b.isAdmin === false)
        fail(400, 'You cannot remove your own moderator access.');
      const { error } = await admin.from('profiles').update({ is_admin: !!b.isAdmin }).eq('id', b.managerId);
      if (error) fail(500, 'Could not change that role: ' + error.message);
      await audit(profile.id, 'role.changed', { managerId: b.managerId, isAdmin: !!b.isAdmin });
      break;
    }

    case 'resetChips': {
      const { error } = await admin.from('chip_usage').delete()
        .eq('manager_id', b.managerId).eq('term', cfg.current_term);
      if (error) fail(500, 'Chips could not be reset: ' + error.message);
      await admin.from('entries').update({ pending_chips: {}, wildcard: false })
        .eq('manager_id', b.managerId).eq('gw', cfg.current_gw);
      await audit(profile.id, 'chips.reset', { managerId: b.managerId });
      break;
    }

    /* ---------------------------------------------------------- deletion --- */
    case 'deletePlayer': {
      const { data: p } = await admin.from('players').select('*').eq('id', b.playerId).maybeSingle();
      if (!p) fail(404, 'No such player.');

      /* history is worth more than tidiness: a player who has appeared in a
         published match is never deleted, because that would tear holes in
         results people have already seen */
      const { count: appearances } = await admin.from('player_match_scores')
        .select('player_id', { count: 'exact', head: true }).eq('player_id', p.id);
      if (appearances && !b.force)
        fail(409, p.name + ' has already played in a published matchday, so deleting them would damage past results. Deactivate them instead — they stay in the records but cannot be picked again.');

      /* a manager account is anchored to this player, so it has to go first */
      const { data: owner } = await admin.from('profiles').select('id, name').eq('player_id', p.id).maybeSingle();
      if (owner) fail(409, p.name + ' is linked to the manager account "' + owner.name + '". Delete that account instead, which removes both.');

      await stripFromSquads(p.id);
      const { error } = await admin.from('players').delete().eq('id', p.id);
      if (error) fail(500, 'The player could not be deleted: ' + error.message);
      await audit(profile.id, 'player.deleted', { playerId: p.id, name: p.name, hadAppearances: appearances || 0 });
      break;
    }

    case 'deleteManager': {
      const { data: target } = await admin.from('profiles').select('*').eq('id', b.managerId).maybeSingle();
      if (!target) fail(404, 'No such manager.');
      if (target.id === profile.id) fail(400, 'You cannot delete your own account. Ask another moderator to do it.');
      if (target.is_admin) {
        const { count: mods } = await admin.from('profiles')
          .select('id', { count: 'exact', head: true }).eq('is_admin', true);
        if (mods <= 1) fail(409, 'That is the only moderator account left. Promote someone else first.');
      }

      /* the player they registered as: kept if other managers have picked them
         and they have a record, removed outright if nobody would miss them */
      let playerOutcome = 'none';
      if (target.player_id) {
        const { count: appearances } = await admin.from('player_match_scores')
          .select('player_id', { count: 'exact', head: true }).eq('player_id', target.player_id);
        if (appearances) {
          await admin.from('players').update({ active: false }).eq('id', target.player_id);
          playerOutcome = 'deactivated';
        } else {
          await stripFromSquads(target.player_id);
          await admin.from('players').delete().eq('id', target.player_id);
          playerOutcome = 'deleted';
        }
      }

      /* profiles cascade: squads, frozen lineups, scores, chips and posts go
         with the row */
      const { error } = await admin.from('profiles').delete().eq('id', target.id);
      if (error) fail(500, 'The manager could not be deleted: ' + error.message);

      /* and finally the login itself, so the club name can be reused */
      try { await admin.auth.admin.deleteUser(target.id); }
      catch (e) {
        await audit(profile.id, 'manager.deleted.partial', { managerId: target.id, note: String(e.message || e) });
        fail(500, 'The manager\'s data was removed, but their login could not be deleted. Remove it by hand in Supabase under Authentication, then Users.');
      }
      await audit(profile.id, 'manager.deleted', { managerId: target.id, name: target.name, team: target.team_name, playerOutcome });
      break;
    }

    case 'setPrice': {
      const price = Math.round(Number(b.price) * 10) / 10;
      if (!isFinite(price) || price < 0 || price > 99.9) fail(400, 'A price has to be between 0 and 99.9.');
      const { data: p } = await admin.from('players').select('id, name, price').eq('id', b.playerId).maybeSingle();
      if (!p) fail(404, 'No such player.');
      const { error } = await admin.from('players').update({ price }).eq('id', p.id);
      if (error) fail(500, 'The price could not be saved: ' + error.message);
      await audit(profile.id, 'player.repriced', { playerId: p.id, name: p.name, from: p.price, to: price });
      break;
    }

    case 'setPrices': {
      /* several at once, so a moderator can reprice the whole league in one go */
      const rows = (b.prices || []).map(x => ({ id: x.playerId, price: Math.round(Number(x.price) * 10) / 10 }));
      for (const r of rows) {
        if (!isFinite(r.price) || r.price < 0 || r.price > 99.9) fail(400, 'One of those prices is not a number between 0 and 99.9.');
        const { error } = await admin.from('players').update({ price: r.price }).eq('id', r.id);
        if (error) fail(500, 'A price could not be saved: ' + error.message);
      }
      await audit(profile.id, 'players.repriced', { count: rows.length });
      break;
    }

    case 'setBudget': {
      const budget = Math.round(Number(b.budget) * 10) / 10;
      if (!isFinite(budget) || budget < 1 || budget > 999) fail(400, 'The budget has to be a sensible number.');
      const { error } = await admin.from('config').update({ budget }).eq('id', 1);
      if (error) fail(500, 'The budget could not be saved: ' + error.message);
      await audit(profile.id, 'budget.changed', { budget });
      break;
    }

    case 'recompute': {
      const { data: ms } = await admin.from('matches').select('id').eq('status', 'published');
      let n = 0;
      for (const m of ms || []) { await recomputeMatch(m.id); n++; }
      await audit(profile.id, 'scores.recomputed', { matches: n });
      break;
    }

    default: fail(400, 'Unknown action.');
  }

  await lockDueLineups((await admin.from('config').select('*').eq('id', 1).single()).data);
  return await loadLeague(profile);
});
