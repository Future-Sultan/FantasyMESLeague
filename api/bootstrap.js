/* Runs once just after sign-up: creates the manager profile and registers the
   person as a player so other managers can pick them. The very first account
   to exist becomes the moderator. */
const { admin, fail, handler, body, audit } = require('./_lib/core');

module.exports = handler(async (req) => {
  if (req.method !== 'POST') fail(405, 'Use POST.');
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) fail(401, 'No session token was sent.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data || !data.user) fail(401, 'That session is not valid.');
  const user = data.user;

  const existing = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (existing.data) return { profile: existing.data, created: false };

  const name = String(body(req).name || user.email || 'Manager').trim().slice(0, 40);
  if (!name) fail(400, 'A display name is required.');

  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true });
  const first = !count;

  const { data: player, error: pErr } = await admin.from('players')
    .insert({ name, active: true }).select().single();
  if (pErr) fail(500, 'Could not register you as a player: ' + pErr.message);

  const teamName = String(body(req).teamName || (name + ' FC')).trim().slice(0, 32);
  const { data: profile, error: prErr } = await admin.from('profiles')
    .insert({ id: user.id, name, team_name: teamName, is_admin: first, player_id: player.id }).select().single();
  if (prErr) {
    await admin.from('players').delete().eq('id', player.id);
    fail(500, 'Could not create your manager profile: ' + prErr.message);
  }
  await audit(user.id, first ? 'league.founded' : 'manager.registered', { name });
  return { profile, created: true, isFirst: first };
});
