export default async function handler(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  let targetPath = urlObj.pathname.replace('/api/tmdb', '');
  if (!targetPath.startsWith('/')) {
    targetPath = '/' + targetPath;
  }

  // Security allowlist
  const allowedPrefixes = [
    '/trending', '/movie', '/tv', '/search', '/genre', 
    '/discover', '/person', '/collection', '/network', 
    '/keyword', '/review', '/find'
  ];
  
  if (!allowedPrefixes.some(prefix => targetPath.startsWith(prefix))) {
      return res.status(403).json({ error: 'Forbidden TMDB path' });
  }

  const tmdbUrl = new URL(`https://api.themoviedb.org/3${targetPath}`);
  urlObj.searchParams.forEach((val, key) => {
    tmdbUrl.searchParams.append(key, val);
  });

  try {
    const fetchRes = await fetch(tmdbUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${process.env.TMDB_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await fetchRes.json();
    return res.status(fetchRes.status).json(data);
  } catch (error) {
    console.error('TMDB Proxy Error:', error);
    return res.status(502).json({ error: 'TMDB proxy request failed' });
  }
}
