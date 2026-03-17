-- ============================================================
-- Talent Pipeline: Auth & Profiles Setup
-- Run this in Supabase SQL Editor (supabase.com/dashboard)
-- ============================================================

-- 1. Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  full_name   TEXT DEFAULT '',
  avatar_url  TEXT,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Auto-create profile when a user signs up / is invited
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Add tracking columns to existing tables
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id);
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);
ALTER TABLE public.job_candidates ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id);

-- 4. Enable Row Level Security on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies: Authenticated users can do everything (team is invite-only)

-- Profiles
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- Jobs
CREATE POLICY "jobs_select" ON public.jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY "jobs_insert" ON public.jobs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "jobs_update" ON public.jobs FOR UPDATE TO authenticated USING (true);
CREATE POLICY "jobs_delete" ON public.jobs FOR DELETE TO authenticated USING (true);

-- Candidates
CREATE POLICY "candidates_select" ON public.candidates FOR SELECT TO authenticated USING (true);
CREATE POLICY "candidates_insert" ON public.candidates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "candidates_update" ON public.candidates FOR UPDATE TO authenticated USING (true);
CREATE POLICY "candidates_delete" ON public.candidates FOR DELETE TO authenticated USING (true);

-- Job Candidates
CREATE POLICY "jc_select" ON public.job_candidates FOR SELECT TO authenticated USING (true);
CREATE POLICY "jc_insert" ON public.job_candidates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "jc_update" ON public.job_candidates FOR UPDATE TO authenticated USING (true);
CREATE POLICY "jc_delete" ON public.job_candidates FOR DELETE TO authenticated USING (true);

-- Activity Log
CREATE POLICY "activity_select" ON public.activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "activity_insert" ON public.activity_log FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================
-- Client View Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS client_shares (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  project_name TEXT NOT NULL,
  bu TEXT NOT NULL,
  job_ids UUID[] NOT NULL DEFAULT '{}',
  allowed_emails TEXT[] NOT NULL DEFAULT '{}',
  client_logo_url TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_client_shares_token ON client_shares(token);
CREATE INDEX idx_client_shares_active ON client_shares(is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS client_actions_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  share_id UUID REFERENCES client_shares(id),
  job_candidate_id UUID REFERENCES job_candidates(id),
  action_type TEXT NOT NULL,
  action_data JSONB DEFAULT '{}',
  actor_email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_client_actions_share ON client_actions_log(share_id);

ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_viewed_at TIMESTAMPTZ;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_feedback TEXT;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_action_at TIMESTAMPTZ;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS interview_notes TEXT;

-- ============================================================
-- MANUAL STEPS (do in Supabase Dashboard UI):
-- 1. Authentication > Settings > toggle OFF "Enable sign ups"
--    (this makes it invite-only)
-- 2. After deploying to Vercel, go to:
--    Authentication > URL Configuration
--    - Set "Site URL" to your Vercel URL (e.g. https://talent-pipeline.vercel.app)
--    - Add Vercel URL to "Redirect URLs"
-- ============================================================
