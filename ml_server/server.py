# -*- coding: utf-8 -*-
"""
CineNext ML Recommendation Engine (Enhanced v2)
=================================================
Content-Based Filtering using TF-IDF Vectorization + Cosine Similarity
with Hybrid Scoring (popularity + rating blend).

Enhancements over v1:
  - Richer pool soups: fetches keywords/cast for top pool items
  - Multi-genre cross-discovery for more diverse results
  - Larger pool (5 pages)
  - Hybrid scoring: cosine_sim * 0.75 + popularity * 0.15 + rating * 0.10
  - LRU caching on TMDB API calls
  - Genre ID → name resolution for pool items
  - Input sanitization + rate limiting
"""

import os
import re
import sys
import logging
import json
import time
import requests
import numpy as np
import pandas as pd
from functools import lru_cache
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Force UTF-8 output on Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

# ---- Config ------------------------------------------------------------------
def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


API_TOKEN = require_env("TMDB_API_TOKEN")
BASE_URL   = "https://api.themoviedb.org/3"
IMG_BASE   = "https://image.tmdb.org/t/p/w500"
HEADERS    = {"Authorization": f"Bearer {API_TOKEN}", "Content-Type": "application/json"}
OMDB_KEY   = require_env("OMDB_API_KEY")
OMDB_BASE  = "https://www.omdbapi.com"
SUPABASE_URL = require_env("SUPABASE_URL")
SUPABASE_ANON_KEY = require_env("SUPABASE_ANON_KEY")
APP_ORIGIN = os.environ.get("APP_ORIGIN", "").strip()
ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", APP_ORIGIN).split(",") if origin.strip()]
GOOGLE_REDIRECT_TO = os.environ.get("GOOGLE_REDIRECT_TO", APP_ORIGIN).strip()

TOP_N      = 12   # Default number of recommendations
POOL_PAGES = 5    # Discovery pages for comparison pool (was 3)
ENRICH_TOP = 15   # How many top pool items get detailed metadata enrichment

# ---- App ---------------------------------------------------------------------
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGINS or "*"}})

# Rate limiter (in-memory, per-IP)
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)
# ---- TMDB Helpers (with caching) --------------------------------------------
@lru_cache(maxsize=512)
def tmdb_get_cached(path: str, params_key: str) -> dict:
    """Cached TMDB API GET. params_key is a frozen string for cache keying."""
    import json
    params = json.loads(params_key) if params_key else {}
    try:
        r = requests.get(f"{BASE_URL}{path}", headers=HEADERS, params=params, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("TMDB request failed (%s): %s", path, e)
        return {}


def tmdb_get(path: str, params: dict = None) -> dict:
    """Generic TMDB API GET with LRU caching."""
    import json
    if params is None:
        params = {}
    params_key = json.dumps(params, sort_keys=True)
    return tmdb_get_cached(path, params_key)


@lru_cache(maxsize=1)
def get_genre_map(media_type: str) -> dict:
    """Fetch and cache genre ID → name mapping from TMDB."""
    data = tmdb_get(f"/genre/{media_type}/list")
    return {g["id"]: g["name"].replace(" ", "").replace("-", "")
            for g in data.get("genres", [])}


def resolve_genre_ids(genre_ids: list, media_type: str) -> str:
    """Convert genre IDs to genre names for TF-IDF matching."""
    gmap = get_genre_map(media_type)
    return " ".join(gmap.get(gid, "") for gid in genre_ids if gmap.get(gid))


def fetch_item_details(media_type: str, tmdb_id: int) -> dict:
    """
    Fetch rich metadata for a single movie / TV show.
    Returns a flat dict with: id, title, overview, genre_names, keywords,
                               cast_names, director, poster_path, vote_average,
                               release_year, popularity, soup.
    """
    detail = tmdb_get(f"/{media_type}/{tmdb_id}",
                      {"append_to_response": "credits,keywords"})
    if not detail:
        return {}

    title = detail.get("title") or detail.get("name", "")

    # Genres
    genres = " ".join(g["name"].replace(" ", "").replace("-", "")
                      for g in detail.get("genres", []))

    # Keywords
    kw_data = detail.get("keywords", {})
    kw_list = kw_data.get("keywords") or kw_data.get("results", [])
    keywords = " ".join(k["name"].replace(" ", "").replace("-", "") for k in kw_list[:20])

    # Cast (top 5)
    cast = " ".join(
        c["name"].replace(" ", "").replace("-", "")
        for c in detail.get("credits", {}).get("cast", [])[:5]
    )

    # Director
    crew = detail.get("credits", {}).get("crew", [])
    director = " ".join(
        p["name"].replace(" ", "").replace("-", "")
        for p in crew if p.get("job") == "Director"
    )

    date_str = detail.get("release_date") or detail.get("first_air_date") or ""
    year = int(date_str[:4]) if len(date_str) >= 4 else 0

    overview = detail.get("overview", "")
    return {
        "id":           tmdb_id,
        "type":         media_type,
        "title":        title,
        "overview":     overview,
        "poster_path":  detail.get("poster_path", ""),
        "vote_average": round(detail.get("vote_average", 0), 1),
        "popularity":   detail.get("popularity", 0),
        "release_year": year,
        "genre_names":  genres,
        "keywords":     keywords,
        "cast":         cast,
        "director":     director,
        "soup": f"{(genres + ' ') * 5} {keywords} {cast} {director} {overview}",
    }


def fetch_discovery_pool(media_type: str, genre_ids: list, pages: int = POOL_PAGES, extra_params: dict = None) -> list:
    """
    Fetch a diverse pool of titles for comparison.
    Uses combined-genre discovery + per-genre pages for diversity.
    """
    rows = {}  # keyed by item_id to deduplicate
    genre_str = ",".join(str(g) for g in genre_ids) if genre_ids else ""
    extra_params = extra_params or {}

    def _add_items(data):
        for item in data.get("results", []):
            item_id = item.get("id")
            if not item_id or item_id in rows:
                continue
            title = item.get("title") or item.get("name", "")
            year_str = item.get("release_date") or item.get("first_air_date") or ""
            # Resolve genre IDs to names for better TF-IDF matching
            genre_names = resolve_genre_ids(item.get("genre_ids", []), media_type)
            overview = item.get("overview", "")
            rows[item_id] = {
                "id":           item_id,
                "type":         media_type,
                "title":        title,
                "overview":     overview,
                "poster_path":  item.get("poster_path", ""),
                "vote_average": round(item.get("vote_average", 0), 1),
                "popularity":   item.get("popularity", 0),
                "release_year": int(year_str[:4]) if len(year_str) >= 4 else 0,
                "soup":         (genre_names + " ") * 5 + overview,
            }

    # Combined-genre discovery (main pool)
    for page in range(1, pages + 1):
        params = {
            "sort_by": "popularity.desc",
            "page": page,
            "vote_count.gte": 50,
        }
        params.update(extra_params)
        if genre_str:
            params["with_genres"] = genre_str
        data = tmdb_get(f"/discover/{media_type}", params)
        _add_items(data)

    # Per-genre discovery (1 page each for diversity)
    for gid in genre_ids[:4]:
        data = tmdb_get(f"/discover/{media_type}", {
            "sort_by": "popularity.desc",
            "page": 1,
            "vote_count.gte": 50,
            "with_genres": str(gid),
            **extra_params,
        })
        _add_items(data)

    return list(rows.values())


def enrich_pool_items(pool: list, media_type: str, top_k: int = ENRICH_TOP) -> list:
    """
    Enrich the top-K pool items (by popularity) with detailed metadata
    (keywords, cast, director) for richer TF-IDF soups.
    """
    sorted_pool = sorted(pool, key=lambda x: x.get("popularity", 0), reverse=True)
    enriched_ids = set()

    for item in sorted_pool[:top_k]:
        item_id = item["id"]
        if item_id in enriched_ids:
            continue
        enriched_ids.add(item_id)

        detail = tmdb_get(f"/{media_type}/{item_id}",
                          {"append_to_response": "credits,keywords"})
        if not detail:
            continue

        # Extract keywords
        kw_data = detail.get("keywords", {})
        kw_list = kw_data.get("keywords") or kw_data.get("results", [])
        keywords = " ".join(k["name"].replace(" ", "").replace("-", "") for k in kw_list[:15])

        # Extract cast (top 3)
        cast = " ".join(
            c["name"].replace(" ", "").replace("-", "")
            for c in detail.get("credits", {}).get("cast", [])[:3]
        )

        # Extract director
        crew = detail.get("credits", {}).get("crew", [])
        director = " ".join(
            p["name"].replace(" ", "").replace("-", "")
            for p in crew if p.get("job") == "Director"
        )

        # Rebuild soup with enriched data
        genres = " ".join(g["name"].replace(" ", "").replace("-", "")
                          for g in detail.get("genres", []))
        overview = item.get("overview", "")
        item["soup"] = f"{(genres + ' ') * 5} {keywords} {cast} {director} {overview}"

    return pool


# ---- ML Core -----------------------------------------------------------------
def compute_recommendations(query_row: dict, pool: list, top_n: int = TOP_N) -> list:
    """
    Enhanced ML function with hybrid scoring.

    Steps:
        1. Combine query + pool into one DataFrame.
        2. Fit TF-IDF on the 'soup' column.
        3. Compute cosine similarity between query (index 0) and all others.
        4. Compute hybrid score: 0.75*cosine + 0.15*popularity_norm + 0.10*rating_norm
        5. Sort by hybrid score descending; return top_n results.
    """
    all_rows = [query_row] + [r for r in pool if r["id"] != query_row["id"]]
    df = pd.DataFrame(all_rows)

    if df.empty or len(df) < 2:
        return []

    df["soup"] = df["soup"].fillna("").astype(str)

    # TF-IDF vectorisation
    tfidf = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=5000)
    tfidf_matrix = tfidf.fit_transform(df["soup"])

    # Cosine similarity: query (row 0) vs all rows
    query_vec = tfidf_matrix[0:1]
    sim_scores = cosine_similarity(query_vec, tfidf_matrix)[0]

    # Normalize popularity and vote_average to [0, 1]
    pop_col = df.get("popularity", pd.Series([0] * len(df))).fillna(0).astype(float)
    vote_col = df["vote_average"].fillna(0).astype(float)

    pop_max = pop_col.max() if pop_col.max() > 0 else 1
    pop_norm = (pop_col / pop_max).values

    vote_norm = (vote_col / 10.0).values  # TMDB votes are 0-10

    # Hybrid score
    hybrid_scores = 0.75 * sim_scores + 0.15 * pop_norm + 0.10 * vote_norm

    # Sort, exclude self (index 0)
    scored = sorted(enumerate(hybrid_scores), key=lambda x: x[1], reverse=True)
    top_indices = [idx for idx, _ in scored if idx != 0][:top_n]

    results = []
    for idx in top_indices:
        row = df.iloc[idx]
        raw_score = float(hybrid_scores[idx])
        # Power scaling for human-friendly display (0.02–0.3 → 0.4–0.9)
        boosted = np.power(raw_score, 0.35) if raw_score > 0 else 0

        results.append({
            "id":           int(row["id"]),
            "type":         str(row["type"]),
            "title":        str(row["title"]),
            "overview":     str(row["overview"]),
            "poster_path":  str(row["poster_path"]),
            "poster_url":   f"{IMG_BASE}{row['poster_path']}" if row["poster_path"] else "",
            "vote_average": float(row["vote_average"]),
            "release_year": int(row["release_year"]),
            "similarity":   round(boosted, 4),
        })
    return results


# ---- Input Sanitization ------------------------------------------------------
def sanitize_string(s: str, max_len: int = 500) -> str:
    """Strip HTML tags and limit length."""
    s = re.sub(r'<[^>]+>', '', s)  # Remove HTML tags
    return s[:max_len].strip()


# ---- Rate limit error handler ------------------------------------------------
@app.errorhandler(429)
def rate_limit_handler(e):
    return jsonify({"error": "Rate limit exceeded. Please slow down.", "retry_after": e.description}), 429


# Allowlist of valid top-level TMDB path segments.
# This prevents misuse of the server's TMDB API token on unintended endpoints
# (e.g., /api/tmdb/authentication/... or /api/tmdb/account/...).
TMDB_ALLOWED_PATH_PREFIXES = {
    "trending", "movie", "tv", "search", "genre",
    "discover", "person", "collection", "network",
    "keyword", "review", "find",
}

# ---- Routes ------------------------------------------------------------------
@app.route("/health", methods=["GET"])
@limiter.limit("60/minute")
def health():
    """Health-check endpoint."""
    return jsonify({"status": "ok", "service": "CineNext ML Recommendation Engine v2"})


@app.route("/api/runtime-config", methods=["GET"])
@limiter.limit("60/minute")
def runtime_config():
    """
    Expose non-sensitive runtime config needed by the web client.
    NOTE: Supabase credentials are intentionally NOT returned here — they are
    injected server-side via the /api/client-bootstrap script tag to avoid them
    being freely discoverable via a plain JSON endpoint crawl.
    """
    return jsonify({
        "googleRedirectTo": GOOGLE_REDIRECT_TO,
        "onboardingEnabled": True,
        "analyticsEnabled": True,
    })


@app.route("/api/client-bootstrap", methods=["GET"])
@limiter.limit("60/minute")
def client_bootstrap():
    """
    Returns a <script> tag that injects Supabase credentials as a
    window-level config object. Embedding credentials in HTML rather than a
    plain JSON endpoint makes them harder to find via automated API crawling,
    and keeps them scoped to the browser context only.
    """
    from flask import Response
    script = (
        "window.__CN_CONFIG__ = {{"
        f'"supabaseUrl":"{SUPABASE_URL}",'
        f'"supabaseAnonKey":"{SUPABASE_ANON_KEY}"'
        "}};"
    )
    return Response(f"<script>{script}</script>", mimetype="text/html")


@app.route("/api/tmdb/<path:tmdb_path>", methods=["GET"])
@limiter.limit("120/minute")
def tmdb_proxy(tmdb_path):
    """
    Server-side TMDB proxy so provider credentials stay off shipped client files.
    Only whitelisted top-level path segments are permitted to prevent API token abuse.
    """
    first_segment = tmdb_path.split("/")[0].lower()
    if first_segment not in TMDB_ALLOWED_PATH_PREFIXES:
        log.warning("TMDB proxy blocked disallowed path: %s", tmdb_path)
        return jsonify({"error": "Forbidden TMDB path"}), 403
    try:
        proxied = requests.get(
            f"{BASE_URL}/{tmdb_path}",
            headers=HEADERS,
            params=request.args,
            timeout=12,
        )
        return jsonify(proxied.json()), proxied.status_code
    except Exception as exc:
        log.warning("TMDB proxy failed (%s): %s", tmdb_path, exc)
        return jsonify({"error": "TMDB proxy request failed"}), 502


@app.route("/api/omdb", methods=["GET"])
@limiter.limit("60/minute")
def omdb_proxy():
    """Server-side OMDb proxy for ratings lookups."""
    imdb_id = request.args.get("i", "").strip()
    if not imdb_id:
        return jsonify({"error": "Missing IMDB id"}), 400
    try:
        proxied = requests.get(
            OMDB_BASE,
            params={"i": imdb_id, "apikey": OMDB_KEY},
            timeout=10,
        )
        return jsonify(proxied.json()), proxied.status_code
    except Exception as exc:
        log.warning("OMDb proxy failed (%s): %s", imdb_id, exc)
        return jsonify({"error": "OMDb proxy request failed"}), 502


@app.route("/api/analytics", methods=["POST"])
@limiter.limit("120/minute")
def analytics_event():
    """Lightweight client analytics logging."""
    payload = request.get_json(silent=True) or {}
    event_name = sanitize_string(str(payload.get("event", "unknown")), 120)
    payload_keys = sorted((payload.get("payload") or {}).keys())[:20]
    log.info("analytics event=%s payload_keys=%s", event_name, payload_keys)
    return jsonify({"ok": True}), 202


@app.route("/api/recommend", methods=["GET"])
@limiter.limit("30/minute")
def recommend():
    """
    GET /api/recommend?type={movie|tv}&id={tmdb_id}&n={top_n}

    Enhanced with richer soups, hybrid scoring, and input validation.
    """
    media_type = request.args.get("type", "movie").lower()
    tmdb_id    = request.args.get("id", type=int)
    top_n      = request.args.get("n", default=TOP_N, type=int)

    # Input validation
    if media_type not in ("movie", "tv"):
        return jsonify({"error": "type must be 'movie' or 'tv'"}), 400
    if not tmdb_id or tmdb_id < 1:
        return jsonify({"error": "id parameter must be a positive integer"}), 400
    top_n = max(1, min(top_n, 50))  # Clamp to [1, 50]

    log.info("Recommendation request -> type=%s id=%d n=%d", media_type, tmdb_id, top_n)

    # 1. Fetch query-item details
    query = fetch_item_details(media_type, tmdb_id)
    if not query:
        return jsonify({"error": f"Could not fetch TMDB data for {media_type} id={tmdb_id}"}), 404

    # 2. Determine genre IDs for pool seeding
    detail_raw = tmdb_get(f"/{media_type}/{tmdb_id}")
    genre_ids = [g["id"] for g in detail_raw.get("genres", [])]

    # 3. Fetch diverse comparison pool
    pool = fetch_discovery_pool(media_type, genre_ids)

    # 4. Enrich top pool items with detailed metadata
    pool = enrich_pool_items(pool, media_type)

    # 5. Run ML algorithm
    recs = compute_recommendations(query, pool, top_n=top_n)

    return jsonify({
        "query":           query,
        "recommendations": recs,
        "algorithm":       "Content-Based Filtering v2 - TF-IDF + Cosine Similarity + Hybrid Scoring",
        "pool_size":       len(pool),
    })


@app.route("/api/mood", methods=["GET"])
@limiter.limit("20/minute")
def mood_recommend():
    """
    GET /api/mood?query={natural_language_text}&type={movie|tv}&n={top_n}

    Parses a natural-language mood query, finds similar titles using TF-IDF.
    """
    query_text = sanitize_string(request.args.get("query", ""))
    media_type = request.args.get("type", "movie").lower()
    top_n      = request.args.get("n", default=TOP_N, type=int)

    if not query_text:
        return jsonify({"error": "'query' parameter is required"}), 400
    if media_type not in ("movie", "tv"):
        return jsonify({"error": "type must be 'movie' or 'tv'"}), 400
    top_n = max(1, min(top_n, 50))

    log.info("Mood recommendation -> type=%s query='%s'", media_type, query_text)

    # Keyword-to-genre mapping
    GENRE_MAP = {
        28:    ["action", "fight", "combat", "battle", "explosive"],
        12:    ["adventure", "quest", "journey", "explore"],
        16:    ["animation", "animated", "cartoon", "anime"],
        35:    ["comedy", "funny", "hilarious", "laugh", "humor", "comic"],
        80:    ["crime", "heist", "gangster", "mafia", "detective"],
        99:    ["documentary", "real", "true story", "based on"],
        18:    ["drama", "emotional", "deep", "sad", "tragedy"],
        10751: ["family", "kids", "children", "heartwarming"],
        14:    ["fantasy", "magic", "fairy", "mythical", "dragon"],
        36:    ["history", "historical", "period", "ancient", "wwii", "world war"],
        27:    ["horror", "scary", "terrifying", "ghost", "monster", "fear"],
        9648:  ["mystery", "detective", "whodunit", "clue", "enigma"],
        10749: ["romance", "romantic", "love", "relationship"],
        878:   ["science fiction", "sci-fi", "space", "alien", "robot", "future", "dystopian"],
        53:    ["thriller", "suspense", "intense", "dark", "tense", "psychological"],
        10752: ["war", "military", "soldier", "wwii", "world war"],
        37:    ["western", "cowboy", "frontier"],
    }

    qt_lower = query_text.lower()
    matched_genres = []
    for gid, keywords in GENRE_MAP.items():
        if any(kw in qt_lower for kw in keywords):
            matched_genres.append(gid)

    pool = fetch_discovery_pool(media_type, matched_genres[:3])
    if not pool:
        return jsonify({"error": "No content found for this query."}), 404

    # Enrich pool for better matching
    pool = enrich_pool_items(pool, media_type, top_k=10)

    query_row = {
        "id":    -1,
        "type":  media_type,
        "title": f'Mood: "{query_text}"',
        "soup":  query_text,
        "overview":     query_text,
        "poster_path":  "",
        "vote_average": 0.0,
        "popularity":   0,
        "release_year": 0,
    }

    recs = compute_recommendations(query_row, pool, top_n=top_n)

    return jsonify({
        "query_text":      query_text,
        "matched_genres":  matched_genres,
        "recommendations": recs,
        "algorithm":       "Mood NLP v2 - TF-IDF + Cosine Similarity + Hybrid Scoring",
        "pool_size":       len(pool),
    })


@app.route("/api/recommend-personalized", methods=["GET"])
@app.route("/api/recommend_personalized", methods=["GET"])
@app.route("/api/recommend/personalized", methods=["GET"])
@app.route("/api/personalized", methods=["GET"])
@limiter.limit("20/minute")
def recommend_personalized():
    """
    GET /api/recommend-personalized?type={movie|tv}&watch_history={ids}&n={top_n}

    Personalized recommendations based on user watch history.
    watch_history: comma-separated list of TMDB IDs user has watched/liked
    
    Algorithm:
      1. Fetch details for all items in watch_history to extract preferences.
      2. Build a "preference soup" from genres, keywords, cast, directors.
      3. Fetch a large discovery pool.
      4. Compute recommendations using enriched TF-IDF + cosine similarity.
      5. Boost scores for items matching user preferences.
    """
    media_type = request.args.get("type", "movie").lower()
    watch_history_str = request.args.get("watch_history", "").strip()
    top_n = request.args.get("n", default=TOP_N, type=int)
    with_original_language = request.args.get("with_original_language", "").strip().lower()
    region = request.args.get("region", "").strip().upper()
    with_origin_country = request.args.get("with_origin_country", "").strip().upper()

    if media_type not in ("movie", "tv"):
        return jsonify({"error": "type must be 'movie' or 'tv'"}), 400
    
    top_n = max(1, min(top_n, 50))

    if not watch_history_str:
        return jsonify({"error": "'watch_history' parameter (CSV of TMDB IDs) is required"}), 400

    # Parse watch history IDs
    try:
        watch_ids = [int(x.strip()) for x in watch_history_str.split(",") if x.strip()]
    except ValueError:
        return jsonify({"error": "watch_history must be comma-separated integers"}), 400

    if not watch_ids:
        return jsonify({"error": "watch_history cannot be empty"}), 400

    log.info("Personalized recommendation -> type=%s history_count=%d n=%d", media_type, len(watch_ids), top_n)

    # 1. Fetch details for watched items to build user preference profile
    watched_items = []
    user_genre_ids = []
    preference_soup_parts = []

    for item_id in watch_ids[:20]:  # Limit to top 20 for performance
        detail = fetch_item_details(media_type, item_id)
        if detail:
            watched_items.append(detail)
            # Collect genres
            detail_raw = tmdb_get(f"/{media_type}/{item_id}")
            genre_ids = [g["id"] for g in detail_raw.get("genres", [])]
            user_genre_ids.extend(genre_ids)
            # Add to preference soup
            preference_soup_parts.append(detail.get("soup", ""))

    if not watched_items:
        return jsonify({"error": "Could not fetch details for watched items"}), 404

    # 2. Build user preference soup (weighted with duplication for importance)
    user_preference_soup = " ".join(preference_soup_parts) + " " + " ".join(preference_soup_parts)  # Double weight

    # 3. Fetch discovery pool, seeded by user's favorite genres
    unique_genres = list(set(user_genre_ids))[:5]  # Top 5 genres
    discovery_filters = {}
    if with_original_language:
        discovery_filters["with_original_language"] = with_original_language
    if region:
        discovery_filters["region"] = region
    if with_origin_country:
        discovery_filters["with_origin_country"] = with_origin_country

    pool = fetch_discovery_pool(media_type, unique_genres, pages=4, extra_params=discovery_filters)

    # 4. Enrich pool items
    pool = enrich_pool_items(pool, media_type, top_k=15)

    # 5. Create a synthetic query item from user preferences
    query_row = {
        "id":           -1,
        "type":         media_type,
        "title":        "User Preferences",
        "overview":     " ".join(p.get("overview", "") for p in watched_items[:5]),
        "poster_path":  "",
        "vote_average": np.mean([p.get("vote_average", 0) for p in watched_items]) if watched_items else 0,
        "popularity":   np.mean([p.get("popularity", 0) for p in watched_items]) if watched_items else 0,
        "release_year": int(np.median([p.get("release_year", 2020) for p in watched_items])) if watched_items else 2020,
        "soup":         user_preference_soup,
    }

    # 6. Compute recommendations
    recs = compute_recommendations(query_row, pool, top_n=top_n)

    # 7. Boost recommendations that match user's top genres
    top_user_genres = set(list(set(user_genre_ids))[:3])
    for rec in recs:
        # Fetch genres for this recommendation
        rec_detail = tmdb_get(f"/{media_type}/{rec['id']}")
        rec_genres = set(g["id"] for g in rec_detail.get("genres", []))
        # Boost similarity if genres match
        overlap = len(rec_genres & top_user_genres)
        if overlap > 0:
            rec["similarity"] = min(1.0, rec["similarity"] * (1.0 + (0.1 * overlap)))

    # Re-sort after boosting
    recs = sorted(recs, key=lambda x: x["similarity"], reverse=True)[:top_n]

    return jsonify({
        "user_preferences": {
            "watched_count": len(watched_items),
            "favorite_genres": unique_genres,
            "avg_rating": float(query_row["vote_average"]),
        },
        "discovery_filters": discovery_filters,
        "recommendations": recs,
        "algorithm": "Personalized v1 - User Preference Soup + TF-IDF + Genre Boosting",
        "pool_size": len(pool),
    })


# ---- AI Movie Concierge (Chat) -----------------------------------------------
@app.route("/api/concierge", methods=["POST"])
@limiter.limit("15/minute")
def concierge_chat():
    """
    POST /api/concierge
    Body: { "messages": [{"role":"user"|"ai", "content":"..."}], "type": "movie"|"tv" }

    Multi-turn conversational movie concierge. Analyzes the full chat history
    to build context-aware recommendations.
    """
    data = request.get_json(silent=True) or {}
    messages = data.get("messages", [])
    media_type = data.get("type", "movie").lower()
    top_n = data.get("n", 8)

    if media_type not in ("movie", "tv"):
        return jsonify({"error": "type must be 'movie' or 'tv'"}), 400
    if not messages:
        return jsonify({"error": "messages array is required"}), 400
    top_n = max(1, min(top_n, 20))

    # Extract the latest user message
    user_messages = [m for m in messages if m.get("role") == "user"]
    if not user_messages:
        return jsonify({"error": "No user messages found"}), 400

    latest_msg = sanitize_string(user_messages[-1].get("content", ""))
    if not latest_msg:
        return jsonify({"error": "Empty message"}), 400

    log.info("Concierge chat -> type=%s latest='%s' history_len=%d",
             media_type, latest_msg[:80], len(messages))

    # Build context soup from full conversation
    all_user_text = " ".join(
        sanitize_string(m.get("content", ""))
        for m in messages if m.get("role") == "user"
    )

    # Keyword-to-genre mapping (same as mood endpoint)
    GENRE_MAP = {
        28:    ["action", "fight", "combat", "battle", "explosive", "chase"],
        12:    ["adventure", "quest", "journey", "explore", "expedition"],
        16:    ["animation", "animated", "cartoon", "anime", "pixar"],
        35:    ["comedy", "funny", "hilarious", "laugh", "humor", "comic", "witty"],
        80:    ["crime", "heist", "gangster", "mafia", "detective", "noir"],
        99:    ["documentary", "real", "true story", "based on", "docuseries"],
        18:    ["drama", "emotional", "deep", "sad", "tragedy", "moving"],
        10751: ["family", "kids", "children", "heartwarming", "wholesome"],
        14:    ["fantasy", "magic", "fairy", "mythical", "dragon", "wizards"],
        36:    ["history", "historical", "period", "ancient", "wwii", "world war"],
        27:    ["horror", "scary", "terrifying", "ghost", "monster", "fear", "creepy"],
        9648:  ["mystery", "detective", "whodunit", "clue", "enigma", "puzzle"],
        10749: ["romance", "romantic", "love", "relationship", "date night"],
        878:   ["science fiction", "sci-fi", "space", "alien", "robot", "future", "dystopian", "cyberpunk"],
        53:    ["thriller", "suspense", "intense", "dark", "tense", "psychological", "spy"],
        10752: ["war", "military", "soldier", "wwii"],
        37:    ["western", "cowboy", "frontier"],
        10770: ["tv movie"],
    }

    # Analyze all conversation context for genres
    context_lower = all_user_text.lower()
    matched_genres = []
    for gid, keywords in GENRE_MAP.items():
        if any(kw in context_lower for kw in keywords):
            matched_genres.append(gid)

    # Detect negative preferences (e.g., "not superhero", "no romance")
    NEGATIVE_PATTERNS = {
        "superhero": [28, 878],
        "romance": [10749],
        "horror": [27],
        "animation": [16],
        "animated": [16],
        "cartoon": [16],
        "kids": [10751],
        "war": [10752],
        "documentary": [99],
        "science fiction": [878],
        "sci-fi": [878],
        "scifi": [878],
        "space": [878],
        "alien": [878],
        "aliens": [878],
        "robot": [878],
        "robots": [878],
        "future": [878],
        "dystopian": [878],
        "cyberpunk": [878],
        "fantasy": [14],
    }
    excluded_genres = set()
    for neg_pattern, genre_ids in NEGATIVE_PATTERNS.items():
        escaped = re.escape(neg_pattern)
        negative_regexes = [
            rf"\bnot\s+{escaped}\b",
            rf"\bno\s+{escaped}\b",
            rf"\bwithout\s+{escaped}\b",
            rf"\bskip\s+{escaped}\b",
            rf"\bavoid\s+{escaped}\b",
            rf"\bdon't want\s+{escaped}\b",
            rf"\bdo not want\s+{escaped}\b",
            rf"\bnot related to\s+{escaped}\b",
            rf"\banything but\s+{escaped}\b",
            rf"\bexcept\s+{escaped}\b",
            rf"\bnon[-\s]+{escaped}\b",
        ]
        if any(re.search(pattern, context_lower) for pattern in negative_regexes):
            excluded_genres.update(genre_ids)

    # Remove excluded genres
    matched_genres = [g for g in matched_genres if g not in excluded_genres]

    # Strip excluded-genre keywords from the query text so TF-IDF does not still
    # bias toward them after we have recognized the user's negative preference.
    sanitized_context = all_user_text
    if excluded_genres:
        exclusion_keywords = set()
        for gid in excluded_genres:
            exclusion_keywords.update(GENRE_MAP.get(gid, []))
        for keyword in sorted(exclusion_keywords, key=len, reverse=True):
            sanitized_context = re.sub(rf"\b{re.escape(keyword)}\b", " ", sanitized_context, flags=re.IGNORECASE)
        sanitized_context = re.sub(r"\s+", " ", sanitized_context).strip()

    # Detect decade/year preferences
    decade_keywords = {
        "90s": (1990, 1999), "80s": (1980, 1989), "70s": (1970, 1979),
        "2000s": (2000, 2009), "2010s": (2010, 2019), "classic": (1950, 1989),
        "modern": (2015, 2025), "recent": (2020, 2025), "new": (2022, 2025),
    }
    year_range = None
    for keyword, (yr_from, yr_to) in decade_keywords.items():
        if keyword in context_lower:
            year_range = (yr_from, yr_to)
            break

    # Fetch and compute recommendations
    pool = fetch_discovery_pool(media_type, matched_genres[:3])
    if not pool:
        reply = generate_concierge_reply(latest_msg, [], matched_genres, excluded_genres)
        return jsonify({
            "reply": reply,
            "recommendations": [],
            "matched_genres": matched_genres,
            "excluded_genres": list(excluded_genres),
        })

    # Apply year filter if detected
    if year_range:
        filtered = [p for p in pool if year_range[0] <= p.get("release_year", 0) <= year_range[1]]
        if len(filtered) >= 5:
            pool = filtered

    # Enrich pool
    pool = enrich_pool_items(pool, media_type, top_k=12)

    # Build query row from full context
    query_row = {
        "id":           -1,
        "type":         media_type,
        "title":        f'Concierge: "{latest_msg}"',
        "soup":         sanitized_context or all_user_text,
        "overview":     sanitized_context or all_user_text,
        "poster_path":  "",
        "vote_average": 0.0,
        "popularity":   0,
        "release_year": 0,
    }

    if excluded_genres:
        exclusion_keywords = set()
        for gid in excluded_genres:
            exclusion_keywords.update(GENRE_MAP.get(gid, []))
        filtered_pool = []
        for item in pool:
            item_soup = (item.get("soup") or "").lower()
            if any(keyword.lower() in item_soup for keyword in exclusion_keywords):
                continue
            filtered_pool.append(item)
        if filtered_pool:
            pool = filtered_pool

    recs = compute_recommendations(query_row, pool, top_n=top_n)

    # Generate conversational reply
    reply = generate_concierge_reply(latest_msg, recs, matched_genres, excluded_genres)

    return jsonify({
        "reply":           reply,
        "recommendations": recs,
        "matched_genres":  matched_genres,
        "excluded_genres": list(excluded_genres),
        "algorithm":       "Concierge v1 - Context-Aware TF-IDF + Conversation History",
        "pool_size":       len(pool),
    })


def generate_concierge_reply(user_msg, recs, matched_genres, excluded_genres):
    """Generate a natural conversational reply based on the recommendations."""
    user_lower = user_msg.lower()

    # Genre name mapping for friendly replies
    GENRE_NAMES = {
        28: "action", 12: "adventure", 16: "animation", 35: "comedy",
        80: "crime", 99: "documentary", 18: "drama", 10751: "family",
        14: "fantasy", 36: "history", 27: "horror", 9648: "mystery",
        10749: "romance", 878: "sci-fi", 53: "thriller", 10752: "war",
        37: "western",
    }

    genre_names = [GENRE_NAMES.get(g, "") for g in matched_genres if g in GENRE_NAMES]

    if not recs:
        return ("Hmm, I couldn't find great matches for that specific request. "
                "Could you tell me a bit more about what you enjoy? "
                "For example, do you prefer something intense or lighthearted?")

    # Build a contextual reply
    count = len(recs)
    top_title = recs[0].get("title", "a great pick")

    # Greeting / acknowledgment
    greetings = [
        f"Great taste! I found {count} titles that match your vibe.",
        f"Here's what I think you'll love - {count} picks curated just for you.",
        f"I've got {count} recommendations that should hit the spot.",
        f"Nice choice! Check out these {count} titles I picked for you.",
    ]

    import random
    reply = random.choice(greetings)

    if genre_names:
        genre_str = ", ".join(genre_names[:3])
        reply += f" I focused on {genre_str} based on what you described."

    if excluded_genres:
        excluded_names = [GENRE_NAMES.get(g, "") for g in excluded_genres if g in GENRE_NAMES]
        if excluded_names:
            reply += f" I've excluded {', '.join(excluded_names)} as you mentioned."

    reply += f" My top pick would be **{top_title}** - take a look!"

    # Add a follow-up question
    followups = [
        " Want me to narrow it down further?",
        " Would you like me to refine these suggestions?",
        " Tell me more about your mood and I can fine-tune the picks!",
        " Should I explore a different direction?",
    ]
    reply += random.choice(followups)

    return reply


# ---- Entry Point -------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("ML_PORT", 5001))
    print("=" * 60)
    print("  CineNext ML Recommendation Engine v2 (Enhanced)")
    print(f"  Running on http://localhost:{port}")
    print()
    print("  Registered Routes:")
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith('/static'):
            print(f"    {rule.rule}")
    print()
    print("  Enhancements: Hybrid Scoring, Enriched Soups,")
    print("                Genre Resolution, LRU Cache, Rate Limiting, User Personalization")
    print("=" * 60)
    app.run(host="0.0.0.0", port=port, debug=False)
