/* ===========================================================================
   Manager actions. Every rule is enforced here, not in the browser: squad
   size, the two team changes, captain eligibility, who may be substituted,
   and one use of each chip per term.
   =========================================================================== */
const { admin, fail, requireUser, handler, body, audit, loadLeague, E } = require('./_lib/core');

const uniq = a => Array.from(new Set(a));

async function currentGw() {
  const { data } = await admin.from('config').select('*').eq('id', 1).single();
  return data;
}
async function getEntry(mid, gw) {
  const { data } = await admin.from('entries').select('*').eq('manager_id', mid).eq('gw', gw).maybeSingle();
  return data || { manager_id: mid, gw, squad: [], xi: [], captain: null, vice: null, changes_used: 0, wildcard: false, pending_chips: {} };
}
/* the 11 are fixed once the week is under way */
async function squadIsLocked(mid, gw) {
  const { data: g } = await admin.from('gameweeks').select('locked').eq('number', gw).maybeSingle();
  if (g && g.locked) return true;
  const { count: pub } = await admin.from('matches')
    .select('id', { count: 'exact', head: true }).eq('gw', gw).eq('status', 'published');
  if (pub) return true;
  const { data: ms } = await admin.from('matches').select('id').eq('gw', gw);
  if (!ms || !ms.length) return false;
  const { count: frozen } = await admin.from('day_lineups')
    .select('match_id', { count: 'exact', head: true })
    .eq('manager_id', mid).in('match_id', ms.map(m => m.id));
  return !!frozen;
}

module.exports = handler(async (req) => {
  if (req.method !== 'POST') fail(405, 'Use POST.');
  const { profile } = await requireUser(req);
  const mid = profile.id;
  const b = body(req);
  const cfg = await currentGw();
  const gw = cfg.current_gw;
  const entry = await getEntry(mid, gw);

  switch (b.action) {

    /* ------------------------------------------------------------ squad --- */
    case 'squad': {
      const squad = uniq(b.squad || []);
      if (squad.length !== E.SQUAD_SIZE) fail(400, `A squad is exactly ${E.SQUAD_SIZE} players.`);
      const { data: ok } = await admin.from('players').select('id, name, price').in('id', squad).eq('active', true);
      if (!ok || ok.length !== squad.length) fail(400, 'One of those players is not registered or is no longer active.');

      /* the budget is checked here, on the server, so a manager cannot get
         round it by editing anything in their own browser */
      const budget = Number(cfg.budget || 70);
      const spend = ok.reduce((t, p) => t + Number(p.price || 0), 0);
      if (spend > budget + 1e-9)
        fail(409, 'That squad costs ' + spend.toFixed(1) + ', which is ' +
          (spend - budget).toFixed(1) + ' over the ' + budget.toFixed(1) + ' budget.');
      if (await squadIsLocked(mid, gw)) fail(409, 'The gameweek has started, so your squad is locked. You can still change your starting nine.');

      let xi = (entry.xi || []).filter(p => squad.includes(p));
      if (xi.length !== E.XI_SIZE) xi = squad.slice(0, E.XI_SIZE);
      const captain = xi.includes(entry.captain) ? entry.captain : xi[0];
      const vice = xi.includes(entry.vice) && entry.vice !== captain ? entry.vice : xi[1];

      const { error } = await admin.from('entries').upsert({
        manager_id: mid, gw, squad, xi, captain, vice,
        changes_used: entry.changes_used || 0, wildcard: entry.wildcard || false,
        pending_chips: entry.pending_chips || {}
      });
      if (error) fail(500, 'Your squad could not be saved: ' + error.message);
      await audit(mid, 'squad.set', { gw });
      break;
    }

    /* ------------------------------------------------- starting nine ------ */
    case 'xi': {
      const xi = uniq(b.xi || []);
      if (xi.length !== E.XI_SIZE) fail(400, `Pick exactly ${E.XI_SIZE} starters.`);
      if (!xi.every(p => (entry.squad || []).includes(p))) fail(400, 'Starters must come from your own squad.');

      const locked = await squadIsLocked(mid, gw);
      const same = (entry.xi || []).length === E.XI_SIZE && xi.every(p => entry.xi.includes(p));
      let used = entry.changes_used || 0;
      if (locked && !same && !entry.wildcard) {
        if (used >= 2) fail(409, 'You have used both team changes for this gameweek.');
        used += 1;
      }
      const captain = xi.includes(entry.captain) ? entry.captain : xi[0];
      const vice = xi.includes(entry.vice) && entry.vice !== captain ? entry.vice : xi.find(p => p !== captain);

      /* the change is only spent if the write actually lands */
      const { error } = await admin.from('entries').upsert({
        manager_id: mid, gw, squad: entry.squad, xi, captain, vice,
        changes_used: used, wildcard: entry.wildcard || false, pending_chips: entry.pending_chips || {}
      });
      if (error) fail(500, 'Your team could not be saved, so no change was used: ' + error.message);
      await audit(mid, 'xi.set', { gw, changesUsed: used });
      break;
    }

    /* ------------------------------------------------------- captaincy --- */
    case 'captain': {
      const { captain, vice } = b;
      if (!captain || !vice) fail(400, 'Choose both a captain and a vice-captain.');
      if (captain === vice) fail(400, 'The captain and vice-captain must be different players.');
      if (!(entry.xi || []).includes(captain) || !entry.xi.includes(vice))
        fail(400, 'Both must be in your starting nine.');
      const { error } = await admin.from('entries').upsert({
        manager_id: mid, gw, squad: entry.squad, xi: entry.xi, captain, vice,
        changes_used: entry.changes_used || 0, wildcard: entry.wildcard || false,
        pending_chips: entry.pending_chips || {}
      });
      if (error) fail(500, 'The armband could not be saved: ' + error.message);
      break;
    }

    /* ---------------------------------------------------- bench cover ---- */
    case 'subs': {
      const matchId = b.matchId;
      const { data: m } = await admin.from('matches').select('*').eq('id', matchId).maybeSingle();
      if (!m) fail(404, 'That match does not exist.');
      const { data: lineup } = await admin.from('day_lineups').select('*')
        .eq('manager_id', mid).eq('match_id', matchId).maybeSingle();
      if (!lineup) fail(409, 'You had no locked lineup for that day.');
      const { data: sc } = await admin.from('player_match_scores').select('player_id, played').eq('match_id', matchId);
      const playedSet = new Set((sc || []).filter(r => r.played).map(r => r.player_id));

      const subs = {};
      const taken = new Set();
      for (const [out, inId] of Object.entries(b.subs || {})) {
        if (!inId) continue;
        if (!lineup.xi.includes(out)) fail(400, 'You can only replace one of your own starters.');
        if (playedSet.has(out)) fail(400, 'A player who took part cannot be replaced.');
        if (!lineup.bench.includes(inId)) fail(400, 'Replacements must come from your bench.');
        if (!playedSet.has(inId)) fail(400, 'That bench player did not take part either.');
        if (taken.has(inId)) fail(400, 'One bench player cannot cover two starters.');
        taken.add(inId); subs[out] = inId;
      }
      const { error } = await admin.from('day_lineups').update({ subs })
        .eq('manager_id', mid).eq('match_id', matchId);
      if (error) fail(500, 'Replacements could not be saved: ' + error.message);
      if (m.status === 'published') {
        const { recomputeMatch } = require('./_lib/core');
        await recomputeMatch(matchId);
      }
      await audit(mid, 'subs.set', { matchId, subs });
      break;
    }

    /* ------------------------------------------------------------ chips --- */
    case 'chip': {
      const chip = b.chip;
      const valid = ['tripleCaptain', 'allOrNothing', 'benchBoost', 'gambler', 'wildcard'];
      if (!valid.includes(chip)) fail(400, 'That is not a chip.');
      const pending = entry.pending_chips || {};
      if (chip === 'tripleCaptain' && pending.allOrNothing) fail(409, 'All or Nothing is already armed for the next match day.');
      if (chip === 'allOrNothing' && pending.tripleCaptain) fail(409, 'Triple Captain is already armed for the next match day.');
      if (chip === 'gambler') {
        if (!(entry.xi || []).includes(b.player)) fail(400, 'Back one of your own starters.');
      }
      if (chip !== 'wildcard' && (entry.xi || []).length !== E.XI_SIZE) fail(400, 'Set your starting nine first.');

      /* the primary key on (manager, term, chip) is what makes a second use
         impossible, even if two requests arrive at the same moment */
      const { error: cErr } = await admin.from('chip_usage')
        .insert({ manager_id: mid, term: cfg.current_term, chip, ref: 'gw' + gw });
      if (cErr) {
        if (String(cErr.code) === '23505') fail(409, 'You have already played that chip this term.');
        fail(500, 'The chip could not be recorded: ' + cErr.message);
      }

      const update = {
        manager_id: mid, gw, squad: entry.squad, xi: entry.xi,
        captain: entry.captain, vice: entry.vice,
        changes_used: entry.changes_used || 0,
        wildcard: entry.wildcard || false, pending_chips: pending
      };
      if (chip === 'wildcard') update.wildcard = true;
      else if (chip === 'gambler') pending.gambler = b.player;
      else pending[chip] = true;

      const { error } = await admin.from('entries').upsert(update);
      if (error) {
        await admin.from('chip_usage').delete()
          .eq('manager_id', mid).eq('term', cfg.current_term).eq('chip', chip);
        fail(500, 'The chip could not be armed, so it has not been used: ' + error.message);
      }
      await audit(mid, 'chip.played', { chip, gw, term: cfg.current_term });
      break;
    }

    /* ------------------------------------------------------ club identity --- */
    case 'teamName': {
      const name = String(b.name || '').trim().slice(0, 32);
      if (name.length < 2) fail(400, 'Give your club a name of at least two characters.');
      const { error } = await admin.from('profiles').update({ team_name: name }).eq('id', mid);
      if (error) fail(500, 'Your club name could not be saved: ' + error.message);
      await audit(mid, 'team.renamed', { name });
      break;
    }

    /* -------------------------------------------------------- social feed --- */
    case 'post': {
      const content = String(b.content || '').trim().slice(0, 500);
      if (content.length < 3) fail(400, 'Write something first.');
      const kinds = ['statement', 'signing', 'injury', 'result'];
      const kind = kinds.includes(b.kind) ? b.kind : 'statement';
      const { error } = await admin.from('social_posts')
        .insert({ manager_id: mid, kind, content, mention: b.mention || null });
      if (error) fail(500, 'Your announcement could not be posted: ' + error.message);
      break;
    }

    case 'deletePost': {
      const { data: post } = await admin.from('social_posts').select('manager_id').eq('id', b.postId).maybeSingle();
      if (!post) fail(404, 'That post is already gone.');
      if (post.manager_id !== mid && !profile.is_admin) fail(403, 'You can only delete your own club posts.');
      const { error } = await admin.from('social_posts').delete().eq('id', b.postId);
      if (error) fail(500, 'The post could not be deleted: ' + error.message);
      break;
    }

    default: fail(400, 'Unknown action.');
  }

  return await loadLeague(profile);
});
