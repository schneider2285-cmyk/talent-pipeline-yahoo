// One-time migration: fix activity_log trigger
// POST /api/migrate with Authorization: Bearer <service_role_key>
// DELETE THIS FILE after running successfully

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!serviceRoleKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set', envKeys: Object.keys(process.env).filter(k => k.includes('SUPA')).sort() });
  }
  if (!auth || auth !== serviceRoleKey) {
    return res.status(403).json({ error: 'Forbidden', keyLen: serviceRoleKey.length, authLen: auth.length, match: auth === serviceRoleKey });
  }

  // Try DATABASE_URL first, then POSTGRES_URL (Vercel Postgres integration)
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;

  if (!dbUrl) {
    return res.status(500).json({
      error: 'No DATABASE_URL found',
      available_env: Object.keys(process.env).filter(k => k.includes('PG') || k.includes('POSTGRES') || k.includes('DATABASE') || k.includes('SUPABASE')).sort()
    });
  }

  try {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    // Step 1: Add missing column
    await client.query('ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS details JSONB');

    // Step 2: Fix trigger function
    await client.query(`
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
    `);

    // Step 3: Test — update a row to verify trigger works
    const test = await client.query("UPDATE job_candidates SET updated_at = NOW() WHERE id = (SELECT id FROM job_candidates LIMIT 1) RETURNING id, status");

    await client.end();
    return res.status(200).json({ success: true, test_row: test.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
}
