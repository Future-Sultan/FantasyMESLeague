/* Lists the clubs that already exist. No sign-in required: club names are
   public inside the league anyway, and the log-in screen needs them so it can
   turn away a name that was never created, and stop a second club being made
   under a name that is taken. No passwords or addresses are exposed. */
const { admin, handler } = require('./_lib/core');

const slugOf = s => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

module.exports = handler(async () => {
  const { data, error } = await admin.from('profiles').select('team_name').order('team_name');
  if (error) return { clubs: [], slugs: [], warning: error.message };
  const clubs = (data || []).map(r => r.team_name).filter(Boolean);
  return { clubs, slugs: clubs.map(slugOf) };
});
