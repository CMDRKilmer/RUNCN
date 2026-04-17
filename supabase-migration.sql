-- ============================================================
-- Supabase Migration for XIT FACTION
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================

-- 1. Tables

CREATE TABLE factions (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO factions (id, name) VALUES ('liuli', '琉璃主权资本');

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  faction_id text NOT NULL REFERENCES factions(id),
  company_name text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'partner', 'executive')),
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_members_auth ON members(auth_uid);
CREATE INDEX idx_members_faction ON members(faction_id);

CREATE TABLE invite_codes (
  code text PRIMARY KEY,
  faction_id text NOT NULL REFERENCES factions(id),
  created_by text NOT NULL,
  used_by text,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE treasury_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id text NOT NULL REFERENCES factions(id),
  amount numeric NOT NULL,
  operator text NOT NULL,
  note text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_treasury_created ON treasury_records(faction_id, created_at);

CREATE TABLE logistics_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id text NOT NULL REFERENCES factions(id),
  requester text NOT NULL,
  material_ticker text NOT NULL,
  quantity integer NOT NULL,
  destination text NOT NULL,
  reason text DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
  reviewer text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_logistics_status ON logistics_requests(faction_id, status);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id text NOT NULL REFERENCES factions(id),
  title text NOT NULL,
  description text DEFAULT '',
  assignee text,
  created_by text NOT NULL,
  due_date text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'review', 'done')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_status ON tasks(faction_id, status);

CREATE TABLE task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id);

CREATE TABLE bulletins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id text NOT NULL REFERENCES factions(id),
  title text NOT NULL,
  content text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_production (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faction_id text NOT NULL REFERENCES factions(id),
  company_name text NOT NULL,
  material_ticker text NOT NULL,
  quantity integer NOT NULL,
  report_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(faction_id, company_name, material_ticker, report_date)
);

-- 2. Helper functions

CREATE OR REPLACE FUNCTION get_my_faction_id()
RETURNS text AS $$
  SELECT faction_id FROM public.members WHERE auth_uid = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS text AS $$
  SELECT role FROM public.members WHERE auth_uid = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_my_company_name()
RETURNS text AS $$
  SELECT company_name FROM public.members WHERE auth_uid = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 3. RPC functions

CREATE OR REPLACE FUNCTION validate_invite(invite_code text)
RETURNS json AS $$
DECLARE
  inv invite_codes;
BEGIN
  SELECT * INTO inv FROM invite_codes WHERE code = invite_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_INVITE';
  END IF;
  IF inv.used_by IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_USED';
  END IF;
  RETURN json_build_object('valid', true, 'factionId', inv.faction_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION complete_registration(invite_code text, p_company_name text)
RETURNS json AS $$
DECLARE
  inv invite_codes;
  new_member members;
BEGIN
  SELECT * INTO inv FROM invite_codes WHERE code = invite_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_INVITE'; END IF;
  IF inv.used_by IS NOT NULL THEN RAISE EXCEPTION 'INVITE_USED'; END IF;
  IF EXISTS (SELECT 1 FROM members WHERE company_name = p_company_name) THEN
    RAISE EXCEPTION 'ALREADY_REGISTERED';
  END IF;

  INSERT INTO members (auth_uid, faction_id, company_name, role)
  VALUES (auth.uid(), inv.faction_id, p_company_name, 'member')
  RETURNING * INTO new_member;

  UPDATE invite_codes SET used_by = p_company_name, used_at = now() WHERE code = invite_code;

  RETURN json_build_object(
    'ok', true,
    'member', json_build_object(
      'id', new_member.id,
      'companyName', new_member.company_name,
      'role', new_member.role,
      'factionId', new_member.faction_id
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_treasury_balance()
RETURNS json AS $$
DECLARE
  my_faction text;
  bal numeric;
BEGIN
  my_faction := get_my_faction_id();
  IF my_faction IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO bal FROM treasury_records WHERE faction_id = my_faction;
  RETURN json_build_object('ok', true, 'balance', bal);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION create_invite_code()
RETURNS json AS $$
DECLARE
  my_role text; my_faction text; my_name text; new_code text;
BEGIN
  my_role := get_my_role();
  IF my_role != 'executive' THEN RAISE EXCEPTION 'INSUFFICIENT_PERMISSION'; END IF;
  my_faction := get_my_faction_id();
  my_name := get_my_company_name();
  new_code := upper(substr(gen_random_uuid()::text, 1, 8));
  INSERT INTO invite_codes (code, faction_id, created_by) VALUES (new_code, my_faction, my_name);
  RETURN json_build_object('ok', true, 'code', new_code);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RLS Policies

ALTER TABLE factions ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE treasury_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulletins ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_production ENABLE ROW LEVEL SECURITY;

-- Factions: anyone authenticated can read
CREATE POLICY "factions_select" ON factions FOR SELECT TO authenticated USING (true);

-- Members: same faction can read
CREATE POLICY "members_select" ON members FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id());

-- Members: executive can update others' role
CREATE POLICY "members_update" ON members FOR UPDATE TO authenticated
  USING (get_my_role() = 'executive' AND faction_id = get_my_faction_id() AND auth_uid != auth.uid())
  WITH CHECK (get_my_role() = 'executive' AND faction_id = get_my_faction_id());

-- Members: executive can delete others
CREATE POLICY "members_delete" ON members FOR DELETE TO authenticated
  USING (get_my_role() = 'executive' AND faction_id = get_my_faction_id() AND auth_uid != auth.uid());

-- Treasury: partner+ can read records
CREATE POLICY "treasury_select" ON treasury_records FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id() AND get_my_role() IN ('executive', 'partner'));

-- Treasury: executive can insert
CREATE POLICY "treasury_insert" ON treasury_records FOR INSERT TO authenticated
  WITH CHECK (faction_id = get_my_faction_id() AND get_my_role() = 'executive');

-- Logistics: same faction can read
CREATE POLICY "logistics_select" ON logistics_requests FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id());

-- Logistics: partner+ can insert
CREATE POLICY "logistics_insert" ON logistics_requests FOR INSERT TO authenticated
  WITH CHECK (faction_id = get_my_faction_id() AND get_my_role() IN ('executive', 'partner'));

-- Logistics: executive can update (review)
CREATE POLICY "logistics_update" ON logistics_requests FOR UPDATE TO authenticated
  USING (get_my_role() = 'executive' AND faction_id = get_my_faction_id())
  WITH CHECK (get_my_role() = 'executive' AND faction_id = get_my_faction_id());

-- Tasks: same faction can read
CREATE POLICY "tasks_select" ON tasks FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id());

-- Tasks: executive can insert
CREATE POLICY "tasks_insert" ON tasks FOR INSERT TO authenticated
  WITH CHECK (faction_id = get_my_faction_id() AND get_my_role() = 'executive');

-- Tasks: same faction can update (claim, status change)
CREATE POLICY "tasks_update" ON tasks FOR UPDATE TO authenticated
  USING (faction_id = get_my_faction_id())
  WITH CHECK (faction_id = get_my_faction_id());

-- Tasks: executive can delete
CREATE POLICY "tasks_delete" ON tasks FOR DELETE TO authenticated
  USING (get_my_role() = 'executive' AND faction_id = get_my_faction_id());

-- Task comments: same faction can read (via task's faction)
CREATE POLICY "comments_select" ON task_comments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.faction_id = get_my_faction_id()));

-- Task comments: same faction can insert
CREATE POLICY "comments_insert" ON task_comments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.faction_id = get_my_faction_id()));

-- Bulletins: same faction can read
CREATE POLICY "bulletins_select" ON bulletins FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id());

-- Bulletins: executive can insert
CREATE POLICY "bulletins_insert" ON bulletins FOR INSERT TO authenticated
  WITH CHECK (faction_id = get_my_faction_id() AND get_my_role() = 'executive');

-- Daily production: same faction can read
CREATE POLICY "production_select" ON daily_production FOR SELECT TO authenticated
  USING (faction_id = get_my_faction_id());

-- Daily production: authenticated members can upsert their own
CREATE POLICY "production_insert" ON daily_production FOR INSERT TO authenticated
  WITH CHECK (faction_id = get_my_faction_id() AND company_name = get_my_company_name());

CREATE POLICY "production_update" ON daily_production FOR UPDATE TO authenticated
  USING (faction_id = get_my_faction_id() AND company_name = get_my_company_name())
  WITH CHECK (faction_id = get_my_faction_id() AND company_name = get_my_company_name());

CREATE POLICY "production_delete" ON daily_production FOR DELETE TO authenticated
  USING (
    faction_id = get_my_faction_id()
    AND (
      company_name = get_my_company_name()
      OR get_my_role() = 'executive'
    )
  );

-- Invite codes: no direct access, handled by SECURITY DEFINER functions
