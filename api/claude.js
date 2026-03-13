// Vercel Serverless Function: Claude API Proxy
// Validates Supabase JWT, then proxies to Anthropic API with server-side key

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Extract and validate Supabase JWT
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.replace('Bearer ', '');

  // Verify the JWT by calling Supabase Auth
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing Supabase credentials' });
  }

  try {
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': serviceRoleKey
      }
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Token validation failed' });
  }

  // 2. Proxy to Claude API
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (!claudeKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing Claude API key' });
  }

  const { model, max_tokens, system, messages, tools } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages required' });
  }

  try {
    const body = {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 2048,
      messages
    };
    if (system) body.system = system;
    if (tools) body.tools = tools;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await claudeResp.json();
    return res.status(claudeResp.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Claude API request failed: ' + e.message });
  }
}
