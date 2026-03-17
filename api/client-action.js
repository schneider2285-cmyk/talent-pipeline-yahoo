const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var token = body.token;
  var email = (body.email || '').toLowerCase().trim();
  var actionType = body.action_type;
  var jcId = body.job_candidate_id;
  var actionData = body.action_data || {};

  if (!token || !email || !actionType || !jcId) {
    return res.status(400).json({ error: 'Missing required fields: token, email, action_type, job_candidate_id' });
  }

  var validActions = ['viewed', 'interview_requested', 'passed'];
  if (validActions.indexOf(actionType) === -1) {
    return res.status(400).json({ error: 'Invalid action_type. Must be: ' + validActions.join(', ') });
  }

  var sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Validate share
    var { data: share, error: shareErr } = await sb
      .from('client_shares')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (shareErr || !share) {
      return res.status(404).json({ error: 'Share not found or inactive' });
    }

    // 2. Validate email
    var allowed = (share.allowed_emails || []).map(function(e) { return e.toLowerCase().trim(); });
    if (allowed.indexOf(email) === -1) {
      return res.status(403).json({ error: 'Email not recognized' });
    }

    // 3. Validate job_candidate belongs to a job in this share
    var { data: jc, error: jcErr } = await sb
      .from('job_candidates')
      .select('id, job_id, status')
      .eq('id', jcId)
      .single();

    if (jcErr || !jc) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    if ((share.job_ids || []).indexOf(jc.job_id) === -1) {
      return res.status(403).json({ error: 'Candidate not in scope for this share' });
    }

    // 4. Perform action
    var updates = { client_action_at: new Date().toISOString() };

    if (actionType === 'viewed') {
      // Only set client_viewed_at if not already set
      var { data: existing } = await sb
        .from('job_candidates')
        .select('client_viewed_at')
        .eq('id', jcId)
        .single();
      if (!existing || !existing.client_viewed_at) {
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
    var { error: updateErr } = await sb
      .from('job_candidates')
      .update(updates)
      .eq('id', jcId);

    if (updateErr) throw updateErr;

    // 6. Log the action
    await sb.from('client_actions_log').insert({
      share_id: share.id,
      job_candidate_id: jcId,
      action_type: actionType,
      action_data: actionData,
      actor_email: email
    });

    // 7. Log to activity_log (same format as main app)
    var actionNote = '';
    if (actionType === 'viewed') actionNote = 'Client viewed candidate';
    if (actionType === 'interview_requested') actionNote = 'Client requested interview';
    if (actionType === 'passed') actionNote = 'Client passed on candidate' + (actionData.feedback ? ': ' + actionData.feedback : '');

    await sb.from('activity_log').insert({
      entity_type: 'job_candidate',
      entity_id: jcId,
      action: 'client_' + actionType,
      new_value: updates.status || null,
      note: actionNote,
      source: 'client_view'
    });

    return res.status(200).json({ success: true, updates: updates });

  } catch (err) {
    console.error('client-action error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
