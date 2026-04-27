-- ============================================================
-- XIT MMOD: restrict plugin user statistics to executives
-- Run this in Supabase SQL Editor for existing databases.
-- ============================================================

ALTER TABLE IF EXISTS public.plugin_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plugin_users_select" ON public.plugin_users;
DROP POLICY IF EXISTS "plugin_users_insert" ON public.plugin_users;
DROP POLICY IF EXISTS "plugin_users_update" ON public.plugin_users;

-- Only logged-in executives can read the full plugin user list.
CREATE POLICY "plugin_users_select"
  ON public.plugin_users FOR SELECT
  TO authenticated
  USING (public.get_my_role() = 'executive');

-- Keep passive usage reporting available for all plugin users.
CREATE POLICY "plugin_users_insert"
  ON public.plugin_users FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "plugin_users_update"
  ON public.plugin_users FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
