// Vercel Serverless Function: Client Data API
// Validates share token + email, returns share metadata + candidates
// Uses direct Supabase PostgREST API (no SDK dependency)

// Resolve avatar URL from a Toptal profile link by scraping og:image
async function resolveAvatar(profileLink) {
  if (!profileLink) return null;
  try {
    const resp = await fetch(profileLink, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TalentPipeline/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // Look for og:image meta tag
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch && ogMatch[1]) return ogMatch[1];
    // Fallback: look for profile image in common patterns
    const imgMatch = html.match(/<img[^>]+class="[^"]*(?:profile|avatar|photo)[^"]*"[^>]+src="([^"]+)"/i)
      || html.match(/<img[^>]+src="(https:\/\/[^"]+(?:photo|avatar|profile)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (imgMatch && imgMatch[1]) return imgMatch[1];
    return null;
  } catch (e) {
    return null; // Timeout or network error — skip
  }
}

// Cache resolved avatar_url back to the candidates table
async function cacheAvatar(supabaseUrl, headers, candidateId, avatarUrl) {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/candidates?id=eq.${candidateId}`,
      { method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify({ avatar_url: avatarUrl }) }
    );
  } catch (e) { /* best effort */ }
}

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
      jcUrl = `${supabaseUrl}/rest/v1/job_candidates?id=in.(${jcIdFilter})&job_id=in.(${jobIdFilter})&select=*,candidates(*)`;
    } else {
      jcUrl = `${supabaseUrl}/rest/v1/job_candidates?job_id=in.(${jobIdFilter})&select=*,candidates(*)`;
    }
    const jcResp = await fetch(jcUrl, { headers });
    if (!jcResp.ok) {
      const errText = await jcResp.text();
      return res.status(500).json({ error: 'DB query failed for candidates', detail: errText });
    }
    const jcData = await jcResp.json();

    // 5. Resolve missing avatars from Toptal profiles (parallel, max 5 at a time)
    const needsAvatar = (jcData || []).filter(jc => {
      const cand = jc.candidates || {};
      return cand.profile_link && !cand.avatar_url;
    });

    if (needsAvatar.length > 0) {
      const toResolve = needsAvatar.slice(0, 5); // Limit to 5 per request
      const avatarResults = await Promise.allSettled(
        toResolve.map(async (jc) => {
          const cand = jc.candidates;
          const avatarUrl = await resolveAvatar(cand.profile_link);
          if (avatarUrl) {
            cand.avatar_url = avatarUrl;
            // Cache in DB for future requests (fire and forget)
            cacheAvatar(supabaseUrl, headers, cand.id, avatarUrl);
          }
          return { candidateId: cand.id, avatarUrl };
        })
      );
    }

    // 6. Group candidates by job
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
        avatar_url: cand.avatar_url || null,
        submission_notes: jc.submission_notes || null,
        status: jc.status,
        date_introduced: jc.date_introduced,
        date_interview: jc.date_interview,
        client_viewed_at: jc.client_viewed_at,
        client_feedback: jc.client_feedback,
        client_action_at: jc.client_action_at,
        interview_notes: jc.interview_notes
      });
    });

    // 7. Return
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
