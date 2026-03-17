// Vercel Serverless Function: Admin User Management
// POST: Create new user with email/password
// DELETE: Remove a user

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`
  };

  // 1. Validate caller token
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
      { headers: serviceHeaders }
    );
    const profiles = await profileResp.json();
    if (!profiles[0] || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to check admin status' });
  }

  // ─── POST: Create new user ───
  if (req.method === 'POST') {
    const { email, full_name, password, role } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const userRole = (role === 'admin') ? 'admin' : 'member';

    try {
      // Create user via Supabase Admin API
      const createResp = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: full_name || '' }
        })
      });

      const result = await createResp.json();
      if (!createResp.ok) {
        return res.status(createResp.status).json({
          error: result.msg || result.message || result.error_description || 'Failed to create user'
        });
      }

      // Update profile role if admin (trigger creates profile as 'member' by default)
      if (userRole === 'admin' && result.id) {
        // Small delay to let the trigger create the profile
        await new Promise(r => setTimeout(r, 500));
        await fetch(
          `${supabaseUrl}/rest/v1/profiles?id=eq.${result.id}`,
          {
            method: 'PATCH',
            headers: { ...serviceHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ role: 'admin', full_name: full_name || '' })
          }
        );
      }

      return res.status(200).json({ success: true, message: 'User created: ' + email });
    } catch (e) {
      return res.status(500).json({ error: 'Create user failed: ' + e.message });
    }
  }

  // ─── DELETE: Remove user ───
  if (req.method === 'DELETE') {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    // Prevent self-deletion
    if (user_id === callerUser.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    try {
      // Delete from Supabase Auth (cascades to profiles via FK)
      const delResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user_id}`, {
        method: 'DELETE',
        headers: serviceHeaders
      });

      if (!delResp.ok) {
        const err = await delResp.json().catch(() => ({}));
        return res.status(delResp.status).json({
          error: err.msg || err.message || 'Failed to delete user'
        });
      }

      return res.status(200).json({ success: true, message: 'User removed' });
    } catch (e) {
      return res.status(500).json({ error: 'Delete user failed: ' + e.message });
    }
  }
}
