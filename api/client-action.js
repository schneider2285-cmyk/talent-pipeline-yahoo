// Vercel Serverless Function: Client Action API
// Handles client actions: view, interview request, pass
// Uses direct Supabase PostgREST API (no SDK dependency)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const token = body.token;
  const email = (body.email || '').toLowerCase().trim();
  const actionType = body.action_type;
  const jcId = body.job_candidate_id;
  const actionData = body.action_data || {};

  if (!token || !email || !actionType || !jcId) {
    return res.status(400).json({ error: 'Missing required fields: token, email, action_type, job_candidate_id' });
  }

  const validActions = ['viewed', 'interview_requested', 'passed'];
  if (!validActions.includes(actionType)) {
    return res.status(400).json({ error: 'Invalid action_type. Must be: ' + validActions.join(', ') });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // 1. Validate share
    const shareResp = await fetch(
      `${supabaseUrl}/rest/v1/client_shares?token=eq.${encodeURIComponent(token)}&is_active=eq.true&select=*`,
      { headers }
    );
    const shares = await shareResp.json();
    if (!shareResp.ok || !shares || shares.length === 0) {
      return res.status(404).json({ error: 'Share not found or inactive' });
    }
    const share = shares[0];

    // 2. Validate email
    const allowed = (share.allowed_emails || []).map(e => e.toLowerCase().trim());
    if (!allowed.includes(email)) {
      return res.status(403).json({ error: 'Email not recognized' });
    }

    // 3. Validate job_candidate belongs to a job in this share
    const jcResp = await fetch(
      `${supabaseUrl}/rest/v1/job_candidates?id=eq.${encodeURIComponent(jcId)}&select=id,job_id,status,client_viewed_at`,
      { headers }
    );
    const jcs = await jcResp.json();
    if (!jcResp.ok || !jcs || jcs.length === 0) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const jc = jcs[0];

    if (!(share.job_ids || []).includes(jc.job_id)) {
      return res.status(403).json({ error: 'Candidate not in scope for this share' });
    }

    // 4. Build updates
    const updates = { client_action_at: new Date().toISOString() };

    if (actionType === 'viewed') {
      if (!jc.client_viewed_at) {
        updates.client_viewed_at = new Date().toISOString();
      }
    }

    if (actionType === 'interview_requested') {
      updates.status = 'INTERVIEW SCHEDULED';
      updates.interview_notes = actionData.interview_notes || null;
      if (actionData.scheduled_date) {
        updates.date_interview = actionData.scheduled_date;
      }
    }

    if (actionType === 'passed') {
      updates.status = 'CLIENT REJECTED';
      updates.client_feedback = actionData.feedback || null;
      updates.date_rejected = new Date().toISOString();
    }

    // 5. Update job_candidates
    const updateResp = await fetch(
      `${supabaseUrl}/rest/v1/job_candidates?id=eq.${encodeURIComponent(jcId)}`,
      { method: 'PATCH', headers, body: JSON.stringify(updates) }
    );
    if (!updateResp.ok) {
      const errBody = await updateResp.text();
      throw new Error('Update failed: ' + errBody);
    }

    // 6. Log the action
    await fetch(`${supabaseUrl}/rest/v1/client_actions_log`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        share_id: share.id,
        job_candidate_id: jcId,
        action_type: actionType,
        action_data: actionData,
        actor_email: email
      })
    });

    // 7. Log to activity_log
    let actionNote = '';
    if (actionType === 'viewed') actionNote = 'Client viewed candidate';
    if (actionType === 'interview_requested') actionNote = 'Client requested interview';
    if (actionType === 'passed') actionNote = 'Client passed on candidate' + (actionData.feedback ? ': ' + actionData.feedback : '');

    await fetch(`${supabaseUrl}/rest/v1/activity_log`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        entity_type: 'job_candidate',
        entity_id: jcId,
        action: 'client_' + actionType,
        new_value: updates.status || null,
        note: actionNote,
        source: 'client_view'
      })
    });

    return res.status(200).json({ success: true, updates });

  } catch (err) {
    console.error('client-action error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
