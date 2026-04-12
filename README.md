# CineNext

CineNext is a movie and TV recommendation app with:

1. A static frontend served from [index.html](index.html), [styles.css](styles.css), and [app.js](app.js)
2. A Python ML/API backend in [ml_server/server.py](ml_server/server.py)

The backend uses TMDB + OMDb data and provides recommendation endpoints (standard, mood-based, personalized, and concierge chat).

## Project Structure

1. [app.js](app.js): Frontend app logic
2. [index.html](index.html): Main UI
3. [styles.css](styles.css): Styling
4. [ml_server/server.py](ml_server/server.py): Flask API + recommendation engine
5. [.env.example](.env.example): Environment variable template
6. [requirements.txt](requirements.txt): Python dependencies

## Prerequisites

1. Python 3.10+
2. Node.js (for frontend dependency in [package.json](package.json))
3. TMDB API Read Access Token
4. OMDb API key
5. Supabase project URL and anon key

## Environment Variables

Copy [.env.example](.env.example) to `.env` and set real values.

Required keys:

1. `TMDB_API_TOKEN`
2. `OMDB_API_KEY`
3. `SUPABASE_URL`
4. `SUPABASE_ANON_KEY`
5. `APP_ORIGIN`
6. `ALLOWED_ORIGINS`
7. `GOOGLE_REDIRECT_TO`
8. `ML_PORT` (default: `5001`)

## Local Setup

### 1) Create and activate Python environment

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2) Install Python dependencies

```powershell
pip install -r requirements.txt
```

### 3) Install frontend dependency

```powershell
npm install
```

## Run Locally

Run these in separate terminals.

### Terminal 1: Frontend

```powershell
python -m http.server 3000
```

### Terminal 2: ML API

```powershell
python ml_server/server.py
```

Open: `http://127.0.0.1:3000`

ML API base: `http://127.0.0.1:5001`

## NPM Scripts

Defined in [package.json](package.json):

1. `npm run start:web` -> starts frontend static server on port 3000
2. `npm run start:ml` -> starts ML backend

## API Endpoints

Implemented in [ml_server/server.py](ml_server/server.py):

1. `GET /health`
2. `GET /api/runtime-config`
3. `GET /api/tmdb/<path:tmdb_path>`
4. `GET /api/omdb`
5. `POST /api/analytics`
6. `GET /api/recommend`
7. `GET /api/mood`
8. `GET /api/recommend-personalized`
9. `GET /api/recommend_personalized`
10. `GET /api/recommend/personalized`
11. `GET /api/personalized`
12. `POST /api/concierge`

## Deployment Notes

1. Do not commit `.env` (already ignored in [.gitignore](.gitignore))
2. Keep [.env.example](.env.example) committed for onboarding
3. For production, run Flask with a production WSGI server instead of the dev server

## Troubleshooting

1. Error: missing env var at startup
Cause: `.env` is missing or values are empty.

2. Frontend loads but API fails
Cause: backend not running on `ML_PORT` or CORS origins not configured.

3. Push includes local artifacts
Cause: verify [.gitignore](.gitignore) and run `git status` before commit.