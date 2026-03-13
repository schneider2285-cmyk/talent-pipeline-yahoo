// Vercel Serverless Function: Admin-only User Invite
// Validates caller is admin, then invites user via Supabase Auth

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // 1. Get the calling user
  let callerUser;
  try {
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': serviceRoleKey }
    });
    if (!userResp.ok) return res.status(401).json({ error: 'Invalid token' });
    callerUser = await userResp.json();
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  // 2. Check caller is admin
  try {
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${callerUser.id}&select=role`,
      { headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` } }
    );
    const profiles = await profileResp.json();
    if (!profiles[0] || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to check admin status' });
  }

  // 3. Invite the user
  const { email, full_name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const inviteResp = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        email,
        data: { full_name: full_name || '' }
      })
    });

    const result = await inviteResp.json();
    if (!inviteResp.ok) {
      return res.status(inviteResp.status).json({ error: result.msg || result.message || 'Invite failed' });
    }

    return res.status(200).json({ success: true, message: 'Invitation sent to ' + email });
  } catch (e) {
    return res.status(500).json({ error: 'Invite request failed: ' + e.message });
  }
}
