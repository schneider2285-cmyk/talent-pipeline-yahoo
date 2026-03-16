-- Add missing details column to activity_log
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS details JSONB;

-- Fix trigger function to not reference nonexistent columns
CREATE OR REPLACE FUNCTION on_job_candidate_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at := NOW();
    INSERT INTO activity_log (entity_type, entity_id, action, old_value, new_value, source, created_at)
    VALUES ('job_candidate', NEW.id, 'status_change', OLD.status, NEW.status, 'trigger', NOW());
    UPDATE jobs SET last_activity_at = NOW() WHERE id = NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
