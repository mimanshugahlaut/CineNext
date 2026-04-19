export default async function handler(req, res) {
  const { i } = req.query;
  if (!i) return res.status(400).json({ error: 'Missing IMDB id' });

  const omdbUrl = new URL('https://www.omdbapi.com/');
  omdbUrl.searchParams.set('i', i);
  omdbUrl.searchParams.set('apikey', process.env.OMDB_API_KEY);

  try {
    const fetchRes = await fetch(omdbUrl.toString());
    const data = await fetchRes.json();
    return res.status(fetchRes.status).json(data);
  } catch (error) {
    console.error('OMDb Proxy Error:', error);
    return res.status(502).json({ error: 'OMDb proxy request failed' });
  }
}
