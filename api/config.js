export default function handler(req, res) {
  // All values come from Vercel Environment Variables (encrypted at rest).
  const mlBackendUrl = process.env.RENDER_ML_URL || '';
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '';

  return res.status(200).json({
    mlBase: mlBackendUrl,
    supabaseUrl,
    supabaseAnonKey,
    googleRedirectTo: siteUrl,
    onboardingEnabled: true,
    analyticsEnabled: true,
  });
}
