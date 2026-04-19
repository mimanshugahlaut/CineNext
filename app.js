// ── CORE GLOBALS & UTILS ─────────────────────────────────────
function getDefaultMlBase() {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === 'localhost') {
    return `${window.location.protocol}//${host}:5001`;
  }
  return '';
}

const DEFAULT_ML_BASE = getDefaultMlBase();
const IMG = 'https://image.tmdb.org/t/p/w500';
const IMG_ORIGINAL = 'https://image.tmdb.org/t/p/original';
const PROFILE_IMG = 'https://image.tmdb.org/t/p/w185';

let appConfig = {
  mlBase: DEFAULT_ML_BASE,
  supabaseUrl: '',
  supabaseAnonKey: '',
  googleRedirectTo: ''
};

let supabaseClient = null;
let searchTimeout = null;
let currentUser = null;
let watchlist = [];
let currentTab = 'movies';
let activeGenreId = null;
let activeGenreName = '';
const genres = { movie: [], tv: [] };
let discoverState = {
  type: 'movie',
  sort: 'popularity.desc',
  yearFrom: '',
  yearTo: '',
  rating: 0,
  genres: [],
  page: 1,
  results: [],
};

const appViewState = {
  view: 'home',
  overlay: null
};

async function loadRuntimeConfig() {
  try {
    const mlBase = localStorage.getItem('mlBase') || DEFAULT_ML_BASE;
    appConfig.mlBase = mlBase;

    // Step 1: Load non-sensitive runtime config (redirect URLs, feature flags)
    const res = await fetch(`${mlBase}/api/runtime-config`);
    if (res.ok) {
      const data = await res.json();
      appConfig = { ...appConfig, ...data };
    }

    // Step 2: Load Supabase credentials.
    // Prefer window.__CN_CONFIG__ which is injected by the server as an inline
    // <script> block — keeping the keys out of plain JSON API responses.
    // Falls back to a direct bootstrap fetch for local development.
    const injected = window.__CN_CONFIG__;
    if (injected && injected.supabaseUrl && injected.supabaseAnonKey) {
      appConfig.supabaseUrl = injected.supabaseUrl;
      appConfig.supabaseAnonKey = injected.supabaseAnonKey;
    } else {
      // Local dev fallback: fetch the bootstrap endpoint
      try {
        const bootstrapRes = await fetch(`${mlBase}/api/client-bootstrap`);
        if (bootstrapRes.ok) {
          // The endpoint returns a <script> block; execute it to populate window.__CN_CONFIG__
          const scriptText = await bootstrapRes.text();
          const match = scriptText.match(/window\.__CN_CONFIG__\s*=\s*(\{[\s\S]*?\});/);
          if (match) {
            const cfg = JSON.parse(match[1]);
            appConfig.supabaseUrl = cfg.supabaseUrl || '';
            appConfig.supabaseAnonKey = cfg.supabaseAnonKey || '';
          }
        }
      } catch (bootstrapErr) {
        console.warn('client-bootstrap fetch failed:', bootstrapErr);
      }
    }
  } catch (err) {
    console.warn('loadRuntimeConfig failed:', err);
    throw err;
  }
}

function setPrimaryView(viewId) {
  appViewState.view = viewId;
  const sections = [dom.heroSection, dom.trendingSection, dom.topRatedSection, dom.upcomingSection, dom.searchSection, dom.genreSection, dom.discoverSection];
  sections.forEach(s => s && s.classList.add('hidden'));

  if (viewId === 'home') {
    dom.heroSection?.classList.remove('hidden');
    dom.trendingSection?.classList.remove('hidden');
    dom.topRatedSection?.classList.remove('hidden');
    dom.upcomingSection?.classList.remove('hidden');
  } else if (viewId === 'search') {
    dom.searchSection?.classList.remove('hidden');
  } else if (viewId === 'genre') {
    dom.genreSection?.classList.remove('hidden');
  } else if (viewId === 'discover') {
    dom.discoverSection?.classList.remove('hidden');
  }
}

function setOverlayState(overlayId) {
  appViewState.overlay = overlayId;
  
  if (overlayId === 'modal') {
    dom.modalBackdrop?.classList.add('show');
    dom.modal?.classList.add('show');
    document.body.style.overflow = 'hidden';
  } else {
    dom.modalBackdrop?.classList.remove('show');
    dom.modal?.classList.remove('show');
  }
  
  if (overlayId === 'drawer') {
    dom.drawerOverlay?.classList.add('show');
    dom.watchlistDrawer?.classList.add('show');
    document.body.style.overflow = 'hidden';
  } else {
    dom.drawerOverlay?.classList.remove('show');
    dom.watchlistDrawer?.classList.remove('show');
  }
  
  if (overlayId === 'smart-match') {
    dom.conciergeOverlay?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  } else {
    dom.conciergeOverlay?.classList.add('hidden');
  }
  
  if (overlayId === 'onboarding') {
    dom.onboardingOverlay?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  } else {
    dom.onboardingOverlay?.classList.add('hidden');
  }
  
  if (!overlayId) {
    document.body.style.overflow = '';
  }
}

function isAuthScreenVisible() {
  const authScreen = document.getElementById('auth-screen');
  return !!authScreen && !authScreen.classList.contains('hidden');
}

function updateBodyScrollLock() {
  if (isAuthScreenVisible() || appViewState.overlay) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
}

function maybeShowOnboarding() {
  if (!localStorage.getItem('cinenext_onboarded')) {
    setOverlayState('onboarding');
  }
}

function dismissOnboarding() {
  localStorage.setItem('cinenext_onboarded', 'true');
  setOverlayState(null);
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast show';
  toast.textContent = msg;
  if(dom.toastStack) dom.toastStack.appendChild(toast);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function checkMlServer() {
  try {
    const res = await fetch(`${appConfig.mlBase}/health`);
    if(res.ok) console.log('ML server connected');
  } catch (err) {
    console.warn('ML server unavailable');
  }
}

function trackEvent(name, data) {
  console.log(`[Tracking] ${name}`, data);
}

function normalizeMediaItem(item, forceType) {
  // Merge original item so we don't lose raw data, but enforce standard keys
  return {
    ...item,
    id: item.id,
    title: item.title || item.name || 'Unknown',
    media_type: item.media_type || forceType || 'movie',
    poster_path: item.poster_path,
    backdrop_path: item.backdrop_path,
    overview: item.overview || '',
    vote_average: item.vote_average || 0,
    release_date: item.release_date || item.first_air_date || ''
  };
}

function renderStateCard(container, data) {
  if(!container) return;
  container.innerHTML = `
    <div class="state-card ${data.variant || ''}">
      <h3>${data.title}</h3>
      <p>${data.message}</p>
    </div>
  `;
}

async function fetchMlRecommendations(movieId) {
  const url = `${getMlBase()}/api/similar/${movieId}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('ML rec failed:', e);
    return null;
  }
}

// -- DOM refs --------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  navbar: $('#navbar'),
  searchInput: $('#search-input'),
  discoverBtn: $('#discover-btn'),
  genreBtn: $('#genre-btn'),
  genreMenu: $('#genre-menu'),
  watchlistBtn: $('#watchlist-btn'),
  watchlistCount: $('#watchlist-count'),

  contentTabs: $('#content-tabs'),
  heroSection: $('#hero'),

  searchSection: $('#search-results-section'),
  searchGrid: $('#search-results-grid'),
  searchQueryDisplay: $('#search-query-display'),
  searchResultsMeta: $('#search-results-meta'),
  clearSearchBtn: $('#clear-search-btn'),
  searchLoadMore: $('#search-load-more'),

  genreSection: $('#genre-results-section'),
  genreGrid: $('#genre-results-grid'),
  genreNameDisplay: $('#genre-name-display'),
  clearGenreBtn: $('#clear-genre-btn'),

  trendingSection: $('#trending-section'),
  trendingGrid: $('#trending-grid'),
  trendingSubtitle: $('#trending-subtitle'),

  topRatedSection: $('#top-rated-section'),
  topRatedGrid: $('#top-rated-grid'),
  topRatedSubtitle: $('#top-rated-subtitle'),

  upcomingGrid: $('#upcoming-grid'),
  upcomingTitle: $('#upcoming-title'),
  upcomingSubtitle: $('#upcoming-subtitle'),
  upcomingSection: $('#upcoming-section'),

  recommendedSection: $('#recommended-section'),
  recommendedGrid: $('#recommended-grid'),

  modalBackdrop: $('#modal-backdrop'),
  modal: $('#modal'),
  modalClose: $('#modal-close'),
  modalBackdropImg: $('#modal-backdrop-img'),
  modalPoster: $('#modal-poster'),
  modalTitle: $('#modal-title'),
  modalMetaTags: $('#modal-meta-tags'),
  modalOverview: $('#modal-overview'),
  modalWatchlistBtn: $('#modal-watchlist-btn'),
  trailerSection: $('#trailer-section'),
  trailerContainer: $('#trailer-container'),
  castSection: $('#cast-section'),
  castScroll: $('#cast-scroll'),
  similarSection: $('#similar-section'),
  similarGrid: $('#similar-grid'),

  drawerOverlay: $('#drawer-overlay'),
  watchlistDrawer: $('#watchlist-drawer'),
  drawerClose: $('#drawer-close'),
  drawerBody: $('#drawer-body'),
  drawerEmpty: $('#drawer-empty'),

  particles: $('#particles'),
  logoLink: $('#logo-link'),

  // AI Movie Concierge
  smartMatchFab: $('#smart-match-fab'),
  conciergeOverlay: $('#concierge-overlay'),
  conciergeContainer: $('.concierge-container'),
  conciergeClose: $('#concierge-close'),
  conciergeInput: $('#concierge-input'),
  conciergeSend: $('#concierge-send'),
  conciergeMessages: $('#concierge-messages'),
  colorExtractCanvas: $('#color-extract-canvas'),

  // Mobile Nav
  mobileNav: $('#mobile-nav'),
  mobileNavItems: $$('.mobile-nav-item'),
  mobileHome: $('#mobile-nav-home'),
  mobileSmart: $('#mobile-nav-smart'),
  mobileProfile: $('#mobile-nav-profile'),
  mobileDiscover: $('#mobile-nav-discover'),

  // Discover Page
  discoverSection: $('#discover-section'),
  discoverGrid: $('#discover-grid'),
  discoverResultsMeta: $('#discover-results-meta'),
  discoverSort: $('#discover-sort'),
  discoverYearFrom: $('#year-from'),
  discoverYearTo: $('#year-to'),
  discoverRating: $('#filter-rating'),
  discoverRatingVal: $('#rating-val'),
  discoverGenres: $('#discover-genres'),
  discoverReset: $('#filter-reset'),
  discoverLoadMore: $('#load-more-btn'),
  discoverTypeToggles: $$('.filter-toggle'),

  onboardingOverlay: $('#onboarding-overlay'),
  onboardingClose: $('#onboarding-close'),
  onboardingCta: $('#onboarding-cta'),
  toastStack: $('#toast-stack'),
};
// ═══════════════════════════════════════════════════════════════
// SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════
function getMlBase() {
  return appConfig.mlBase || DEFAULT_ML_BASE;
}

function getSupabaseUrl() {
  return appConfig.supabaseUrl || '';
}

function getSupabaseAnonKey() {
  return appConfig.supabaseAnonKey || '';
}

function getGoogleRedirectUrl() {
  return appConfig.googleRedirectTo || window.location.origin;
}

function getSupabaseProjectRef() {
  try {
    const url = new URL(getSupabaseUrl());
    return url.hostname.split('.')[0] || '';
  } catch (err) {
    return '';
  }
}

function getSupabaseStorageKey() {
  const projectRef = getSupabaseProjectRef();
  return projectRef ? `sb-${projectRef}-auth-token` : 'sb-auth-token';
}

async function recoverOAuthSession() {
  if (!supabaseClient) return;
  const currentUrl = new URL(window.location.href);
  const authCode = currentUrl.searchParams.get('code');
  if (!authCode) return;

  try {
    const { error } = await supabaseClient.auth.exchangeCodeForSession(authCode);
    if (error) {
      console.warn('OAuth code exchange failed:', error.message);
      return;
    }
    currentUrl.searchParams.delete('code');
    currentUrl.searchParams.delete('state');
    window.history.replaceState({}, document.title, currentUrl.toString());
  } catch (err) {
    console.warn('OAuth recovery failed:', err);
  }
}

function initializeSupabaseClient() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase runtime config is missing.');
  }
  supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      flowType: 'pkce'
    }
  });
}

// Pending signup email for OTP verification
let pendingOtpEmail = '';

// ═══════════════════════════════════════════════════════════════
// INPUT SANITIZATION
// ═══════════════════════════════════════════════════════════════
function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════
// AUTH SYSTEM (Supabase)
// ═══════════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function showAuthMessage(text, type = 'error-msg') {
  const el = $('#auth-message');
  el.textContent = text;
  el.className = `auth-message show ${type}`;
  setTimeout(() => { el.classList.remove('show'); }, 4000);
}

function showOtpMessage(text, type = 'success') {
  const el = $('#otp-message');
  el.textContent = text;
  el.className = `auth-message show ${type}`;
  setTimeout(() => { el.classList.remove('show'); }, 5000);
}

function clearFieldError(inputId) {
  const input = $(`#${inputId}`);
  if (input) input.classList.remove('error');
  const errEl = $(`#${inputId}-error`);
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
}

function showFieldError(inputId, msg) {
  const input = $(`#${inputId}`);
  if (input) input.classList.add('error');
  const errEl = $(`#${inputId}-error`);
  if (errEl) { errEl.textContent = msg; errEl.classList.add('show'); }
}

// ── Password Strength ─────────────────────────────────────────
function updatePasswordStrength(password) {
  const bars = [1, 2, 3, 4].map(i => $(`#str-bar-${i}`));
  const textEl = $('#password-strength-text');
  bars.forEach(b => b.className = 'password-strength-bar');

  if (!password) { textEl.textContent = ''; return; }

  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const level = score <= 1 ? 'weak' : score <= 3 ? 'medium' : 'strong';
  const labels = { weak: 'Weak', medium: 'Medium', strong: 'Strong' };
  const fill = score <= 1 ? 1 : score <= 3 ? 2 : score <= 4 ? 3 : 4;

  for (let i = 0; i < fill; i++) bars[i].classList.add(level);
  textEl.textContent = labels[level];
  textEl.style.color = level === 'weak' ? '#ef4444' : level === 'medium' ? '#f59e0b' : 'var(--green)';
}

// ── Sign Up (Supabase) ────────────────────────────────────────
async function handleSignup(e) {
  e.preventDefault();

  if (!supabaseClient) {
    showAuthMessage('Connecting to authentication server... please wait a moment.');
    return;
  }

  const name = $('#signup-name').value.trim();
  const email = $('#signup-email').value.trim().toLowerCase();
  const password = $('#signup-password').value;
  const confirm = $('#signup-confirm').value;

  ['signup-name', 'signup-email', 'signup-password', 'signup-confirm'].forEach(clearFieldError);

  let valid = true;
  if (!name) { showFieldError('signup-name', 'Name is required'); valid = false; }
  if (!email) { showFieldError('signup-email', 'Email is required'); valid = false; }
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFieldError('signup-email', 'Invalid email format'); valid = false; }
  if (password.length < 6) { showFieldError('signup-password', 'Min 6 characters'); valid = false; }
  if (password !== confirm) { showFieldError('signup-confirm', 'Passwords do not match'); valid = false; }
  if (!valid) return;

  const btn = $('#signup-submit');
  btn.disabled = true;
  btn.textContent = 'CREATING ACCOUNT...';

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
    },
  });

  btn.disabled = false;
  btn.textContent = 'CREATE ACCOUNT';

  if (error) {
    if (error.message.toLowerCase().includes('rate limit')) {
      showAuthMessage('Rate limit exceeded. Please wait 15 mins OR increase "Max Emails per Hour" in your Supabase Dashboard (Authentication > Rate Limits).');
    } else {
      showAuthMessage(error.message);
    }
    return;
  }

  // Auto-enter the app (email confirmation disabled in Supabase)
  if (data.session) {
    currentUser = data.user;
    enterApp();
  } else if (data.user) {
    // If no session returned, try logging in directly
    const { data: loginData, error: loginErr } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (loginData?.session) {
      currentUser = loginData.user;
      enterApp();
    } else {
      showAuthMessage(loginErr?.message || 'Account created! Please log in.');
    }
  }
}

// ── Login (Supabase) ──────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  
  if (!supabaseClient) {
    showAuthMessage('Connecting to authentication server... please wait a moment.');
    return;
  }

  const email = $('#login-email').value.trim().toLowerCase();
  const password = $('#login-password').value;

  ['login-email', 'login-password'].forEach(clearFieldError);

  let valid = true;
  if (!email) { showFieldError('login-email', 'Email is required'); valid = false; }
  if (!password) { showFieldError('login-password', 'Password is required'); valid = false; }
  if (!valid) return;

  const btn = $('#login-submit');
  btn.disabled = true;
  btn.textContent = 'LOGGING IN...';

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'LOGIN';

  if (error) {
    if (error.message.toLowerCase().includes('rate limit')) {
      showAuthMessage('Rate limit exceeded. Please wait 15 mins OR increase "Max Emails per Hour" in your Supabase Dashboard (Authentication > Rate Limits).');
    } else if (error.message.includes('Invalid login')) {
      showFieldError('login-password', 'Invalid email or password');
    } else if (error.message.includes('Email not confirmed')) {
      showAuthMessage('Email not confirmed. Please DISABLE "Confirm email" in your Supabase Dashboard (Authentication > Providers > Email).');
    } else {
      showAuthMessage(error.message);
    }
    return;
  }

  currentUser = data.user;
  enterApp();
}

// ── OTP & Google Sign-In (Removed) ────────────────────────────
// OTP verification is not used in this build.
// Signup is now instant (email confirmation disabled in Supabase).
function showOtpScreen() {}
function hideOtpScreen() {}
function initOtpEvents() {}
async function handleGoogleSignIn() {
  if (!supabaseClient) {
    showAuthMessage('Authentication is not ready yet. Try again in a moment.');
    return;
  }

  const btn = $('#google-signin-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'REDIRECTING TO GOOGLE...';
  }

  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getGoogleRedirectUrl(),
      queryParams: {
        access_type: 'offline',
        prompt: 'select_account'
      }
    }
  });

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Continue with Google';
  }

  if (error) {
    showAuthMessage(error.message);
  }
}

// ── UI Updates ────────────────────────────────────────────────
async function enterApp() {
  $('#auth-screen').classList.add('hidden');
  setOverlayState(null);
  setPrimaryView('home');
  updateUserProfile();

  // Ensure main content sections are visible
  dom.trendingSection.classList.remove('hidden');
  dom.topRatedSection.classList.remove('hidden');
  dom.upcomingSection.classList.remove('hidden');
  dom.discoverSection.classList.add('hidden');
  dom.searchSection.classList.add('hidden');
  dom.genreSection.classList.add('hidden');

  loadGenres();
  loadContent();
  // Skip Supabase-dependent data for guests
  if (!currentUser?.isGuest) {
    loadPersonalizedRecommendations();
  }
  maybeShowOnboarding();
  updateBodyScrollLock();
}

function showAuthScreen() {
  $('#auth-screen').classList.remove('hidden');
  setOverlayState(null);
  updateBodyScrollLock();
}

function getUserDisplayName() {
  if (!currentUser) return 'User';
  return currentUser.user_metadata?.full_name
    || currentUser.user_metadata?.name
    || currentUser.email?.split('@')[0]
    || 'User';
}

function updateUserProfile() {
  if (!currentUser) return;
  const avatarEl = $('#nav-user-avatar');
  const nameEl = $('#nav-user-name');
  const ddName = $('#dropdown-user-name');
  const ddEmail = $('#dropdown-user-email');

  const displayName = getUserDisplayName();
  nameEl.textContent = displayName.split(' ')[0];
  ddName.textContent = displayName;
  ddEmail.textContent = currentUser.isGuest ? 'Guest Mode — Sign up to save progress' : (currentUser.email || '');

  const picture = currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture;
  if (picture) {
    avatarEl.innerHTML = `<img src="${escapeHTML(picture)}" alt="${escapeHTML(displayName)}" referrerpolicy="no-referrer" />`;
  } else {
    avatarEl.textContent = getInitials(displayName);
  }
}

async function logout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  watchlist = [];
  dom.onboardingOverlay.classList.add('hidden');
  showAuthScreen();
  $('#nav-user-avatar').innerHTML = '';
  $('#nav-user-name').textContent = '';
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE DATA LAYER
// ═══════════════════════════════════════════════════════════════
// In-memory caches (loaded from DB on login)
let watchedList = [];
let favouritesList = [];

async function migrateLocalData(uid, email) {
  const migrated = localStorage.getItem('cinenext_migrated_' + uid);
  if (migrated === 'true') return;

  try {
    // 1. Watchlist
    const localWl = JSON.parse(localStorage.getItem('cinenext_watchlist') || '[]');
    if (localWl.length > 0) {
      const payloads = localWl.map(item => ({
        user_id: uid, tmdb_id: item.id, media_type: item.media_type || 'movie',
        title: item.title || item.name, poster_path: item.poster_path, 
        vote_average: item.vote_average || 0, release_date: item.release_date || null
      }));
      await supabaseClient.from('watchlist').insert(payloads);
    }

    // 2. Watched
    const localWatched = JSON.parse(localStorage.getItem('cinenext_watched') || '[]');
    if (localWatched.length > 0) {
      const payloads = localWatched.map(item => ({
        user_id: uid, tmdb_id: item.id, media_type: item.media_type || 'movie',
        title: item.title || item.name, poster_path: item.poster_path
      }));
      await supabaseClient.from('watched').insert(payloads);
    }

    // 3. Favourites
    const localFavs = JSON.parse(localStorage.getItem('cinenext_favourites') || '[]');
    if (localFavs.length > 0) {
      const payloads = localFavs.map(item => ({
        user_id: uid, tmdb_id: item.id, media_type: item.media_type || 'movie',
        title: item.title || item.name, poster_path: item.poster_path, vote_average: item.vote_average || 0
      }));
      await supabaseClient.from('favourites').insert(payloads);
    }

    // 4. Reviews
    const localReviews = JSON.parse(localStorage.getItem('cinenext_reviews') || '{}');
    const reviewPayloads = [];
    Object.keys(localReviews).forEach(itemId => {
      localReviews[itemId].forEach(r => {
        if (email && r.userEmail === email) { // migrate only their reviews
          reviewPayloads.push({
            user_id: uid,
            user_name: r.userName || 'User',
            user_email: r.userEmail,
            tmdb_id: parseInt(itemId),
            media_type: 'movie', 
            rating: r.rating,
            review_text: r.text || r.review
          });
        }
      });
    });
    if (reviewPayloads.length > 0) {
      await supabaseClient.from('reviews').insert(reviewPayloads);
    }

    localStorage.setItem('cinenext_migrated_' + uid, 'true');
    console.log('Legacy data migrated to Supabase successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
  }
}

async function loadUserDataFromDB() {
  if (!currentUser) return;
  const uid = currentUser.id;
  
  await migrateLocalData(uid, currentUser.email);

  // Load watchlist
  const { data: wlData } = await supabaseClient
    .from('watchlist').select('*').eq('user_id', uid);
  watchlist = (wlData || []).map(r => ({
    id: r.tmdb_id, title: r.title, poster_path: r.poster_path,
    vote_average: r.vote_average, media_type: r.media_type,
    release_date: r.release_date,
  }));

  // Load watched
  const { data: watchedData } = await supabaseClient
    .from('watched').select('*').eq('user_id', uid);
  watchedList = (watchedData || []).map(r => ({
    id: r.tmdb_id, title: r.title, poster_path: r.poster_path,
    media_type: r.media_type,
  }));

  // Load favourites
  const { data: favData } = await supabaseClient
    .from('favourites').select('*').eq('user_id', uid);
  favouritesList = (favData || []).map(r => ({
    id: r.tmdb_id, title: r.title, poster_path: r.poster_path,
    vote_average: r.vote_average, media_type: r.media_type,
  }));

  updateWatchlistCount();

  // Load personalized recommendations after loading other user data
  loadPersonalizedRecommendations();
}

// ── Load Personalized Recommendations ─────────────────────────
async function loadPersonalizedRecommendations() {
  if (getCurrentViewName() !== 'home') {
    dom.recommendedSection.classList.add('hidden');
    return;
  }

  if (!currentUser) {
    dom.recommendedSection.classList.add('hidden');
    return;
  }

  if (!watchedList || watchedList.length === 0) {
    dom.recommendedSection.classList.remove('hidden');
    renderStateCard(dom.recommendedGrid, {
      variant: 'empty',
      title: 'Personalized picks will appear here',
      message: 'Mark a few titles as watched or add to your watchlist to help CineNext learn your taste.',
    });
    return;
  }

  const cacheKey = `cinenext_personalized_${currentUser.id}_${currentTab}`;
  const cached = localStorage.getItem(cacheKey);
  const cacheTime = localStorage.getItem(`${cacheKey}_time`);
  const now = Date.now();

  // Use cache if <1 hour old
  if (cached && cacheTime && (now - parseInt(cacheTime)) < 3600000) {
    const items = JSON.parse(cached);
    renderPersonalizedRecommendations(items);
    return;
  }

  // Determine media type for this tab
  const mediaType = currentTab === 'tv' ? 'tv' : 'movie';
  
  // Get watched items of matching type
  const matchingWatched = watchedList.filter(w => (w.media_type || 'movie') === mediaType);
  
  if (matchingWatched.length === 0) {
    dom.recommendedSection.classList.remove('hidden');
    renderStateCard(dom.recommendedGrid, {
      variant: 'empty',
      title: 'No picks for this tab yet',
      message: `Switch to ${mediaType === 'movie' ? 'TV Shows' : 'Movies'} or watch more ${mediaType === 'movie' ? 'movies' : 'shows'} to unlock tailored suggestions.`,
    });
    return;
  }

  renderSkeletons(dom.recommendedGrid);
  dom.recommendedSection.classList.remove('hidden');

  try {
    // Try personalized recommendation first
    const recommendationFilters = currentTab === 'bollywood'
      ? { with_original_language: 'hi', region: 'IN', with_origin_country: 'IN' }
      : {};
    let result = await api.mlPersonalized(mediaType, matchingWatched, recommendationFilters);
    
    // If personalized unavailable, fallback to content-based on the first watched item
    if (!result || !result.recommendations || result.recommendations.length === 0) {
      console.debug('Personalized endpoint unavailable or returned no results, using fallback...');
      if (matchingWatched.length > 0) {
        result = await api.mlRecommend(mediaType, matchingWatched[0].id);
      }
    }
    
    if (result && result.recommendations && result.recommendations.length > 0) {
      // Convert ML output to app format
      const items = result.recommendations.map(rec => ({
        id: rec.id,
        title: rec.title,
        poster_path: rec.poster_path,
        vote_average: rec.vote_average,
        media_type: rec.type,
        release_date: rec.release_year ? `${rec.release_year}-01-01` : '',
      }));

      // Cache the results
      localStorage.setItem(cacheKey, JSON.stringify(items));
      localStorage.setItem(`${cacheKey}_time`, now.toString());

      renderPersonalizedRecommendations(items);
    } else {
      renderStateCard(dom.recommendedGrid, {
        variant: 'empty',
        title: 'We need a bit more signal',
        message: 'Keep exploring and saving titles. Personalized suggestions will improve as you use CineNext.',
      });
      dom.recommendedSection.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Error loading personalized recommendations:', err);
    renderStateCard(dom.recommendedGrid, {
      variant: 'error',
      title: 'Recommendations are taking a break',
      message: 'The recommendation service could not respond right now. Your main browsing experience still works.',
    });
    dom.recommendedSection.classList.remove('hidden');
  }
}

function renderPersonalizedRecommendations(items) {
  renderGrid(dom.recommendedGrid, items, currentTab === 'tv' ? 'tv' : 'movie');
  dom.recommendedSection.classList.remove('hidden');
}

function clearPersonalizedCache() {
  if (!currentUser) return;
  // Clear cache for all tabs
  ['movies', 'tv', 'bollywood'].forEach(tab => {
    const cacheKey = `cinenext_personalized_${currentUser.id}_${tab}`;
    localStorage.removeItem(cacheKey);
    localStorage.removeItem(`${cacheKey}_time`);
  });
  // Reload current tab's recommendations
  loadPersonalizedRecommendations();
}

// ═══════════════════════════════════════════════════════════════
// MY PROFILE MODAL
// ═══════════════════════════════════════════════════════════════
async function openProfileModal(options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  if (!currentUser) return;
  const overlay = $('#profile-modal-overlay');
  overlay.classList.remove('hidden');
  setOverlayState('profile');

  const displayName = getUserDisplayName();
  const picture = currentUser.user_metadata?.avatar_url || currentUser.user_metadata?.picture;

  const avatarEl = $('#profile-avatar');
  if (picture) {
    avatarEl.innerHTML = `<img src="${escapeHTML(picture)}" alt="${escapeHTML(displayName)}" referrerpolicy="no-referrer" />`;
  } else {
    avatarEl.textContent = getInitials(displayName);
  }
  $('#profile-name').textContent = displayName;
  $('#profile-email').textContent = currentUser.email || '';

  // Join date from Supabase
  if (currentUser.created_at) {
    const joinDate = new Date(currentUser.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    $('#profile-joined').textContent = `Joined ${joinDate}`;
  } else {
    $('#profile-joined').textContent = '';
  }

  // Stats - count reviews from DB
  const { count: reviewCount } = await supabaseClient
    .from('reviews').select('*', { count: 'exact', head: true })
    .eq('user_id', currentUser.id);

  $('#profile-stats').innerHTML = `
    <div class="profile-stat-card">
      <div class="profile-stat-value accent">${watchlist.length}</div>
      <div class="profile-stat-label">Watchlist</div>
    </div>
    <div class="profile-stat-card">
      <div class="profile-stat-value green">${watchedList.length}</div>
      <div class="profile-stat-label">Watched</div>
    </div>
    <div class="profile-stat-card">
      <div class="profile-stat-value pink">${favouritesList.length}</div>
      <div class="profile-stat-label">Favourites</div>
    </div>
    <div class="profile-stat-card">
      <div class="profile-stat-value blue">${reviewCount || 0}</div>
      <div class="profile-stat-label">Reviews</div>
    </div>
  `;

  renderProfileGrid('#profile-favourites-grid', favouritesList, 'No favourites yet. Click ❤️ on a title to add it here.');
  renderProfileGrid('#profile-watched-grid', watchedList, 'No watched titles yet. Mark titles as watched from the detail view.');

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function renderProfileGrid(selector, items, emptyText) {
  const container = $(selector);
  if (!items || items.length === 0) {
    container.innerHTML = `<div class="profile-grid-empty">${emptyText}</div>`;
    return;
  }
  container.innerHTML = items.map(item => {
    const poster = item.poster_path ? `${IMG}${item.poster_path}` : null;
    return `
      <div class="profile-grid-item" data-id="${item.id}" data-type="${item.media_type || 'movie'}" title="${item.title || ''}">
        ${poster
          ? `<img src="${poster}" alt="${item.title || ''}" loading="lazy" />`
          : `<div class="no-poster">🎬</div>`
        }
      </div>
    `;
  }).join('');

  container.querySelectorAll('.profile-grid-item').forEach(el => {
    el.addEventListener('click', () => {
      closeProfileModal();
      openModal(parseInt(el.dataset.id), el.dataset.type);
    });
  });
}

function closeProfileModal(options = {}) {
  const { updateHistory = true } = options;
  $('#profile-modal-overlay').classList.add('hidden');
  setOverlayState(null);

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

// ── Auth Event Bindings ───────────────────────────────────────
function bindAuthEvents() {
  // Tab switching
  const loginTab = $('#auth-tab-login');
  const signupTab = $('#auth-tab-signup');
  const loginForm = $('#login-form');
  const signupForm = $('#signup-form');

  loginTab?.addEventListener('click', () => {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
  });

  signupTab?.addEventListener('click', () => {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    signupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  });

  // Form submissions
  loginForm?.addEventListener('submit', handleLogin);
  signupForm?.addEventListener('submit', handleSignup);

  // Password strength
  $('#signup-password')?.addEventListener('input', (e) => updatePasswordStrength(e.target.value));

  // Clear errors on input
  ['login-email', 'login-password', 'signup-name', 'signup-email', 'signup-password', 'signup-confirm']
    .forEach(id => {
      $(`#${id}`)?.addEventListener('input', () => clearFieldError(id));
    });

  // User dropdown
  const navUser = $('#nav-user');
  const userDropdown = $('#user-dropdown');

  navUser?.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdown?.classList.toggle('show');
  });

  document.addEventListener('click', () => userDropdown?.classList.remove('show'));
  userDropdown?.addEventListener('click', (e) => e.stopPropagation());

  // My Profile
  $('#dropdown-profile')?.addEventListener('click', () => {
    userDropdown?.classList.remove('show');
    trackEvent('profile_open', { source: 'dropdown' });
    openProfileModal();
  });

  // Profile close
  $('#profile-close')?.addEventListener('click', closeProfileModal);
  $('#profile-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('#profile-modal-overlay')) closeProfileModal();
  });

  // Logout
  $('#dropdown-logout')?.addEventListener('click', () => {
    userDropdown?.classList.remove('show');
    logout();
  });

  // Guest access
  $('#auth-guest-btn')?.addEventListener('click', handleGuestLogin);
  $('#google-signin-btn')?.addEventListener('click', handleGoogleSignIn);
}

// ── Guest Login ───────────────────────────────────────────────
function handleGuestLogin() {
  // Create a lightweight guest user object (no Supabase session)
  currentUser = {
    id: 'guest-' + Date.now(),
    email: '',
    user_metadata: { full_name: 'Guest' },
    isGuest: true,
  };
  enterApp();
}

// ═══════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════
async function tmdb(endpoint, params = {}) {
  const url = new URL(`${getMlBase()}/api/tmdb${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      return { isError: true, message: `HTTP ${res.status}: ${errText}` };
    }
    return await res.json();
  } catch (err) {
    console.error('TMDB fetch error:', err);
    return { isError: true, message: err.message };
  }
}

async function omdbByImdbId(imdbId) {
  const url = new URL(`${getMlBase()}/api/omdb`);
  url.searchParams.set('i', imdbId);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('OMDb proxy fetch failed:', err);
    return null;
  }
}

// ── Specific endpoints ────────────────────────────────────────
const api = {
  trendingMovies: () => tmdb('/trending/movie/week'),
  trendingTV: () => tmdb('/trending/tv/week'),
  trendingBollywood: () => tmdb('/discover/movie', {
    with_original_language: 'hi', region: 'IN', sort_by: 'popularity.desc',
  }),
  topRatedMovies: () => tmdb('/movie/top_rated'),
  topRatedTV: () => tmdb('/tv/top_rated'),
  topRatedBollywood: () => tmdb('/discover/movie', {
    with_original_language: 'hi', region: 'IN', sort_by: 'vote_average.desc',
    'vote_count.gte': '200',
  }),
  upcomingMovies: () => tmdb('/movie/upcoming'),
  airingTodayTV: () => tmdb('/tv/airing_today'),
  popularBollywoodTV: () => tmdb('/discover/tv', {
    with_original_language: 'hi', sort_by: 'popularity.desc',
  }),
  searchMulti: (q) => tmdb('/search/multi', { query: q }),
  searchMultiPage: (q, page = 1) => tmdb('/search/multi', { query: q, page }),
  movieGenres: () => tmdb('/genre/movie/list'),
  tvGenres: () => tmdb('/genre/tv/list'),
  discoverByGenre: (mediaType, genreId, isBollywood = false) => {
    const params = { with_genres: genreId, sort_by: 'popularity.desc' };
    if (isBollywood) {
      params.with_original_language = 'hi';
      params.region = 'IN';
    }
    return tmdb(`/discover/${mediaType}`, params);
  },
  details: (type, id) => tmdb(`/${type}/${id}`, { append_to_response: 'videos,credits,similar,external_ids' }),
  personCredits: (personId) => tmdb(`/person/${personId}/combined_credits`),
  personDetails: (personId) => tmdb(`/person/${personId}`, { append_to_response: 'combined_credits' }),
  searchPerson: (q) => tmdb('/search/person', { query: q }),
  watchProviders: (type, id) => tmdb(`/${type}/${id}/watch/providers`),
  discoverContent: (type, params) => tmdb(`/discover/${type}`, params),
  smartDiscover: (type, params) => tmdb(`/discover/${type}`, {
    ...params,
    sort_by: 'popularity.desc',
  }),
  
  // ML-based recommendations
  mlRecommend: (type, id) => fetch(`${getMlBase()}/api/recommend?type=${type}&id=${id}&n=8`)
    .then(r => r.json())
    .catch(e => { console.warn('ML recommend failed:', e); return null; }),
  
  mlPersonalized: (type, watchHistory, extraParams = {}) => {
    const params = new URLSearchParams({
      type,
      watch_history: watchHistory.map(w => w.id).join(','),
      n: '12',
    });
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return fetch(`${getMlBase()}/api/recommend-personalized?${params.toString()}`)
      .then(r => r.json())
      .catch(e => { console.warn('ML personalized failed:', e); return null; });
  },
  
  mlMood: (query, type = 'movie') => fetch(`${getMlBase()}/api/mood?query=${encodeURIComponent(query)}&type=${type}&n=12`)
    .then(r => r.json())
    .catch(e => { console.warn('ML mood failed:', e); return null; }),
};

// ═══════════════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════════════
function getMediaType(item) {
  if (item.media_type) return item.media_type;
  if (item.title) return 'movie';
  if (item.name && !item.title) return 'tv';
  return 'movie';
}

function getTitle(item) {
  return item.title || item.name || 'Unknown';
}

function getYear(item) {
  const date = item.release_date || item.first_air_date || '';
  if (!date) return '';
  if (typeof date === 'number') return String(date);
  if (typeof date === 'string') return date.split('-')[0];
  return String(date);
}

function getPoster(item) {
  return item.poster_path ? `${IMG}${item.poster_path}` : null;
}

function getBackdrop(item) {
  return item.backdrop_path ? `${IMG_ORIGINAL}${item.backdrop_path}` : null;
}

function isInWatchlist(id) {
  return watchlist.some((w) => w.id === id);
}

// ── Skeleton cards ────────────────────────────────────────────
function renderSkeletons(container, count = 8) {
  container.innerHTML = Array.from({ length: count }, () => `
    <div class="skeleton">
      <div class="skeleton-poster"></div>
      <div class="skeleton-info">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
      </div>
    </div>
  `).join('');
}

// ── Content card ──────────────────────────────────────────────
function renderCard(item, forceType) {
  const normalized = normalizeMediaItem(item, forceType);
  const type = normalized.media_type;
  const title = normalized.title;
  const year = getYear(normalized);
  const rating = normalized.vote_average.toFixed(1);
  const poster = getPoster(normalized);
  const inWatchlist = isInWatchlist(normalized.id);

  const card = document.createElement('div');
  card.className = 'card';
  card.style.animationDelay = `${Math.random() * 0.3}s`;
  card.innerHTML = `
    <div class="card-poster-wrapper">
      ${poster
        ? `<img class="card-poster" src="${poster}" alt="${title}" loading="lazy" />`
        : `<div class="no-poster">🎬</div>`
      }
      <span class="card-type-badge ${type === 'tv' ? 'tv' : ''}">${type === 'tv' ? 'TV' : 'MOVIE'}</span>
      <button class="card-watchlist-btn ${inWatchlist ? 'in-watchlist' : ''}" data-id="${normalized.id}" title="Toggle Watchlist">
        ${inWatchlist ? '❤️' : '🤍'}
      </button>
      <div class="card-overlay">
        <div class="card-overlay-rating">⭐ ${rating}</div>
      </div>
    </div>
    <div class="card-info">
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span>${year}</span>
        <span class="card-rating">⭐ ${rating}</span>
      </div>
    </div>
  `;

  // Click card → open detail modal
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-watchlist-btn')) return;
    openModal(normalized.id, type);
  });

  // Watchlist toggle on card
  const wlBtn = card.querySelector('.card-watchlist-btn');
  wlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWatchlist(normalized);
    wlBtn.classList.toggle('in-watchlist');
    wlBtn.innerHTML = isInWatchlist(item.id) ? '❤️' : '🤍';
  });

  return card;
}

function renderGrid(container, items, forceType, append = false) {
  if (!append) {
    container.innerHTML = '';
  }
  if ((!items || items.length === 0) && !append) {
    renderStateCard(container, {
      variant: 'empty',
      title: 'No matches found',
      message: 'Try a different search, genre, or set of filters.',
    });
    return;
  }
  if (!items || items.length === 0) return;
  items.forEach((item) => {
    if (item.media_type === 'person') return;
    container.appendChild(renderCard(item, forceType));
  });
}

function filterUpcomingMovieResults(items) {
  if (!Array.isArray(items)) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const recentThreshold = new Date(today);
  recentThreshold.setDate(recentThreshold.getDate() - 120);

  const normalized = items
    .filter((item) => {
      const releaseDate = item?.release_date;
      if (!releaseDate) return false;
      const parsed = new Date(releaseDate);
      return !Number.isNaN(parsed.getTime()) && parsed >= recentThreshold;
    })
    .sort((a, b) => new Date(b.release_date) - new Date(a.release_date));

  const futureItems = normalized.filter((item) => new Date(item.release_date) >= today);
  return futureItems.length > 0 ? futureItems : normalized;
}

// ═══════════════════════════════════════════════════════════════
// MAIN CONTENT LOADING
// ═══════════════════════════════════════════════════════════════
async function loadContent() {
  const tg = dom.trendingGrid;
  const trg = dom.topRatedGrid;
  const ug = dom.upcomingGrid;

  renderSkeletons(tg);
  renderSkeletons(trg);
  renderSkeletons(ug);

  let trending, topRated, upcoming;
  let forceType = null;

  if (currentTab === 'movies') {
    dom.trendingSubtitle.textContent = "This week's most popular movies";
    dom.topRatedSubtitle.textContent = 'The highest rated movies of all time';
    dom.upcomingTitle.textContent = 'COMING SOON';
    dom.upcomingSubtitle.textContent = 'Upcoming movies to keep an eye on';
    dom.upcomingSection.classList.remove('hidden');

    const [tr, top, upc] = await Promise.all([
      api.trendingMovies(),
      api.topRatedMovies(),
      api.upcomingMovies(),
    ]);
    trending = tr; topRated = top; upcoming = upc;
    forceType = 'movie';

  } else if (currentTab === 'tv') {
    dom.trendingSubtitle.textContent = "This week's most popular TV shows";
    dom.topRatedSubtitle.textContent = 'The highest rated TV shows of all time';
    dom.upcomingTitle.textContent = 'AIRING TODAY';
    dom.upcomingSubtitle.textContent = 'Episodes airing today';
    dom.upcomingSection.classList.remove('hidden');

    const [tr, top, upc] = await Promise.all([
      api.trendingTV(),
      api.topRatedTV(),
      api.airingTodayTV(),
    ]);
    trending = tr; topRated = top; upcoming = upc;
    forceType = 'tv';

  } else if (currentTab === 'bollywood') {
    dom.trendingSubtitle.textContent = 'Most popular Indian movies right now';
    dom.topRatedSubtitle.textContent = 'Highest rated Indian movies';
    dom.upcomingTitle.textContent = 'INDIAN TV';
    dom.upcomingSubtitle.textContent = 'Popular Indian TV shows';
    dom.upcomingSection.classList.remove('hidden');

    const [tr, top, upc] = await Promise.all([
      api.trendingBollywood(),
      api.topRatedBollywood(),
      api.popularBollywoodTV(),
    ]);
    trending = tr; topRated = top; upcoming = upc;
    // We handle mixed types implicitly or default to movie unless it's the TV section
  }

  if (trending?.isError) {
    renderStateCard(tg, {
      variant: 'error',
      title: 'Trending titles are unavailable',
      message: 'Please try again in a moment.',
    });
  } else {
    renderGrid(tg, trending?.results, forceType || 'movie');
  }

  if (topRated?.isError) {
    renderStateCard(trg, {
      variant: 'error',
      title: 'Top rated titles are unavailable',
      message: 'Please try again in a moment.',
    });
  } else {
    renderGrid(trg, topRated?.results, forceType || 'movie');
  }

  if (upcoming?.isError) {
    renderStateCard(ug, {
      variant: 'error',
      title: 'Upcoming titles are unavailable',
      message: 'Please try again in a moment.',
    });
  } else {
    const upcomingItems = currentTab === 'movies'
      ? filterUpcomingMovieResults(upcoming?.results)
      : upcoming?.results;
    renderGrid(ug, upcomingItems, currentTab === 'bollywood' ? 'tv' : forceType);
  }
}

// ═══════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════
function setSearchLoadMoreVisibility() {
  if (currentSearchPage < currentSearchTotalPages) {
    dom.searchLoadMore.classList.remove('hidden');
  } else {
    dom.searchLoadMore.classList.add('hidden');
  }
}

async function fetchSearchResults(query, page = 1) {
  if (!query.trim()) return;

  if (page === 1) {
    renderSkeletons(dom.searchGrid, 8);
    dom.searchResultsMeta.textContent = 'Searching across movies and TV shows...';
  }

  const data = await api.searchMultiPage(query, page);
  if (!data || data.isError || !data.results) {
    if (page === 1) {
      renderStateCard(dom.searchGrid, {
        variant: 'error',
        title: 'Search is unavailable right now',
        message: 'CineNext could not reach the movie data service. Try again in a moment.',
      });
      dom.searchResultsMeta.textContent = 'Search temporarily unavailable.';
    }
    dom.searchLoadMore.classList.add('hidden');
    return;
  }

  if (page === 1) {
    dom.searchGrid.innerHTML = '';
  }

  const filteredResults = data.results.filter(item => item.media_type !== 'person');
  if (page === 1 && filteredResults.length === 0) {
    renderStateCard(dom.searchGrid, {
      variant: 'empty',
      title: 'No titles matched that search',
      message: 'Try a broader name, fewer keywords, or switch to Discover for filtering.',
    });
    dom.searchResultsMeta.textContent = `0 results for "${query}"`;
  } else {
    renderGrid(dom.searchGrid, filteredResults, undefined, page > 1);
    const totalLabel = data.total_results ? `${data.total_results.toLocaleString()} results` : `${filteredResults.length}+ results`;
    dom.searchResultsMeta.textContent = `${totalLabel} across movies and TV shows.`;
  }

  currentSearchTotalPages = data.total_pages || 1;
  setSearchLoadMoreVisibility();

  currentSearchQuery = query;
  currentSearchPage = page;
}

function handleSearch(query) {
  clearTimeout(searchTimeout);
  if (!query.trim()) {
    clearSearch({ updateHistory: getCurrentViewName() === 'search' });
    return;
  }
  searchTimeout = setTimeout(async () => {
    const historyMode = getCurrentViewName() === 'search' ? 'replace' : 'push';
    await showSearchView(query, { historyMode });
  }, 400);
}

function clearSearch(options = {}) {
  const { updateHistory = false } = options;
  setPrimaryView('home');
  dom.searchInput.value = '';
  dom.searchGrid.innerHTML = '';
  dom.searchQueryDisplay.textContent = '';
  dom.searchResultsMeta.textContent = 'Search across movies and TV shows.';
  dom.searchLoadMore.classList.add('hidden');

  dom.searchSection.classList.add('hidden');
  dom.heroSection.classList.remove('hidden');
  dom.contentTabs.classList.remove('hidden');
  dom.trendingSection.classList.remove('hidden');
  $('#top-rated-section').classList.remove('hidden');
  dom.upcomingSection.classList.remove('hidden');
  dom.genreSection.classList.remove('hidden');

  currentSearchQuery = '';
  currentSearchPage = 1;
  currentSearchTotalPages = 1;

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

// ═══════════════════════════════════════════════════════════════
// GENRE FILTER
// ═══════════════════════════════════════════════════════════════
async function loadGenres() {
  const [movieData, tvData] = await Promise.all([api.movieGenres(), api.tvGenres()]);
  genres.movie = movieData?.genres || [];
  genres.tv = tvData?.genres || [];
  renderGenreMenu();
  renderDiscoverGenres();
}

function renderGenreMenu() {
  const list = currentTab === 'tv' ? genres.tv : genres.movie;
  dom.genreMenu.innerHTML = `
    <div class="genre-item ${!activeGenreId ? 'active' : ''}" data-id="">All Genres</div>
    ${list.map((g) => `
      <div class="genre-item ${activeGenreId === g.id ? 'active' : ''}" data-id="${g.id}" data-name="${g.name}">
        ${g.name}
      </div>
    `).join('')}
  `;

  dom.genreMenu.querySelectorAll('.genre-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (!id) {
        clearGenreFilter({ updateHistory: true });
      } else {
        activeGenreId = parseInt(id);
        activeGenreName = el.dataset.name;
        filterByGenre(activeGenreId, activeGenreName);
      }
      dom.genreMenu.classList.remove('show');
      renderGenreMenu();
    });
  });
}

async function filterByGenre(genreId, genreName, options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  setPrimaryView('genre');
  dom.genreNameDisplay.textContent = genreName;
  dom.genreSection.classList.remove('hidden');
  dom.searchSection.classList.add('hidden');
  dom.discoverSection.classList.add('hidden');
  dom.recommendedSection.classList.add('hidden');
  dom.heroSection.classList.remove('hidden');
  dom.contentTabs.classList.remove('hidden');
  dom.trendingSection.classList.add('hidden');
  $('#top-rated-section').classList.add('hidden');
  dom.upcomingSection.classList.add('hidden');

  renderSkeletons(dom.genreGrid);
  const mediaType = currentTab === 'tv' ? 'tv' : 'movie';
  const isBollywood = currentTab === 'bollywood';
  const data = await api.discoverByGenre(mediaType, genreId, isBollywood);
  if (data?.isError) {
    renderStateCard(dom.genreGrid, {
      variant: 'error',
      title: 'Genre view is unavailable',
      message: 'CineNext could not load this genre right now. Try again in a moment.',
    });
  } else {
    renderGrid(dom.genreGrid, data?.results, mediaType);
  }

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function clearGenreFilter(options = {}) {
  const { updateHistory = false } = options;
  activeGenreId = null;
  activeGenreName = null;
  setPrimaryView('home');
  dom.genreSection.classList.add('hidden');
  dom.trendingSection.classList.remove('hidden');
  $('#top-rated-section').classList.remove('hidden');
  dom.upcomingSection.classList.remove('hidden');
  renderGenreMenu();

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

// ═══════════════════════════════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════════════════════════════
async function openModal(id, type, options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  currentModalItemId = id;
  currentModalItemType = type;
  dom.modalBackdrop.classList.add('show');
  setOverlayState('modal');

  // Reset
  dom.trailerSection.classList.add('hidden');
  dom.castSection.classList.add('hidden');
  dom.similarSection.classList.add('hidden');
  $('#director-section').classList.add('hidden');
  dom.modalOverview.textContent = 'Loading…';
  dom.modalTitle.textContent = '';
  dom.modalMetaTags.innerHTML = '';
  dom.trailerContainer.innerHTML = '';
  dom.castScroll.innerHTML = '';
  $('#director-scroll').innerHTML = '';
  $('#watch-providers-section').classList.add('hidden');
  $('#watch-providers-content').innerHTML = '';
  $('#seasons-section').classList.add('hidden');
  $('#seasons-content').innerHTML = '';
  dom.similarGrid.innerHTML = '';
  $('#ratings-bar').classList.add('hidden');
  $('#ratings-bar').innerHTML = '';
  // Reset similar section label (may have been changed to filmography)
  const similarLabel = dom.similarSection.querySelector('.section-label');
  if (similarLabel) similarLabel.textContent = '💡 YOU MIGHT ALSO LIKE';

  const data = await api.details(type, id);
  if (!data || data.isError) {
    dom.modalOverview.textContent = 'Failed to load details right now.';
    return;
  }

  const title = data.title || data.name || '';
  const year = (data.release_date || data.first_air_date || '').split('-')[0];
  const rating = (data.vote_average || 0).toFixed(1);
  const runtime = data.runtime ? `${data.runtime}min` : (data.number_of_seasons ? `${data.number_of_seasons} Season${data.number_of_seasons > 1 ? 's' : ''}` : '');
  const genreNames = (data.genres || []).map((g) => g.name);

  // Images
  const backdrop = getBackdrop(data);
  const poster = getPoster(data);
  dom.modalBackdropImg.src = backdrop || poster || '';
  
  document.getElementById('modal')?.classList.remove('dynamic-themed');
  document.documentElement.style.removeProperty('--dynamic-accent');
  document.documentElement.style.removeProperty('--dynamic-accent-rgb');
  dom.modalPoster.crossOrigin = 'anonymous';
  dom.modalPoster.onload = () => extractDominantColor(dom.modalPoster);
  dom.modalPoster.src = poster || '';
  
  dom.modalTitle.textContent = title;
  dom.modalOverview.textContent = data.overview || 'No overview available.';

  // Meta tags
  dom.modalMetaTags.innerHTML = `
    ${year ? `<span class="meta-tag">${year}</span>` : ''}
    ${runtime ? `<span class="meta-tag">${runtime}</span>` : ''}
    <span class="meta-tag">${type === 'tv' ? '📺 TV Show' : '🎬 Movie'}</span>
    ${genreNames.map((g) => `<span class="meta-tag">${g}</span>`).join('')}
  `;

  // Watchlist button in modal
  updateModalWatchlistBtn(data, type);

  // Ratings bar (async — fetches OMDB data)
  const imdbId = data.imdb_id || data.external_ids?.imdb_id;
  loadRatingsBar(rating, imdbId);

  // Watched & Favourite buttons
  updateModalWatchedBtn(data, type);
  updateModalFavouriteBtn(data, type);

  // Review section
  initReviewSection(data.id, type);

  // Trailer
  const videos = data.videos?.results || [];
  const trailer = videos.find((v) => v.type === 'Trailer' && v.site === 'YouTube')
    || videos.find((v) => v.site === 'YouTube');
  if (trailer) {
    dom.trailerSection.classList.remove('hidden');
    dom.trailerContainer.innerHTML = `
      <iframe
        src="https://www.youtube.com/embed/${trailer.key}?rel=0"
        title="${title} Trailer"
        allowfullscreen
        loading="lazy"
      ></iframe>
    `;
  }

  // Cast
  const cast = (data.credits?.cast || []).slice(0, 15);
  if (cast.length) {
    dom.castSection.classList.remove('hidden');
    dom.castScroll.innerHTML = cast.map((c) => `
      <div class="cast-card" data-person-id="${c.id}" data-person-name="${c.name}" style="cursor:pointer;">
        ${c.profile_path
          ? `<img class="cast-img" src="${PROFILE_IMG}${c.profile_path}" alt="${c.name}" loading="lazy" />`
          : `<div class="cast-img" style="display:flex;align-items:center;justify-content:center;background:var(--bg-card);font-size:1.5rem;">👤</div>`
        }
        <div class="cast-name">${c.name}</div>
        <div class="cast-role">${c.character || ''}</div>
      </div>
    `).join('');

    // Make cast cards clickable → show filmography
    dom.castScroll.querySelectorAll('.cast-card').forEach((card) => {
      card.addEventListener('click', () => {
        const personId = card.dataset.personId;
        const personName = card.dataset.personName;
        loadFilmography(personId, personName);
      });
    });
  }

  // Directors
  const directors = (data.credits?.crew || []).filter(c => c.job === 'Director');
  if (directors.length) {
    $('#director-section').classList.remove('hidden');
    $('#director-scroll').innerHTML = directors.map((d) => `
      <div class="cast-card" data-person-id="${d.id}" data-person-name="${d.name}" style="cursor:pointer;">
        ${d.profile_path
          ? `<img class="cast-img" src="${PROFILE_IMG}${d.profile_path}" alt="${d.name}" loading="lazy" />`
          : `<div class="cast-img" style="display:flex;align-items:center;justify-content:center;background:var(--bg-card);font-size:1.5rem;">🎬</div>`
        }
        <div class="cast-name">${d.name}</div>
        <div class="cast-role">Director</div>
      </div>
    `).join('');

    // Make director cards clickable → show filmography
    $('#director-scroll').querySelectorAll('.cast-card').forEach((card) => {
      card.addEventListener('click', () => {
        loadFilmography(card.dataset.personId, card.dataset.personName);
      });
    });
  }

  // Watch Providers (async)
  loadWatchProviders(id, type, title);

  // Seasons (TV shows only)
  if (type === 'tv' && data.seasons && data.seasons.length > 0) {
    $('#seasons-section').classList.remove('hidden');
    const seasons = data.seasons.filter(s => s.season_number > 0); // exclude specials
    $('#seasons-content').innerHTML = `<div class="seasons-grid">${seasons.map(s => {
      const airYear = (s.air_date || '').split('-')[0];
      return `
        <div class="season-card" data-season="${s.season_number}">
          ${s.poster_path
            ? `<img class="season-poster" src="${IMG}${s.poster_path}" alt="${s.name}" loading="lazy" />`
            : `<div class="season-poster-placeholder">📂</div>`
          }
          <div class="season-info">
            <div class="season-name">${s.name || `Season ${s.season_number}`}</div>
            <div class="season-meta">${s.episode_count || 0} Episodes${airYear ? ` • ${airYear}` : ''}</div>
            ${s.overview ? `<div class="season-overview">${s.overview}</div>` : ''}
          </div>
        </div>
      `;
    }).join('')}</div>`;
  }

  // ── Similar / ML Recommendations ─────────────────────────────
  // Try ML server first; fall back to TMDB /similar if not running
  dom.similarSection.classList.remove('hidden');
  const mlSectionTitle = dom.similarSection.querySelector('h3') ||
                         dom.similarSection.querySelector('.section-title') ||
                         dom.similarSection.firstElementChild;

  // Show loading skeletons while fetching
  renderSkeletons(dom.similarGrid, 6);

  const mlRecs = await fetchMlRecommendations(type, id);

  let similarItems;
  let recSource;
  if (mlRecs && mlRecs.length > 0) {
    recSource = 'You might also like';
    similarItems = mlRecs;
  } else {
    recSource = 'You might also like';
    similarItems = (data.similar?.results || []).slice(0, 8).map(s => ({
      id:           s.id,
      title:        s.title || s.name || '',
      poster_url:   getPoster(s),
      vote_average: s.vote_average || 0,
      similarity:   null,
    }));
  }

  if (mlSectionTitle) mlSectionTitle.textContent = recSource;

  if (similarItems.length) {
    dom.similarGrid.innerHTML = similarItems.map((s) => {
      const sPoster = s.poster_url || (s.poster_path ? `${IMG}${s.poster_path}` : '');
      const sTitle  = s.title || '';
      const sRating = (s.vote_average || 0).toFixed(1);
      const scoreHtml = s.similarity != null
        ? `<div class="similar-card-score" title="ML similarity score">🎯 ${(s.similarity * 100).toFixed(0)}%</div>`
        : '';
      return `
        <div class="similar-card" data-id="${s.id}" data-type="${type}">
          ${sPoster
            ? `<img src="${sPoster}" alt="${sTitle}" loading="lazy" />`
            : `<div class="no-poster" style="font-size:2rem;">🎬</div>`
          }
          <div class="similar-card-info">
            <div class="similar-card-title">${sTitle}</div>
            <div class="similar-card-rating">⭐ ${sRating}${scoreHtml}</div>
          </div>
        </div>
      `;
    }).join('');

    dom.similarGrid.querySelectorAll('.similar-card').forEach((card) => {
      card.addEventListener('click', () => {
        openModal(parseInt(card.dataset.id), card.dataset.type);
      });
    });
  } else {
    dom.similarSection.classList.add('hidden');
  }

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

// ── Filmography (person's other movies/shows) ─────────────────
async function loadFilmography(personId, personName) {
  // Show filmography in the similar section area
  dom.similarSection.classList.remove('hidden');
  const label = dom.similarSection.querySelector('.section-label');
  label.textContent = `🎬 MORE FROM ${personName.toUpperCase()}`;
  dom.similarGrid.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const data = await api.personCredits(personId);
  if (!data) {
    dom.similarGrid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Could not load filmography.</p>';
    return;
  }

  // Only use cast (acting) credits, deduplicate, sort by popularity, take top 12
  const allCredits = data.cast || [];
  const seen = new Set();
  const unique = allCredits.filter((item) => {
    if (item.media_type === 'person') return false;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 12);

  if (unique.length === 0) {
    dom.similarGrid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No other titles found.</p>';
    return;
  }

  dom.similarGrid.innerHTML = unique.map((s) => {
    const sPoster = getPoster(s);
    const sTitle = s.title || s.name || '';
    const sRating = (s.vote_average || 0).toFixed(1);
    const sType = s.media_type || (s.title ? 'movie' : 'tv');
    const sChar = s.character ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">as ${s.character}</div>` : '';
    return `
      <div class="similar-card" data-id="${s.id}" data-type="${sType}">
        ${sPoster
          ? `<img src="${sPoster}" alt="${sTitle}" loading="lazy" />`
          : `<div class="no-poster" style="font-size:2rem;">🎬</div>`
        }
        <div class="similar-card-info">
          <div class="similar-card-title">${sTitle}</div>
          <div class="similar-card-rating">⭐ ${sRating}</div>
          ${sChar}
        </div>
      </div>
    `;
  }).join('');

  dom.similarGrid.querySelectorAll('.similar-card').forEach((card) => {
    card.addEventListener('click', () => {
      openModal(parseInt(card.dataset.id), card.dataset.type);
    });
  });

  // Scroll to filmography
  dom.similarSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateModalWatchlistBtn(data, type) {
  const inWl = isInWatchlist(data.id);
  dom.modalWatchlistBtn.innerHTML = inWl ? '❤️ In Watchlist' : '📋 Add to Watchlist';
  dom.modalWatchlistBtn.classList.toggle('in-watchlist', inWl);

  // Remove old listener
  const newBtn = dom.modalWatchlistBtn.cloneNode(true);
  dom.modalWatchlistBtn.parentNode.replaceChild(newBtn, dom.modalWatchlistBtn);
  dom.modalWatchlistBtn = newBtn;

  newBtn.addEventListener('click', () => {
    toggleWatchlist({
      id: data.id,
      title: data.title || data.name,
      poster_path: data.poster_path,
      vote_average: data.vote_average,
      media_type: type,
      release_date: data.release_date || data.first_air_date,
    });
    updateModalWatchlistBtn(data, type);
    refreshAllWatchlistButtons();
  });
}

// ═══════════════════════════════════════════════════════════════
// WATCHED & FAVOURITE (Supabase DB)
// ═══════════════════════════════════════════════════════════════
function getWatchedList() {
  return watchedList;
}

function getFavouritesList() {
  return favouritesList;
}

function isWatched(id) {
  return watchedList.some(w => w.id === id);
}

function isFavourite(id) {
  return favouritesList.some(f => f.id === id);
}

async function toggleWatched(item) {
  if (!currentUser) return;
  const uid = currentUser.id;
  const idx = watchedList.findIndex(w => w.id === item.id);
  if (idx >= 0) {
    watchedList.splice(idx, 1);
    await supabaseClient.from('watched').delete()
      .eq('user_id', uid).eq('tmdb_id', item.id);
  } else {
    watchedList.push({ id: item.id, title: item.title, poster_path: item.poster_path, media_type: item.media_type });
    await supabaseClient.from('watched').insert({
      user_id: uid, tmdb_id: item.id, media_type: item.media_type || 'movie',
      title: item.title, poster_path: item.poster_path,
    });
  }
}

async function toggleFavourite(item) {
  if (!currentUser) return;
  const uid = currentUser.id;
  const idx = favouritesList.findIndex(f => f.id === item.id);
  if (idx >= 0) {
    favouritesList.splice(idx, 1);
    await supabaseClient.from('favourites').delete()
      .eq('user_id', uid).eq('tmdb_id', item.id);
  } else {
    favouritesList.push({ id: item.id, title: item.title, poster_path: item.poster_path, vote_average: item.vote_average, media_type: item.media_type });
    await supabaseClient.from('favourites').insert({
      user_id: uid, tmdb_id: item.id, media_type: item.media_type || 'movie',
      title: item.title, poster_path: item.poster_path, vote_average: item.vote_average || 0,
    });
  }
}

function updateModalWatchedBtn(data, type) {
  const watchedBtn = $('#modal-watched-btn');
  const watched = isWatched(data.id);
  watchedBtn.innerHTML = watched ? '✅ Watched' : '👁️ Watched';
  watchedBtn.classList.toggle('is-watched', watched);

  const newBtn = watchedBtn.cloneNode(true);
  watchedBtn.parentNode.replaceChild(newBtn, watchedBtn);

  newBtn.addEventListener('click', () => {
    toggleWatched({
      id: data.id,
      title: data.title || data.name,
      media_type: type,
    });
    updateModalWatchedBtn(data, type);
  });
}

function updateModalFavouriteBtn(data, type) {
  const favBtn = $('#modal-favourite-btn');
  const fav = isFavourite(data.id);
  favBtn.innerHTML = fav ? '❤️ Favourite' : '🤍 Favourite';
  favBtn.classList.toggle('is-favourite', fav);

  const newBtn = favBtn.cloneNode(true);
  favBtn.parentNode.replaceChild(newBtn, favBtn);

  newBtn.addEventListener('click', () => {
    toggleFavourite({
      id: data.id,
      title: data.title || data.name,
      poster_path: data.poster_path,
      vote_average: data.vote_average,
      media_type: type,
    });
    updateModalFavouriteBtn(data, type);
  });
}

// ═══════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════
let currentReviewRating = 0;
let currentModalItemId = null;
let currentModalItemType = null;

let currentSearchQuery = '';
let currentSearchPage = 1;
let currentSearchTotalPages = 1;
let isApplyingHistoryState = false;
let currentHistoryKey = '';


async function getReviews(itemId) {
  const { data } = await supabaseClient
    .from('reviews')
    .select('*')
    .eq('tmdb_id', itemId)
    .order('created_at', { ascending: false });
  return data || [];
}

async function saveReview(itemId, review) {
  const basePayload = {
    user_id: currentUser?.id || null,
    user_name: review.userName,
    tmdb_id: itemId,
    media_type: review.mediaType || 'movie',
    rating: review.rating,
    review_text: review.text,
  };

  const payloadWithEmail = {
    ...basePayload,
    ...(review.userEmail ? { user_email: review.userEmail } : {}),
  };

  let response = await supabaseClient.from('reviews').insert(payloadWithEmail);

  if (response.error) {
    console.warn('saveReview retry: inserting without user_email due to', response.error.message);
    // fallback when reviews table does not contain user_email
    const fallbackResponse = await supabaseClient.from('reviews').insert(basePayload);
    if (fallbackResponse.error) {
      console.error('saveReview failed:', fallbackResponse.error);
      throw fallbackResponse.error;
    }
    return;
  }

  return;
}

async function deleteReview(reviewId) {
  await supabaseClient.from('reviews').delete().eq('id', reviewId);
}

async function initReviewSection(itemId, itemType) {
  currentModalItemId = itemId;
  currentModalItemType = itemType;
  currentReviewRating = 0;

  // Reset form
  const textarea = $('#review-textarea');
  const submitBtn = $('#review-submit');
  textarea.value = '';
  submitBtn.disabled = true;
  updateStarPicker(0);

  // Star picker
  const stars = $$('#review-star-picker .review-star');
  stars.forEach(star => {
    const clone = star.cloneNode(true);
    star.parentNode.replaceChild(clone, star);
    clone.addEventListener('click', () => {
      currentReviewRating = parseInt(clone.dataset.star);
      updateStarPicker(currentReviewRating);
      checkReviewSubmittable();
    });
  });

  // Textarea listener
  const newTextarea = textarea.cloneNode(true);
  textarea.parentNode.replaceChild(newTextarea, textarea);
  newTextarea.addEventListener('input', checkReviewSubmittable);

  // Submit button
  const newSubmit = submitBtn.cloneNode(true);
  submitBtn.parentNode.replaceChild(newSubmit, submitBtn);
  newSubmit.addEventListener('click', async () => {
    const text = escapeHTML($('#review-textarea').value.trim()); // sanitization
    if (!text || currentReviewRating === 0 || !currentUser) return;

    newSubmit.disabled = true;
    newSubmit.textContent = 'Posting...';

    const review = {
      rating: currentReviewRating,
      text,
      userName: getUserDisplayName(),
      userEmail: currentUser.email || '',
      mediaType: currentModalItemType
    };

    try {
      await saveReview(currentModalItemId, review);
      $('#review-textarea').value = '';
      currentReviewRating = 0;
      updateStarPicker(0);
      newSubmit.textContent = 'Post Review';
      await renderReviewsList(currentModalItemId);
    } catch (err) {
      // If Supabase insert fails (auth/RLS/schema), show a clear message instead of silently doing nothing.
      const msg = (err && err.message) ? err.message : String(err);
      console.error('Review submit failed:', err);
      newSubmit.textContent = 'Post Review';
      newSubmit.disabled = false;
      $('#reviews-list').innerHTML = `<div class="review-error">Failed to post review: ${escapeHTML(msg)}</div>`;
    }
  });

  await renderReviewsList(itemId);
}

function checkReviewSubmittable() {
  const text = $('#review-textarea').value.trim();
  $('#review-submit').disabled = !(text && currentReviewRating > 0 && currentUser);
}

function updateStarPicker(rating) {
  $$('#review-star-picker .review-star').forEach(star => {
    const val = parseInt(star.dataset.star);
    star.classList.toggle('active', val <= rating);
  });
}

async function renderReviewsList(itemId) {
  const container = $('#reviews-list');
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  
  const reviews = await getReviews(itemId);

  if (reviews.length === 0) {
    container.innerHTML = '<div class="no-reviews">No reviews yet. Be the first to share your thoughts!</div>';
    return;
  }

  container.innerHTML = reviews.map(r => {
    const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const stars = '⭐'.repeat(r.rating);
    const initials = getInitials(r.user_name);
    const isOwn = currentUser && r.user_id === currentUser.id;

    return `
      <div class="review-item">
        <div class="review-item-header">
          <div class="review-item-user">
            <div class="review-item-avatar">${initials}</div>
            <span class="review-item-name">${escapeHTML(r.user_name)}</span>
          </div>
          <div class="review-item-meta">
            <span class="review-item-date">${date}</span>
            ${isOwn ? `<button class="review-item-delete" data-review-id="${r.id}" title="Delete review">🗑️</button>` : ''}
          </div>
        </div>
        <div class="review-item-stars">${stars}</div>
        <div class="review-item-text">${r.review_text}</div>
      </div>
    `;
  }).join('');

  // Delete buttons
  container.querySelectorAll('.review-item-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const id = parseInt(btn.dataset.reviewId);
      await deleteReview(id);
      await renderReviewsList(itemId);
    });
  });
}

// ── Multi-source ratings bar ──────────────────────────────────
// ── Watch Providers ───────────────────────────────────────────
const PROVIDER_URLS = {
  8:   (t) => `https://www.netflix.com/search?q=${t}`,
  9:   (t) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${t}`,
  119: (t) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${t}`,
  337: (t) => `https://www.disneyplus.com/search/${t}`,
  2:   (t) => `https://tv.apple.com/search?term=${t}`,
  350: (t) => `https://tv.apple.com/search?term=${t}`,
  3:   (t) => `https://play.google.com/store/search?q=${t}&c=movies`,
  192: (t) => `https://www.youtube.com/results?search_query=${t}`,
  122: (t) => `https://www.hotstar.com/in/search/phrase/${t}`,
  220: (t) => `https://www.jiocinema.com/search/${t}`,
  237: (t) => `https://www.sonyliv.com/search?searchTerm=${t}`,
  232: (t) => `https://www.zee5.com/search?q=${t}`,
  531: (t) => `https://www.paramountplus.com/search/?q=${t}`,
  384: (t) => `https://www.max.com/search?q=${t}`,
  387: (t) => `https://www.peacocktv.com/search?q=${t}`,
  15:  (t) => `https://www.hulu.com/search?q=${t}`,
  283: (t) => `https://www.crunchyroll.com/search?q=${t}`,
  1899:(t) => `https://www.max.com/search?q=${t}`,
};

function getProviderUrl(providerId, title) {
  const encoded = encodeURIComponent(title);
  if (PROVIDER_URLS[providerId]) return PROVIDER_URLS[providerId](encoded);
  return `https://www.google.com/search?q=watch+${encoded}+online`;
}

async function loadWatchProviders(id, type, title) {
  const section = $('#watch-providers-section');
  const content = $('#watch-providers-content');

  const data = await api.watchProviders(type, id);
  if (!data || !data.results) return;

  const countryData = data.results.IN || data.results.US || Object.values(data.results)[0];
  if (!countryData) return;

  let html = '';
  const tmdbLink = countryData.link || '';

  const renderGroup = (providers, label) => {
    if (!providers || providers.length === 0) return '';
    return `
      <div class="watch-providers-group">
        <div class="watch-providers-group-label">${label}</div>
        <div class="watch-providers-list">
          ${providers.map(p => {
            const url = getProviderUrl(p.provider_id, title);
            return `
              <a class="watch-provider" href="${url}" target="_blank" rel="noopener" title="Watch on ${p.provider_name}">
                <img class="watch-provider-logo" src="https://image.tmdb.org/t/p/w92${p.logo_path}" alt="${p.provider_name}" />
                <span class="watch-provider-name">${p.provider_name}</span>
              </a>
            `;
          }).join('')}
        </div>
      </div>
    `;
  };

  html += renderGroup(countryData.flatrate, '🎬 Stream');
  html += renderGroup(countryData.rent, '💰 Rent');
  html += renderGroup(countryData.buy, '🛒 Buy');
  html += renderGroup(countryData.free, '🆓 Free');

  if (!html) return;

  if (tmdbLink) {
    html += `<a class="watch-provider-link" href="${tmdbLink}" target="_blank" rel="noopener">VIEW ALL OPTIONS ↗</a>`;
  }

  content.innerHTML = html;
  section.classList.remove('hidden');
}

async function loadRatingsBar(tmdbRating, imdbId) {
  const bar = $('#ratings-bar');

  // Always show TMDB rating immediately
  let html = `
    <div class="rating-source">
      <div class="rating-source-logo tmdb">TMDB</div>
      <div class="rating-source-info">
        <div class="rating-source-value">${tmdbRating}/10</div>
        <div class="rating-source-name">TMDB</div>
      </div>
    </div>
  `;

  bar.innerHTML = html;
  bar.classList.remove('hidden');

  // Fetch OMDB for IMDB / Rotten Tomatoes / Metacritic
  if (imdbId) {
    try {
      const omdb = await omdbByImdbId(imdbId);

      if (omdb && omdb.Response !== 'False') {
        // IMDB
        if (omdb.imdbRating && omdb.imdbRating !== 'N/A') {
          html += `
            <div class="rating-source">
              <div class="rating-source-logo imdb">IMDb</div>
              <div class="rating-source-info">
                <div class="rating-source-value">${omdb.imdbRating}/10</div>
                <div class="rating-source-name">IMDb</div>
              </div>
            </div>
          `;
        }

        // Rotten Tomatoes
        const rt = (omdb.Ratings || []).find(r => r.Source === 'Rotten Tomatoes');
        if (rt) {
          const rtPercent = parseInt(rt.Value);
          const rtIcon = rtPercent >= 60 ? '🍅' : '🤢';
          html += `
            <div class="rating-source">
              <div class="rating-source-logo rt">${rtIcon}</div>
              <div class="rating-source-info">
                <div class="rating-source-value">${rt.Value}</div>
                <div class="rating-source-name">Rotten Tomatoes</div>
              </div>
            </div>
          `;
        }

        // Metacritic
        if (omdb.Metascore && omdb.Metascore !== 'N/A') {
          const mc = parseInt(omdb.Metascore);
          const mcColor = mc >= 61 ? '#6c3' : mc >= 40 ? '#fc3' : '#f00';
          html += `
            <div class="rating-source">
              <div class="rating-source-logo metacritic" style="background:${mcColor};color:#fff;">${mc}</div>
              <div class="rating-source-info">
                <div class="rating-source-value">${omdb.Metascore}/100</div>
                <div class="rating-source-name">Metacritic</div>
              </div>
            </div>
          `;
        }

        bar.innerHTML = html;
      }
    } catch (err) {
      console.log('OMDB fetch skipped:', err.message);
    }
  }
}

function closeModal(options = {}) {
  const { updateHistory = true } = options;
  dom.modalBackdrop.classList.remove('show');
  setOverlayState(null);
  // Stop any playing trailer
  dom.trailerContainer.innerHTML = '';
  currentModalItemId = null;
  currentModalItemType = null;

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

// ═══════════════════════════════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════════════════════════════
function toggleWatchlist(item) {
  if (!currentUser) {
    showAuthScreen();
    return;
  }
  const normalized = normalizeMediaItem(item, item.media_type);
  const uid = currentUser.id;
  const idx = watchlist.findIndex((w) => w.id === normalized.id);
  if (idx >= 0) {
    watchlist.splice(idx, 1);
    supabaseClient.from('watchlist').delete()
      .eq('user_id', uid).eq('tmdb_id', normalized.id).then();
    showToast('Removed from watchlist', normalized.title, 'info');
    trackEvent('watchlist_remove', { id: normalized.id, type: normalized.media_type });
  } else {
    watchlist.push({ id: normalized.id, title: normalized.title, poster_path: normalized.poster_path, vote_average: normalized.vote_average, media_type: normalized.media_type, release_date: normalized.release_date });
    supabaseClient.from('watchlist').insert({
      user_id: uid, tmdb_id: normalized.id, media_type: normalized.media_type || 'movie',
      title: normalized.title, poster_path: normalized.poster_path, vote_average: normalized.vote_average || 0,
      release_date: normalized.release_date || null
    }).then();
    showToast('Saved to watchlist', normalized.title, 'success');
    trackEvent('watchlist_add', { id: normalized.id, type: normalized.media_type });
  }
  updateWatchlistCount();
  if (dom.watchlistDrawer.classList.contains('open')) {
    renderWatchlistDrawer();
  }
  clearPersonalizedCache(); // Refresh recommendations after watchlist changes
}

function updateWatchlistCount() {
  dom.watchlistCount.textContent = watchlist.length;
}

function refreshAllWatchlistButtons() {
  $$('.card-watchlist-btn').forEach((btn) => {
    const id = parseInt(btn.dataset.id);
    const inWl = watchlist.some(w => w.id === id);
    btn.classList.toggle('in-watchlist', inWl);
    btn.innerHTML = inWl ? '❤️' : '🤍';
  });
}

function openWatchlistDrawer(options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  dom.watchlistDrawer.classList.add('open');
  dom.drawerOverlay.classList.add('show');
  setOverlayState('watchlist');
  renderWatchlistDrawer();

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function closeWatchlistDrawer(options = {}) {
  const { updateHistory = true } = options;
  dom.watchlistDrawer.classList.remove('open');
  dom.drawerOverlay.classList.remove('show');
  setOverlayState(null);

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

function closeSmartMatchOverlay(options = {}) {
  const { updateHistory = true } = options;
  dom.conciergeOverlay?.classList.add('hidden');
  setOverlayState(null);

  if (updateHistory) {
    syncHistoryState('replace');
  }
}

function getCurrentViewName() {
  return appViewState.view;
}

function getCurrentOverlayName() {
  return appViewState.overlay;
}

function cloneDiscoverState() {
  return {
    type: discoverState.type,
    sort: discoverState.sort,
    yearFrom: discoverState.yearFrom,
    yearTo: discoverState.yearTo,
    rating: discoverState.rating,
    genres: [...discoverState.genres],
    page: 1,
  };
}

function buildHistoryState() {
  return {
    version: 1,
    view: getCurrentViewName(),
    currentTab,
    searchQuery: currentSearchQuery || dom.searchInput.value.trim(),
    genreId: activeGenreId,
    genreName: activeGenreName,
    discoverState: cloneDiscoverState(),
    overlay: getCurrentOverlayName(),
    modalId: currentModalItemId,
    modalType: currentModalItemType,
  };
}

function serializeHistoryState(state) {
  return JSON.stringify(state);
}

function syncHistoryState(mode = 'push') {
  if (isApplyingHistoryState) return;

  const appState = buildHistoryState();
  const nextKey = serializeHistoryState(appState);
  const currentState = history.state?.cinenextState;

  if (mode === 'push' && currentHistoryKey && currentHistoryKey !== nextKey) {
    history.pushState({ cinenextState: appState }, '', location.href);
  } else {
    history.replaceState({ cinenextState: appState }, '', location.href);
  }

  currentHistoryKey = nextKey;
  if (!currentState) {
    currentHistoryKey = nextKey;
  }
}

async function showSearchView(query, options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  if (!query.trim()) {
    clearSearch({ updateHistory });
    return;
  }

  setPrimaryView('search');
  dom.heroSection.classList.add('hidden');
  dom.contentTabs.classList.add('hidden');
  dom.searchQueryDisplay.textContent = query;
  dom.searchSection.classList.remove('hidden');
  dom.recommendedSection.classList.add('hidden');
  dom.trendingSection.classList.add('hidden');
  $('#top-rated-section').classList.add('hidden');
  dom.upcomingSection.classList.add('hidden');
  dom.genreSection.classList.add('hidden');
  dom.discoverSection.classList.add('hidden');
  setDesktopDiscoverActive(false);

  await fetchSearchResults(query, 1);
  trackEvent('search_submit', { query });

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function applyDiscoverFilterUI() {
  dom.discoverSort.value = discoverState.sort;
  dom.discoverYearFrom.value = discoverState.yearFrom;
  dom.discoverYearTo.value = discoverState.yearTo;
  dom.discoverRating.value = discoverState.rating;
  dom.discoverRatingVal.textContent = String(discoverState.rating);
  dom.discoverTypeToggles.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === discoverState.type);
  });
}

async function applyHistoryState(state) {
  isApplyingHistoryState = true;

  try {
    const nextState = state || {
      version: 1,
      view: 'home',
      currentTab: 'movies',
      searchQuery: '',
      genreId: null,
      genreName: null,
      discoverState: cloneDiscoverState(),
      overlay: null,
      modalId: null,
      modalType: null,
    };

    closeModal({ updateHistory: false });
    closeWatchlistDrawer({ updateHistory: false });
    closeSmartMatchOverlay({ updateHistory: false });
    closeProfileModal({ updateHistory: false });

    currentTab = nextState.currentTab || 'movies';
    updateContentTabUI();

    if (nextState.view === 'discover') {
      discoverState = {
        ...discoverState,
        ...(nextState.discoverState || {}),
        genres: [...(nextState.discoverState?.genres || [])],
      };
      applyDiscoverFilterUI();
      showDiscoverSection({ updateHistory: false });
      renderDiscoverGenres();
      await handleDiscoverSearch(true);
    } else if (nextState.view === 'search' && nextState.searchQuery) {
      dom.searchInput.value = nextState.searchQuery;
      await showSearchView(nextState.searchQuery, { updateHistory: false });
    } else if (nextState.view === 'genre' && nextState.genreId) {
      dom.searchInput.value = '';
      await filterByGenre(nextState.genreId, nextState.genreName, { updateHistory: false });
    } else {
      dom.searchInput.value = '';
      goHomeView({ updateHistory: false, currentTab });
    }

    if (nextState.overlay === 'watchlist') {
      openWatchlistDrawer({ updateHistory: false });
    } else if (nextState.overlay === 'smart-match') {
      dom.conciergeOverlay?.classList.remove('hidden');
      setOverlayState('smart-match');
    } else if (nextState.overlay === 'profile') {
      await openProfileModal({ updateHistory: false });
    } else if (nextState.overlay === 'modal' && nextState.modalId && nextState.modalType) {
      await openModal(nextState.modalId, nextState.modalType, { updateHistory: false });
    }

    currentHistoryKey = serializeHistoryState(nextState);
  } finally {
    isApplyingHistoryState = false;
  }
}

function updateContentTabUI() {
  dom.contentTabs.querySelectorAll('.content-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === currentTab);
  });
}

function setDesktopDiscoverActive(isActive) {
  dom.discoverBtn?.classList.toggle('active', isActive);
}

function goHomeView(options = {}) {
  const { updateHistory = true, historyMode = 'push', currentTab: nextTab = 'movies' } = options;
  setPrimaryView('home');
  closeWatchlistDrawer({ updateHistory: false });
  closeSmartMatchOverlay({ updateHistory: false });
  clearSearch({ updateHistory: false });
  clearGenreFilter({ updateHistory: false });
  dom.discoverSection.classList.add('hidden');
  dom.heroSection.classList.remove('hidden');
  dom.contentTabs.classList.remove('hidden');
  dom.trendingSection.classList.remove('hidden');
  dom.upcomingSection.classList.remove('hidden');
  dom.topRatedSection.classList.remove('hidden');
  dom.genreSection.classList.add('hidden');
  if (currentUser) {
    dom.recommendedSection.classList.remove('hidden');
  }
  currentTab = nextTab;
  updateContentTabUI();
  updateMobileNavActive(dom.mobileHome);
  setDesktopDiscoverActive(false);
  loadContent();
  loadPersonalizedRecommendations();

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function renderWatchlistDrawer() {
  if (watchlist.length === 0) {
    dom.drawerEmpty.classList.remove('hidden');
    // Clear everything except the empty state
    const items = dom.drawerBody.querySelectorAll('.watchlist-item');
    items.forEach((i) => i.remove());
    return;
  }

  dom.drawerEmpty.classList.add('hidden');

  // Clear old items
  const oldItems = dom.drawerBody.querySelectorAll('.watchlist-item');
  oldItems.forEach((i) => i.remove());

  watchlist.forEach((item) => {
    const poster = item.poster_path ? `${IMG}${item.poster_path}` : '';
    const year = (item.release_date || '').split('-')[0];
    const rating = (item.vote_average || 0).toFixed(1);
    const type = item.media_type === 'tv' ? '📺 TV' : '🎬 Movie';

    const el = document.createElement('div');
    el.className = 'watchlist-item';
    el.innerHTML = `
      ${poster
        ? `<img src="${poster}" alt="${item.title}" />`
        : `<div style="width:56px;height:84px;background:var(--bg-card);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">🎬</div>`
      }
      <div class="watchlist-item-info">
        <div class="watchlist-item-title">${item.title}</div>
        <div class="watchlist-item-meta">${type} · ${year} · ⭐ ${rating}</div>
      </div>
      <button class="watchlist-item-remove" title="Remove">✕</button>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.watchlist-item-remove')) return;
      closeWatchlistDrawer();
      openModal(item.id, item.media_type);
    });

    el.querySelector('.watchlist-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(item);
      renderWatchlistDrawer();
      refreshAllWatchlistButtons();
    });

    dom.drawerBody.appendChild(el);
  });
}

// ═══════════════════════════════════════════════════════════════
// PARTICLES (hero decoration)
// ═══════════════════════════════════════════════════════════════
function createParticles() {
  for (let i = 0; i < 25; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${6 + Math.random() * 10}s`;
    p.style.animationDelay = `${Math.random() * 8}s`;
    p.style.width = `${2 + Math.random() * 4}px`;
    p.style.height = p.style.width;
    dom.particles.appendChild(p);
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART MATCH (AI-POWERED NLP PARSER)
// ═══════════════════════════════════════════════════════════════

const SMART_GENRES = {
  // Action & Adventure
  'action': 28, 'adventure': 12, 'superhero': 28, 'fighting': 28,
  // Comedy
  'comedy': 35, 'funny': 35, 'laugh': 35, 'hilarious': 35, 'sitcom': 35,
  // Horror & Thriller
  'horror': 27, 'scary': 27, 'spooky': 27, 'creepy': 27, 
  'thriller': 53, 'suspense': 53, 'mystery': 9648,
  // Sci-Fi & Fantasy
  'sci-fi': 878, 'scifi': 878, 'science fiction': 878, 'space': 878, 'aliens': 878,
  'fantasy': 14, 'magic': 14,
  // Drama & Romance
  'drama': 18, 'serious': 18, 'emotional': 18,
  'romance': 10749, 'romantic': 10749, 'love': 10749,
  // Animation & Family
  'animation': 16, 'animated': 16, 'cartoon': 16, 'anime': 16,
  'family': 10751, 'kids': 10751, 'children': 10751,
  // Crime
  'crime': 80, 'detective': 80, 'heist': 80, 'murder': 80,
  // Documentary
  'documentary': 99, 'real': 99, 'history': 36
};

const DECADES = {
  '80s': ['1980-01-01', '1989-12-31'],
  '1980s': ['1980-01-01', '1989-12-31'],
  '90s': ['1990-01-01', '1999-12-31'],
  '1990s': ['1990-01-01', '1999-12-31'],
  '00s': ['2000-01-01', '2009-12-31'],
  '2000s': ['2000-01-01', '2009-12-31'],
  '10s': ['2010-01-01', '2019-12-31'],
  '2010s': ['2010-01-01', '2019-12-31'],
  '20s': ['2020-01-01', '2029-12-31'],
  '2020s': ['2020-01-01', '2029-12-31']
};

const REGIONS = {
  'indian': { lang: 'hi', region: 'IN', country: 'IN' },
  'india': { lang: 'hi', region: 'IN', country: 'IN' },
  'bollywood': { lang: 'hi', region: 'IN', country: 'IN' },
  'hindi': { lang: 'hi', region: 'IN' },
  'korean': { lang: 'ko', region: 'KR' },
  'k-drama': { lang: 'ko', region: 'KR', forceType: 'tv' },
  'kdrama': { lang: 'ko', region: 'KR', forceType: 'tv' },
  'japanese': { lang: 'ja', region: 'JP' },
  'anime': { lang: 'ja', region: 'JP' },
  'french': { lang: 'fr', region: 'FR' },
  'spanish': { lang: 'es', region: 'ES' }
};

function parseSmartQuery(query) {
  const q = query.toLowerCase();
  const params = {
    sort_by: 'popularity.desc'
  };
  const tags = [];
  
  // 1. Determine Type
  let type = 'movie'; // default
  if (q.includes('tv') || q.includes('show') || q.includes('series') || q.includes('sitcom')) {
    type = 'tv';
    tags.push('TV Shows');
  } else if (q.includes('movie') || q.includes('film')) {
    type = 'movie';
    tags.push('Movies');
  }

  // 2. Extract Genres
  const foundGenres = new Set();
  Object.keys(SMART_GENRES).forEach(key => {
    if (q.includes(key) || q.includes(key.replace('-', ''))) {
      foundGenres.add(SMART_GENRES[key]);
      tags.push(key.charAt(0).toUpperCase() + key.slice(1));
    }
  });

  if (foundGenres.size > 0) {
    params.with_genres = Array.from(foundGenres).join(',');
  }

  // 3. Extract Decades
  Object.keys(DECADES).forEach(key => {
    // To match distinct words like '90s' not inside other words
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(q)) {
      if (type === 'movie') {
        params['primary_release_date.gte'] = DECADES[key][0];
        params['primary_release_date.lte'] = DECADES[key][1];
      } else {
        params['first_air_date.gte'] = DECADES[key][0];
        params['first_air_date.lte'] = DECADES[key][1];
      }
      tags.push(key);
    }
  });

  // 4. Extract Regions/Languages
  Object.keys(REGIONS).forEach(key => {
    // Check for suffix like 'indian' or 'indians' or 'india'
    if (q.includes(key) || q.includes(key + 's')) {
      const r = REGIONS[key];
      params['with_original_language'] = r.lang;
      if (r.region) params['region'] = r.region;
      if (r.country) params['with_origin_country'] = r.country;
      if (r.forceType) type = r.forceType;
      
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      if (!tags.includes(label)) tags.push(label);
    }
  });

  // Unique tags
  return { type, params, tags: [...new Set(tags)] };
}

async function handleSmartMatchSubmit() {
  const query = dom.smartMatchInput.value.trim();
  if (!query) return;
  trackEvent('smart_match_submit', { query });

  // Hide Smart Match keyword chips (e.g. "Romantic", "90s", "Bollywood") by default.
  // We still keep the parsing logic for discover API params, but we don't render tags.
  // dom.smartMatchTags.innerHTML = '';
  dom.smartMatchEmpty.innerHTML = '<div class="spinner"></div>';
  dom.smartMatchEmpty.classList.remove('hidden');
  renderSkeletons(dom.smartMatchResults, 6);

  const { type, params, tags } = parseSmartQuery(query);

  // Intentionally not rendering `tags` to avoid showing keyword chips.

  // Fetch Discover API
  let data = await api.smartDiscover(type, params);
  
  // Fallback 1: Loosen decades restrictive dates if 0 results
  if (data && data.results && data.results.length === 0) {
    if (params['primary_release_date.gte'] || params['first_air_date.gte']) {
      delete params['primary_release_date.gte'];
      delete params['primary_release_date.lte'];
      delete params['first_air_date.gte'];
      delete params['first_air_date.lte'];
      data = await api.smartDiscover(type, params);
    }
  }

  // Fallback 2: Execute direct string search
  if ((data && data.isError) || (data && data.results && data.results.length === 0)) {
    // try to strip out words that were matched as genres/types so we can search the context
    let strippedQuery = query.toLowerCase();
    ['movie', 'film', 'tv', 'show', 'series'].forEach(w => strippedQuery = strippedQuery.replace(new RegExp(`\\b${w}s?\\b`, 'gi'), ''));
    Object.keys(SMART_GENRES).forEach(w => strippedQuery = strippedQuery.replace(new RegExp(`\\b${w}\\b`, 'gi'), ''));
    strippedQuery = strippedQuery.trim();
    
    // If there are words left, search them (e.g., "spooky horror movies" -> "")
    if (strippedQuery.length > 2) {
      data = await api.searchMulti(strippedQuery);
    }
  }

  if (data && data.results && data.results.length > 0) {
    dom.smartMatchResults.innerHTML = '';
    dom.smartMatchEmpty.classList.add('hidden');
    const filteredResults = data.results.filter(item => item.media_type !== 'person').slice(0, 12);
    renderGrid(dom.smartMatchResults, filteredResults, type);
  } else {
    dom.smartMatchResults.innerHTML = '';
    dom.smartMatchEmpty.classList.remove('hidden');
    dom.smartMatchEmpty.innerHTML = data && data.isError
      ? '<p>Smart Match is temporarily unavailable. Please try again in a moment.</p>'
      : '<p>No matches yet. Try a broader vibe like "tense crime series" or "feel-good adventure movies".</p>';
  }
}


// ═══════════════════════════════════════════════════════════════
// DISCOVER PAGE LOGIC
// ═══════════════════════════════════════════════════════════════

function showDiscoverSection(options = {}) {
  const { updateHistory = true, historyMode = 'push' } = options;
  closeWatchlistDrawer({ updateHistory: false });
  closeSmartMatchOverlay({ updateHistory: false });
  setPrimaryView('discover');

  // Hide all sections, then show discover
  dom.heroSection.classList.add('hidden');
  dom.contentTabs.classList.add('hidden');
  dom.trendingSection.classList.add('hidden');
  dom.upcomingSection.classList.add('hidden');
  dom.topRatedSection.classList.add('hidden');
  dom.searchSection.classList.add('hidden');
  dom.genreSection.classList.add('hidden');
  dom.recommendedSection.classList.add('hidden');
  dom.discoverSection.classList.remove('hidden');
  
  // Update navs
  dom.contentTabs.querySelectorAll('.content-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'discover');
  });
  updateMobileNavActive(dom.mobileDiscover);
  setDesktopDiscoverActive(true);

  // Initialize genres if empty
  if (dom.discoverGenres.children.length === 0) {
    renderDiscoverGenres();
  }

  // Initial load if first time
  if (discoverState.results.length === 0) {
    handleDiscoverSearch();
  } else {
    dom.discoverResultsMeta.textContent = `${discoverState.results.length} titles loaded for ${discoverState.type === 'tv' ? 'TV shows' : 'movies'}.`;
  }
  trackEvent('discover_open', {
    type: discoverState.type,
    sort: discoverState.sort,
  });

  if (updateHistory) {
    syncHistoryState(historyMode);
  }
}

function renderDiscoverGenres() {
  const list = genres[discoverState.type] || [];
  dom.discoverGenres.innerHTML = list.map(g => `
    <div class="filter-chip ${discoverState.genres.includes(g.id) ? 'active' : ''}" data-id="${g.id}">
      ${g.name}
    </div>
  `).join('');

  // Re-bind clicks
  dom.discoverGenres.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const gId = parseInt(chip.dataset.id);
      if (discoverState.genres.includes(gId)) {
        discoverState.genres = discoverState.genres.filter(id => id !== gId);
      } else {
        discoverState.genres.push(gId);
      }
      chip.classList.toggle('active');
      handleDiscoverSearch();
    });
  });
}

function handleDiscoverSearch(resetPage = true) {
  if (resetPage) {
    discoverState.page = 1;
    discoverState.results = [];
    renderSkeletons(dom.discoverGrid, 8);
    dom.discoverResultsMeta.textContent = 'Refreshing results with your latest filters...';
    dom.discoverLoadMore.classList.add('hidden');
  }

  const params = {
    sort_by: resolveDiscoverSort(discoverState.type, discoverState.sort),
    page: discoverState.page,
    'vote_average.gte': discoverState.rating,
  };

  if (discoverState.yearFrom) {
    const key = discoverState.type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte';
    params[key] = `${discoverState.yearFrom}-01-01`;
  }
  if (discoverState.yearTo) {
    const key = discoverState.type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte';
    params[key] = `${discoverState.yearTo}-12-31`;
  }
  if (discoverState.genres.length > 0) {
    params.with_genres = discoverState.genres.join(',');
  }

  return api.discoverContent(discoverState.type, params).then(data => {
    if (resetPage) dom.discoverGrid.innerHTML = '';
    
    if (data && !data.isError && data.results && data.results.length > 0) {
      discoverState.results = resetPage ? data.results : [...discoverState.results, ...data.results];
      renderGrid(dom.discoverGrid, data.results, discoverState.type, !resetPage);
      dom.discoverResultsMeta.textContent = `${discoverState.results.length} titles loaded for ${discoverState.type === 'tv' ? 'TV shows' : 'movies'}.`;
      
      if (data.page < data.total_pages) {
        dom.discoverLoadMore.classList.remove('hidden');
      } else {
        dom.discoverLoadMore.classList.add('hidden');
      }
    } else if (data && data.isError) {
      renderStateCard(dom.discoverGrid, {
        variant: 'error',
        title: 'Discover is unavailable',
        message: 'We could not load curated titles right now. Please try again shortly.',
      });
      dom.discoverResultsMeta.textContent = 'Discover temporarily unavailable.';
      dom.discoverLoadMore.classList.add('hidden');
    } else {
      renderStateCard(dom.discoverGrid, {
        variant: 'empty',
        title: 'No titles fit these filters',
        message: 'Widen the release years, lower the minimum rating, or remove a genre chip.',
      });
      dom.discoverResultsMeta.textContent = 'No matches for the current filters.';
      dom.discoverLoadMore.classList.add('hidden');
    }
  });
}

function resolveDiscoverSort(type, sort) {
  if (type === 'tv') {
    if (sort === 'primary_release_date.desc') return 'first_air_date.desc';
    if (sort === 'primary_release_date.asc') return 'first_air_date.asc';
  }
  return sort;
}

function resetDiscoverFilters() {
  discoverState = {
    ...discoverState,
    type: 'movie',
    sort: 'popularity.desc',
    yearFrom: '',
    yearTo: '',
    rating: 0,
    genres: [],
    page: 1,
    results: [],
  };

  applyDiscoverFilterUI();
  renderDiscoverGenres();
  handleDiscoverSearch();
}


// ═══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
function bindEvents() {
  // Navbar scroll effect
  window.addEventListener('scroll', () => {
    dom.navbar?.classList.toggle('scrolled', window.scrollY > 40);
  });

  // Search
  dom.searchInput?.addEventListener('input', (e) => handleSearch(e.target.value));
  dom.clearSearchBtn?.addEventListener('click', () => clearSearch({ updateHistory: true }));

  // Top nav
  dom.logoLink?.addEventListener('click', (e) => {
    e.preventDefault();
    goHomeView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  dom.discoverBtn?.addEventListener('click', showDiscoverSection);

  // Genre menu toggle
  dom.genreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    dom.genreMenu?.classList.toggle('show');
  });

  // Close genre menu when clicking outside
  document.addEventListener('click', (e) => {
    if (dom.genreMenu && !dom.genreMenu.contains(e.target) && dom.genreBtn && !dom.genreBtn.contains(e.target)) {
      dom.genreMenu.classList.remove('show');
    }
  });

  // Content tabs
  dom.contentTabs?.querySelectorAll('.content-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const type = tab.dataset.tab;
      if (type === 'discover') {
        showDiscoverSection();
        return;
      }
      
      dom.contentTabs.querySelectorAll('.content-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      setDesktopDiscoverActive(false);
      currentTab = type;
      clearSearch();
      dom.discoverSection?.classList.add('hidden');
      dom.heroSection?.classList.remove('hidden');
      dom.contentTabs?.classList.remove('hidden');

      if (activeGenreName) {
        // Try mapping the genre to the new selected tab's available genres
        const list = currentTab === 'tv' ? genres.tv : genres.movie;
        let match = list.find(g => g.name === activeGenreName);
        
        // Handle names that don't match exactly (e.g. "War" -> "War & Politics", "Action" -> "Action & Adventure")
        if (!match) {
          if (activeGenreName.includes('War')) match = list.find(g => g.name.includes('War'));
          else if (activeGenreName.includes('Action') || activeGenreName.includes('Adventure')) match = list.find(g => g.name.includes('Action'));
          else if (activeGenreName.includes('Sci-Fi') || activeGenreName.includes('Science')) match = list.find(g => g.name.includes('Sci-Fi') || g.name.includes('Science'));
        }
        
        if (match) {
          activeGenreId = match.id;
          activeGenreName = match.name;
          filterByGenre(activeGenreId, activeGenreName);
        } else {
          clearGenreFilter();
        }
      } else {
        dom.genreSection?.classList.add('hidden');
        dom.trendingSection?.classList.remove('hidden');
        dom.upcomingSection?.classList.remove('hidden');
        dom.topRatedSection?.classList.remove('hidden');
        loadContent();
        loadPersonalizedRecommendations();
        syncHistoryState('push');
      }
      
      renderGenreMenu();
    });
  });

  // Watchlist drawer
  dom.watchlistBtn?.addEventListener('click', openWatchlistDrawer);
  dom.drawerClose?.addEventListener('click', closeWatchlistDrawer);
  dom.drawerOverlay?.addEventListener('click', closeWatchlistDrawer);

  // Modal
  dom.modalClose?.addEventListener('click', closeModal);
  dom.modalBackdrop?.addEventListener('click', (e) => {
    if (e.target === dom.modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dom.modalBackdrop?.classList.contains('show')) closeModal();
      if (dom.watchlistDrawer?.classList.contains('open') || dom.watchlistDrawer?.classList.contains('show')) closeWatchlistDrawer();
      if (dom.conciergeOverlay && !dom.conciergeOverlay.classList.contains('hidden')) setOverlayState(null);
      if ($('#profile-modal-overlay') && !$('#profile-modal-overlay').classList.contains('hidden')) closeProfileModal();
      if (dom.onboardingOverlay && !dom.onboardingOverlay.classList.contains('hidden')) dismissOnboarding();
    }
  });

  // AI Concierge
  dom.smartMatchFab?.addEventListener('click', () => {
    setOverlayState('smart-match');
    trackEvent('smart_match_open', { source: 'fab' });
    syncHistoryState('push');
  });

  dom.conciergeClose?.addEventListener('click', () => setOverlayState(null));
  dom.conciergeInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendConciergeMessage();
  });
  dom.conciergeSend?.addEventListener('click', sendConciergeMessage);

  // Mobile Bottom Nav
  dom.mobileHome?.addEventListener('click', () => {
    goHomeView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  dom.mobileDiscover?.addEventListener('click', () => {
    updateMobileNavActive(dom.mobileDiscover);
    showDiscoverSection();
  });

  dom.mobileSmart?.addEventListener('click', () => {
    updateMobileNavActive(dom.mobileSmart);
    dom.smartMatchFab?.click();
  });

  dom.mobileProfile?.addEventListener('click', () => {
    updateMobileNavActive(dom.mobileProfile);
    trackEvent('profile_open', { source: 'mobile-nav' });
    openProfileModal();
  });

  // Search Load More
  dom.searchLoadMore?.addEventListener('click', async () => {
    if (!currentSearchQuery) return;
    const nextPage = currentSearchPage + 1;
    await fetchSearchResults(currentSearchQuery, nextPage);
  });

  // Genre results "Clear Filter"
  dom.clearGenreBtn?.addEventListener('click', clearGenreFilter);

  // Discover filters
  dom.discoverSort?.addEventListener('change', (e) => {
    discoverState.sort = e.target.value;
    handleDiscoverSearch();
  });
  dom.discoverYearFrom?.addEventListener('change', (e) => {
    discoverState.yearFrom = e.target.value.trim();
    handleDiscoverSearch();
  });
  dom.discoverYearTo?.addEventListener('change', (e) => {
    discoverState.yearTo = e.target.value.trim();
    handleDiscoverSearch();
  });
  dom.discoverRating?.addEventListener('input', (e) => {
    discoverState.rating = Number(e.target.value);
    dom.discoverRatingVal.textContent = e.target.value;
    handleDiscoverSearch();
  });
  dom.discoverTypeToggles.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextType = btn.dataset.type;
      if (!nextType || discoverState.type === nextType) return;
      discoverState.type = nextType;
      discoverState.genres = [];
      renderDiscoverGenres();
      applyDiscoverFilterUI();
      handleDiscoverSearch();
    });
  });
  dom.discoverReset?.addEventListener('click', resetDiscoverFilters);
  dom.discoverLoadMore?.addEventListener('click', () => {
    discoverState.page++;
    handleDiscoverSearch(false);
  });

  dom.onboardingClose?.addEventListener('click', dismissOnboarding);
  dom.onboardingCta?.addEventListener('click', dismissOnboarding);
  dom.onboardingOverlay?.addEventListener('click', (e) => {
    if (e.target === dom.onboardingOverlay) dismissOnboarding();
  });
}

function updateMobileNavActive(activeItem) {
  dom.mobileNavItems.forEach(item => item.classList.remove('active'));
  activeItem.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
async function init() {
  createParticles();
  bindEvents();
  bindAuthEvents();
  bindConciergeEvents();

  try {
    await loadRuntimeConfig();
    initializeSupabaseClient();
    await recoverOAuthSession();
  } catch (err) {
    console.error('Runtime configuration failed:', err);
    showAuthScreen();
    showAuthMessage('CineNext could not load its runtime configuration. Start the ML/API server and refresh.');
    renderStateCard(dom.trendingGrid, {
      variant: 'error',
      title: 'CineNext is offline',
      message: 'Start the local ML/API server on port 5001, then refresh this page.',
    });
    return;
  }

  checkMlServer();

  // ── Session Restore ─────────────────────────────────────────
  // Supabase v2 CDN uses Web Locks API which deadlocks on page
  // refresh. ALL auth methods (getSession, setSession, onAuthStateChange)
  // are affected. We bypass this entirely by reading the stored
  // session from localStorage and decoding the JWT manually.
  const STORAGE_KEY = getSupabaseStorageKey();
  let sessionRestored = false;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.access_token && parsed.user) {
        // Check if token is expired
        const payload = JSON.parse(atob(parsed.access_token.split('.')[1]));
        const now = Math.floor(Date.now() / 1000);
        
        if (payload.exp && payload.exp > now) {
          // Token is still valid — restore the session manually
          currentUser = parsed.user;
          await loadUserDataFromDB();
          enterApp();
          sessionRestored = true;
        } else if (parsed.refresh_token) {
          // Token expired — try to refresh it (this may hit the lock, but 
          // at least the user had a valid session recently)
          console.log('Access token expired, attempting refresh...');
          try {
            const res = await fetch(`${getSupabaseUrl()}/auth/v1/token?grant_type=refresh_token`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': getSupabaseAnonKey(),
              },
              body: JSON.stringify({ refresh_token: parsed.refresh_token }),
            });
            if (res.ok) {
              const refreshed = await res.json();
              // Save the new tokens
              localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshed));
              currentUser = refreshed.user;
              await loadUserDataFromDB();
              enterApp();
              sessionRestored = true;
            }
          } catch (refreshErr) {
            console.warn('Token refresh failed:', refreshErr);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Manual session restore failed:', err);
  }

  if (!sessionRestored) {
    showAuthScreen();
  }
  // Listen for future auth changes (login, logout)
  // We wrap this in a try-catch because onAuthStateChange may
  // also deadlock on the Web Locks API in some environments.
  try {
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN') {
        if (session && (!currentUser || currentUser.id !== session.user.id)) {
          currentUser = session.user;
          await loadUserDataFromDB();
          enterApp();
        }
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        watchlist = [];
        watchedList = [];
        favouritesList = [];
        updateWatchlistCount();
        showAuthScreen();
      }
    });
  } catch (e) {
    console.warn('onAuthStateChange setup failed:', e);
  }

  syncHistoryState('replace');
  window.addEventListener('popstate', async (event) => {
    const appState = event.state?.cinenextState || null;
    await applyHistoryState(appState);
  });
  updateBodyScrollLock();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// AI CONCIERGE & DYNAMIC THEMING
// ═══════════════════════════════════════════════════════════════
function extractDominantColor(imgEl) {
  if (!dom.colorExtractCanvas || !imgEl.complete || imgEl.naturalWidth === 0) return;
  const canvas = dom.colorExtractCanvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  try {
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    
    let r = 0, g = 0, b = 0, count = 0;
    
    for (let i = 0; i < imageData.length; i += 64) {
      const pr = imageData[i], pg = imageData[i+1], pb = imageData[i+2];
      const darkness = (pr + pg + pb) / 3;
      if (darkness > 30 && darkness < 225) { 
        r += pr; g += pg; b += pb;
        count++;
      }
    }
    
    if (count > 0) {
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
      
      document.documentElement.style.setProperty('--dynamic-accent', `rgb(${r}, ${g}, ${b})`);
      document.documentElement.style.setProperty('--dynamic-accent-rgb', `${r}, ${g}, ${b}`);
      document.getElementById('modal')?.classList.add('dynamic-themed');
    } else {
      document.getElementById('modal')?.classList.remove('dynamic-themed');
    }
  } catch(e) {
    console.warn('Canvas extraction blocked by CORS.', e);
  }
}

let conciergeMessages = [];
let isConciergeTyping = false;

function updateConciergeLayoutState() {
  const hasUserMessage = conciergeMessages.some((msg) => msg.role === 'user');
  dom.conciergeContainer?.classList.toggle('has-history', hasUserMessage);
}

function renderConciergeMessages() {
  if (!dom.conciergeMessages) return;
  updateConciergeLayoutState();
  dom.conciergeMessages.innerHTML = '';
  
  conciergeMessages.forEach((msg) => {
    const el = document.createElement('div');
    const isUser = msg.role === 'user';
    el.className = `chat-message ${isUser ? 'user' : 'ai'}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'chat-msg-avatar';
    avatar.innerHTML = isUser ? '😊' : '🤖';
    el.appendChild(avatar);
    
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message-body';

    const label = document.createElement('div');
    label.className = 'chat-message-label';
    label.textContent = isUser ? 'You' : 'Concierge';
    wrapper.appendChild(label);
    
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = msg.content;
    wrapper.appendChild(bubble);
    
    if (msg.recommendations && msg.recommendations.length > 0) {
      const recsEl = document.createElement('div');
      recsEl.className = 'chat-movie-grid';
      msg.recommendations.forEach(r => {
        const posterUrl = r.poster_path ? `https://image.tmdb.org/t/p/w200${r.poster_path}` : 'placeholder.jpg';
        const card = document.createElement('div');
        card.className = 'chat-movie-card';
        const year = r.release_date ? r.release_date.split('-')[0] : (r.first_air_date ? r.first_air_date.split('-')[0] : '');
        const rating = r.vote_average ? r.vote_average.toFixed(1) : '';
        card.innerHTML = `
          <img src="${posterUrl}" alt="poster">
          <div class="chat-movie-info">
            <div class="chat-movie-title">${r.title || r.name}</div>
            <div class="chat-movie-meta"><span>Rating ${rating}</span><span>${year}</span></div>
          </div>
        `;
        card.onclick = () => {
          dom.conciergeClose?.click();
          openModal(r.id, r.media_type || 'movie');
        };
        recsEl.appendChild(card);
      });
      wrapper.appendChild(recsEl);
    }
    
    el.appendChild(wrapper);
    dom.conciergeMessages.appendChild(el);
  });
  
  if (isConciergeTyping) {
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-message ai';
    typingEl.innerHTML = `<div class="chat-msg-avatar">🤖</div><div class="typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
    dom.conciergeMessages.appendChild(typingEl);
  }
  
  dom.conciergeMessages.scrollTop = dom.conciergeMessages.scrollHeight;
}

function submitConciergePrompt(prompt) {
  if (!dom.conciergeInput) return;
  dom.conciergeInput.value = prompt;
  sendConciergeMessage();
}

async function sendConciergeMessage() {
  const text = dom.conciergeInput.value.trim();
  if (!text) return;
  
  dom.conciergeInput.value = '';
  conciergeMessages.push({ role: 'user', content: text });
  isConciergeTyping = true;
  renderConciergeMessages();
  
  try {
    const res = await fetch(`${getMlBase()}/api/concierge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conciergeMessages })
    });
    
    if (res.ok) {
      const data = await res.json();
      conciergeMessages.push({ 
        role: 'assistant', 
        content: data.reply,
        recommendations: data.recommendations || []
      });
    } else {
      conciergeMessages.push({ role: 'assistant', content: 'Ops! I had a problem processing that request.' });
    }
  } catch (error) {
    console.error('Concierge Error:', error);
    conciergeMessages.push({ role: 'assistant', content: 'Connection to AI server failed. Ensure the ML server is running on port 5001.' });
  }
  
  isConciergeTyping = false;
  renderConciergeMessages();
}

function bindConciergeEvents() {
  function openConcierge() {
    setOverlayState('smart-match');
    if (conciergeMessages.length === 0) {
      conciergeMessages.push({ role: 'assistant', content: "Hi! I'm your AI Movie Concierge. What kind of movie or TV show are you in the mood for?", recommendations: [] });
      renderConciergeMessages();
    }
    setTimeout(() => dom.conciergeInput?.focus(), 100);
  }

  dom.smartMatchFab?.addEventListener('click', openConcierge);
  
  const navSmartBtn = document.getElementById('mobile-nav-smart');
  if (navSmartBtn) navSmartBtn.addEventListener('click', openConcierge);
  
  dom.conciergeSend?.addEventListener('click', sendConciergeMessage);
  
  dom.conciergeInput?.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') sendConciergeMessage();
  });

  document.querySelectorAll('.concierge-prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (prompt) submitConciergePrompt(prompt);
    });
  });
  
  dom.conciergeClose?.addEventListener('click', () => {
    setOverlayState(null);
  });
}
