-- ============================================================
-- XIT FACTION: allow snapshot-style daily production replacement
-- Run this in Supabase SQL Editor for existing databases.
-- ============================================================

DROP POLICY IF EXISTS "production_delete" ON daily_production;

CREATE POLICY "production_delete" ON daily_production FOR DELETE TO authenticated
  USING (
    faction_id = get_my_faction_id()
    AND (
      company_name = get_my_company_name()
      OR get_my_role() = 'executive'
    )
  );
