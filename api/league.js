/* The single read the front end makes. Runs the scheduler and the deadline
   lock first, so fixtures appear and lineups freeze without anyone clicking
   anything. */
const { requireUser, loadLeague, handler } = require('./_lib/core');

module.exports = handler(async (req) => {
  const { profile } = await requireUser(req);
  return await loadLeague(profile);
});
