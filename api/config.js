/* Gives the browser the two values it is allowed to know: the project URL and
   the anon key. The service-role key never leaves the server. */
module.exports = (req, res) => {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return res.status(500).json({ error: 'The server is missing SUPABASE_URL or SUPABASE_ANON_KEY. Add them in the Vercel project settings and redeploy.' });
  }
  res.status(200).json({ url, anonKey: anon });
};
