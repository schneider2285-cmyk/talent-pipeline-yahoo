// Vercel Serverless Function: Admin-only Role Update
// Allows admins to promote/demote team members

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

  // 1. Validate caller
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

  // 2. Verify caller is admin
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

  // 3. Update target user's role
  const { user_id, role } = req.body;
  if (!user_id || !role) return res.status(400).json({ error: 'user_id and role are required' });
  if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'Role must be admin or member' });

  // Prevent self-demotion
  if (user_id === callerUser.id && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot demote yourself' });
  }

  try {
    const updateResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ role, updated_at: new Date().toISOString() })
      }
    );

    const result = await updateResp.json();
    if (!updateResp.ok) {
      return res.status(updateResp.status).json({ error: 'Update failed' });
    }

    return res.status(200).json({ success: true, profile: result[0] });
  } catch (e) {
    return res.status(500).json({ error: 'Role update failed: ' + e.message });
  }
}
