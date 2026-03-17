const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var token = req.query.token;
  var email = (req.query.email || '').toLowerCase().trim();

  if (!token || !email) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  var sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Validate share token
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
      return res.status(403).json({ error: 'Email not recognized for this share' });
    }

    // 3. Fetch jobs for this share
    var { data: jobs, error: jobsErr } = await sb
      .from('jobs')
      .select('*')
      .in('id', share.job_ids);

    if (jobsErr) throw jobsErr;

    // 4. Fetch candidates for these jobs
    var { data: jcData, error: jcErr } = await sb
      .from('job_candidates')
      .select('*, candidates(id, name, profile_link, location, avatar_url, notes)')
      .in('job_id', share.job_ids);

    if (jcErr) throw jcErr;

    // 5. Group candidates by job
    var jobMap = {};
    (jobs || []).forEach(function(j) {
      jobMap[j.id] = {
        id: j.id,
        role_title: j.role_title,
        openings: j.openings || 1,
        candidates: []
      };
    });

    (jcData || []).forEach(function(jc) {
      if (!jobMap[jc.job_id]) return;
      jobMap[jc.job_id].candidates.push({
        jc_id: jc.id,
        candidate_id: jc.candidate_id,
        name: jc.candidates ? jc.candidates.name : 'Unknown',
        profile_link: jc.candidates ? jc.candidates.profile_link : null,
        location: jc.candidates ? jc.candidates.location : null,
        avatar_url: jc.candidates ? jc.candidates.avatar_url : null,
        notes: jc.candidates ? jc.candidates.notes : null,
        status: jc.status,
        date_introduced: jc.date_introduced,
        date_interview: jc.date_interview,
        client_viewed_at: jc.client_viewed_at,
        client_feedback: jc.client_feedback,
        client_action_at: jc.client_action_at,
        interview_notes: jc.interview_notes
      });
    });

    // 6. Return share metadata + jobs
    return res.status(200).json({
      share: {
        project_name: share.project_name,
        bu: share.bu,
        client_logo_url: share.client_logo_url
      },
      jobs: Object.values(jobMap)
    });

  } catch (err) {
    console.error('client-data error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
