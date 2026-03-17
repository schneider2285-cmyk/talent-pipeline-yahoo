// Vercel Serverless Function: Client Data API
// Validates share token + email, returns share metadata + candidates
// Uses direct Supabase PostgREST API (no SDK dependency)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.query.token;
  const email = (req.query.email || '').toLowerCase().trim();

  if (!token || !email) {
    return res.status(400).json({ error: 'Token and email are required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing env vars' });
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Validate share token
    const shareResp = await fetch(
      `${supabaseUrl}/rest/v1/client_shares?token=eq.${encodeURIComponent(token)}&is_active=eq.true&select=*`,
      { headers }
    );
    if (!shareResp.ok) {
      // Invalid UUID format or other DB error — treat as not found
      return res.status(404).json({ error: 'Share not found or inactive' });
    }
    const shares = await shareResp.json();

    if (!shares || shares.length === 0) {
      return res.status(404).json({ error: 'Share not found or inactive' });
    }
    const share = shares[0];

    // 2. Validate email
    const allowed = (share.allowed_emails || []).map(e => e.toLowerCase().trim());
    if (!allowed.includes(email)) {
      return res.status(403).json({ error: 'Email not recognized for this share' });
    }

    // 3. Fetch jobs for this share
    const jobIds = share.job_ids || [];
    if (jobIds.length === 0) {
      return res.status(200).json({
        share: { project_name: share.project_name, bu: share.bu, client_logo_url: share.client_logo_url },
        jobs: []
      });
    }

    // PostgREST in filter: in.(val1,val2,val3) — no quotes needed for UUIDs
    const jobIdFilter = jobIds.join(',');
    const jobsResp = await fetch(
      `${supabaseUrl}/rest/v1/jobs?id=in.(${jobIdFilter})&select=*`,
      { headers }
    );
    if (!jobsResp.ok) {
      const errText = await jobsResp.text();
      return res.status(500).json({ error: 'DB query failed for jobs', detail: errText });
    }
    const jobs = await jobsResp.json();

    // 4. Fetch job_candidates with candidate details for these jobs
    // If share has job_candidate_ids, only return those specific candidates (handpicked)
    const jcIds = share.job_candidate_ids || [];
    let jcUrl;
    if (jcIds.length > 0) {
      const jcIdFilter = jcIds.join(',');
      jcUrl = `${supabaseUrl}/rest/v1/job_candidates?id=in.(${jcIdFilter})&job_id=in.(${jobIdFilter})&select=*,candidates(id,name,profile_link,location,rate)`;
    } else {
      jcUrl = `${supabaseUrl}/rest/v1/job_candidates?job_id=in.(${jobIdFilter})&select=*,candidates(id,name,profile_link,location,rate)`;
    }
    const jcResp = await fetch(jcUrl, { headers });
    if (!jcResp.ok) {
      const errText = await jcResp.text();
      return res.status(500).json({ error: 'DB query failed for candidates', detail: errText });
    }
    const jcData = await jcResp.json();

    // 5. Group candidates by job
    const jobMap = {};
    (jobs || []).forEach(j => {
      jobMap[j.id] = {
        id: j.id,
        role_title: j.role_title,
        openings: j.openings || 1,
        candidates: []
      };
    });

    (jcData || []).forEach(jc => {
      if (!jobMap[jc.job_id]) return;
      const cand = jc.candidates || {};
      jobMap[jc.job_id].candidates.push({
        jc_id: jc.id,
        candidate_id: jc.candidate_id,
        name: cand.name || 'Unknown',
        profile_link: cand.profile_link || null,
        location: cand.location || null,
        avatar_url: null,
        notes: null,
        status: jc.status,
        date_introduced: jc.date_introduced,
        date_interview: jc.date_interview,
        client_viewed_at: jc.client_viewed_at,
        client_feedback: jc.client_feedback,
        client_action_at: jc.client_action_at,
        interview_notes: jc.interview_notes
      });
    });

    // 6. Return
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
    return res.status(500).json({ error: 'Internal server error', detail: err.message || String(err) });
  }
}
