// Public Supabase settings for the browser. These are safe to commit:
// the anon/publishable key only allows what the row-level security rules allow,
// and every user can only reach their own rows.
// Find both in Supabase: Project Settings > API.
window.PP_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "your-anon-or-publishable-key",
};
