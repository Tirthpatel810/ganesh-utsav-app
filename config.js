/* =====================================================================
   THE ONLY FILE YOU NEED TO EDIT.

   Get both values from Supabase:
     Dashboard -> your project -> Settings -> API
       SUPABASE_URL  = "Project URL"
       SUPABASE_ANON = "anon / public" key   (the LONG one)

   The anon key is SAFE to commit to a public GitHub repo. It grants
   nothing on its own -- Row Level Security in schema.sql requires a
   signed-in user for every single read and write.

   NEVER put the "service_role" key here. That one bypasses RLS and
   belongs only in Odoo's server-side settings.
   ===================================================================== */
window.GANESH_CONFIG = {
  SUPABASE_URL : "https://PASTE-YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON: "PASTE-YOUR-ANON-PUBLIC-KEY",

  // How often the app asks the server for new rows, in seconds.
  // 4s feels live. Raise to 10 on a very bad network to save battery.
  POLL_SECONDS: 4,

  // Quick-tap plate buttons shown in the serve sheet.
  QTY_BUTTONS: [1, 2, 3, 4, 5],

  // Seconds an entry stays undoable in the log.
  UNDO_WINDOW_SECONDS: 900
};
