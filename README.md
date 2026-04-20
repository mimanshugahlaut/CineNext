<div align="center">

<img src="https://img.shields.io/badge/CineNext-AI%20Powered-E50914?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyek04IDE3bDUtMTAgNSAxMEgxNmwtMi01LTIgNUg4eiIvPjwvc3ZnPg==" />

# 🎬 CineNext

### *Your AI-powered movie & TV companion*

[![Live Demo](https://img.shields.io/badge/🌐_Live_Demo-cine--next--lime.vercel.app-E50914?style=flat-square)](https://cine-next-lime.vercel.app)
[![Backend](https://img.shields.io/badge/ML_Backend-Render-46E3B7?style=flat-square&logo=render)](https://render.com)
[![Frontend](https://img.shields.io/badge/Frontend-Vercel-000000?style=flat-square&logo=vercel)](https://vercel.com)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)
[![Supabase](https://img.shields.io/badge/Auth-Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com)

<br/>

> Discover, track, and get personalized recommendations for movies and TV shows — powered by a custom TF-IDF + Cosine Similarity ML engine, TMDB, and OMDb.

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔥 **Trending & Top Rated** | Real-time data from TMDB across movies, TV shows & Bollywood |
| 🤖 **AI Recommendations** | Custom ML engine using TF-IDF + Cosine Similarity + Hybrid Scoring |
| 🎭 **Mood Match** | Natural language mood-to-genre search ("show me something spooky") |
| 🎪 **Smart Concierge** | AI chat assistant to find the perfect title based on your vibe |
| ❤️ **Watchlist & History** | Cloud-synced via Supabase — persists across devices |
| 🌶️ **Discover & Filter** | Filter by genre, year, rating, language and sort by popularity |
| 🎨 **Dynamic Theming** | UI accent colors extracted from each movie's poster in real time |
| 🔐 **Auth System** | Email/password + Google OAuth via Supabase |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│                  USER'S BROWSER                      │
└───────────────────┬──────────────────────────────────┘
                    │
        ┌───────────▼──────────────┐
        │        VERCEL            │  ← Frontend + Serverless Proxies
        │  index.html / app.js     │
        │  api/tmdb.js  (proxy)    │  ← Instant, no cold start
        │  api/omdb.js  (proxy)    │  ← Instant, no cold start
        │  api/config.js           │  ← Injects runtime config
        └───────┬──────────────────┘
                │  ML features only
        ┌───────▼──────────────────┐
        │        RENDER            │  ← Python ML Backend (free tier)
        │  Flask + scikit-learn    │
        │  TF-IDF Recommendation   │
        └───────┬──────────────────┘
                │
        ┌───────▼──────────────────┐
        │       SUPABASE           │  ← Auth + Watchlist + Reviews
        └──────────────────────────┘
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Python 3.10+
- Node.js (for `npm install`)
- API keys — see [Environment Variables](#-environment-variables) below

### 1. Clone & Install

```bash
git clone https://github.com/mimanshugahlaut/CineNext.git
cd CineNext

# Python environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1   # Windows PowerShell
pip install -r requirements.txt

# Frontend dependency
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
# Fill in your API keys in .env
```

### 3. Run the App

Open **two terminals**:

```bash
# Terminal 1 — Frontend (port 3000)
npm run start:web

# Terminal 2 — ML Backend (port 5001)
npm run start:ml
```

Then open: **http://127.0.0.1:3000**

---

## 🔑 Environment Variables

Copy `.env.example` to `.env` and fill in your values.

| Variable | Where to Get It |
|---|---|
| `TMDB_API_TOKEN` | [themoviedb.org](https://www.themoviedb.org/settings/api) → Read Access Token |
| `OMDB_API_KEY` | [omdbapi.com](https://www.omdbapi.com/apikey.aspx) → Free key |
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → `anon` public key |
| `APP_ORIGIN` | `http://localhost:3000` locally / your Vercel URL in production |
| `ALLOWED_ORIGINS` | Same as `APP_ORIGIN` |
| `ML_PORT` | `5001` (default) |

---

## 🧠 ML Engine

The recommendation engine lives in `ml_server/server.py` and uses:

- **TF-IDF Vectorization** on a "soup" of genres, keywords, cast, director, and overview
- **Cosine Similarity** to rank pool titles against a query item
- **Hybrid Scoring**: `0.75 × similarity + 0.15 × popularity + 0.10 × rating`
- **LRU Caching** to avoid redundant TMDB API calls
- **Rate Limiting** via Flask-Limiter

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/recommend` | Content-based recommendations |
| `GET` | `/api/recommend-personalized` | Personalized recs from watch history |
| `GET` | `/api/mood` | Natural language mood search |
| `POST` | `/api/concierge` | AI Movie Concierge chat |
| `GET` | `/api/tmdb/<path>` | Secure TMDB proxy (allowlisted) |
| `GET` | `/api/omdb` | Secure OMDb proxy |

---

## ☁️ Deployment

This app is deployed using a split architecture:

| Layer | Platform | Why |
|---|---|---|
| Frontend + Proxies | **Vercel** | Instant load, zero cold starts |
| Python ML Backend | **Render** | Supports heavy libraries (pandas, scikit-learn) |
| Database & Auth | **Supabase** | Always-on, built-in auth |

For a detailed step-by-step deployment guide, see the [Deployment Walkthrough](https://github.com/mimanshugahlaut/CineNext).

---

## 🛡️ Security

- API keys are **never exposed to the client** — all calls go through server-side proxies
- TMDB proxy uses a **path allowlist** to prevent API token abuse
- CORS is restricted to **allowed origins only** via `ALLOWED_ORIGINS`
- Rate limiting on all endpoints via **Flask-Limiter**

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push and open a Pull Request

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<div align="center">

Made by [Mimanshu Gahlaut](https://github.com/mimanshugahlaut)

⭐ Star this repo if you found it useful!

</div>
