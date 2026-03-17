# Client View Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secured, shareable client-facing page where clients review candidates, request interviews, and pass on candidates — with all actions syncing back to the internal pipeline tool.

**Architecture:** New standalone `client.html` page accessed via token-based URL with email gate. Two new Vercel serverless functions (`client-data.js`, `client-action.js`) handle data retrieval and client actions using `SUPABASE_SERVICE_ROLE_KEY`. Admin-side UI changes in `index.html` add a "Create Client View" button on project headers. New DB tables `client_shares` and `client_actions_log`, plus new columns on `job_candidates`.

**Tech Stack:** Supabase (PostgreSQL), Vercel serverless functions (Node.js), vanilla HTML/CSS/JS (single-file architecture), Figtree font (Google Fonts)

**Spec:** `docs/superpowers/specs/2026-03-16-client-view-design.md`

**Security note:** The client.html page uses innerHTML for rendering dynamic content. All user-provided strings (names, feedback, etc.) come from the server via our own API endpoints which pull from Supabase. The data is not raw user input from URL params. For defense-in-depth, all string interpolation should use a helper function that escapes HTML entities (`&`, `<`, `>`, `"`, `'`). This is implemented in the escapeHtml() helper in client.html.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `supabase-setup.sql` | Modify | Add `client_shares` table, `client_actions_log` table, new columns on `job_candidates` |
| `vercel.json` | Modify | Add `/client` rewrite before catch-all |
| `api/client-data.js` | Create | GET endpoint: validate token+email, return share metadata + candidates |
| `api/client-action.js` | Create | POST endpoint: handle view/interview-request/pass actions |
| `public/client.html` | Create | Standalone client-facing page (email gate + candidate cards + pipeline board) |
| `public/assets/toptal-logo.png` | Create | Local copy of Toptal logo |
| `public/index.html` | Modify | Add "Create Client View" button + modal on project headers, add `client_rejected` to STATUS_MAP |

---

## Chunk 1: Database & Routing Foundation

### Task 1: Database Schema Updates

**Files:**
- Modify: `supabase-setup.sql`

- [ ] **Step 1: Add `client_shares` table SQL**

Append to end of `supabase-setup.sql`:

```sql
-- Client View Tables

CREATE TABLE IF NOT EXISTS client_shares (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  project_name TEXT NOT NULL,
  bu TEXT NOT NULL,
  job_ids UUID[] NOT NULL DEFAULT '{}',
  allowed_emails TEXT[] NOT NULL DEFAULT '{}',
  client_logo_url TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_client_shares_token ON client_shares(token);
CREATE INDEX idx_client_shares_active ON client_shares(is_active) WHERE is_active = TRUE;
```

- [ ] **Step 2: Add `client_actions_log` table SQL**

Append after `client_shares`:

```sql
CREATE TABLE IF NOT EXISTS client_actions_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  share_id UUID REFERENCES client_shares(id),
  job_candidate_id UUID REFERENCES job_candidates(id),
  action_type TEXT NOT NULL,
  action_data JSONB DEFAULT '{}',
  actor_email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_client_actions_share ON client_actions_log(share_id);
```

- [ ] **Step 3: Add new columns to `job_candidates`**

Append after the actions log:

```sql
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_viewed_at TIMESTAMPTZ;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_feedback TEXT;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS client_action_at TIMESTAMPTZ;
ALTER TABLE job_candidates ADD COLUMN IF NOT EXISTS interview_notes TEXT;
```

- [ ] **Step 4: Run the new SQL in Supabase**

Run the SQL from Steps 1-3 in the Supabase SQL Editor at:
`https://supabase.com/dashboard/project/jbbjofdkbkymiqmlylcy/sql`

Copy and paste the new SQL statements and execute. Verify tables were created with:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('client_shares', 'client_actions_log');
```

Expected: 2 rows returned.

- [ ] **Step 5: Commit**

```bash
git add supabase-setup.sql
git commit -m "feat: add client_shares and client_actions_log tables, new job_candidates columns"
```

---

### Task 2: Vercel Routing Update

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add `/client` rewrite before catch-all**

In `vercel.json`, the `rewrites` array currently has 2 entries. Insert a new entry between them so `/client` routes to `/client.html` instead of the SPA catch-all.

Change from:
```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "/api/$1" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```

To:
```json
"rewrites": [
  { "source": "/api/(.*)", "destination": "/api/$1" },
  { "source": "/client", "destination": "/client.html" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: add /client route for client view page"
```

---

### Task 3: Client Data API Endpoint

**Files:**
- Create: `api/client-data.js`

Reference existing API pattern: `api/claude.js` uses `createClient` from `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Create `api/client-data.js`**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/client-data.js
git commit -m "feat: add client-data API endpoint for share validation and data retrieval"
```

---

### Task 4: Client Action API Endpoint

**Files:**
- Create: `api/client-action.js`

- [ ] **Step 1: Create `api/client-action.js`**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add api/client-action.js
git commit -m "feat: add client-action API endpoint for interview requests and passes"
```

---

## Chunk 2: Client-Facing Page

### Task 5: Download Toptal Logo Asset

**Files:**
- Create: `public/assets/toptal-logo.png`

- [ ] **Step 1: Create assets directory and download logo**

```bash
mkdir -p public/assets
curl -L -o public/assets/toptal-logo.png "https://www.toptal.com/toptal-logo.png"
```

- [ ] **Step 2: Commit**

```bash
git add public/assets/toptal-logo.png
git commit -m "feat: add Toptal logo asset for client view"
```

---

### Task 6: Client View HTML Page

**Files:**
- Create: `public/client.html`

This is the core client-facing page. It is a standalone HTML file with embedded CSS and JS. Key architecture:

- **Email gate** — overlay that validates email against the share's allowed_emails via `/api/client-data`
- **Session persistence** — email stored in localStorage keyed by token (`cv_email_<token>`)
- **Candidate cards** — 3 states: new/unreviewed, expanded/reviewed, passed/rejected
- **Pipeline board** — 4-column Kanban (read-only for client)
- **Modals** — interview request and pass confirmation
- **All dynamic rendering** uses an `escapeHtml()` helper to sanitize strings before insertion

- [ ] **Step 1: Create `public/client.html`**

Create the full client.html file. The file structure is:

1. `<head>` — Figtree font import, full CSS (email gate, cards, pipeline board, modals, responsive)
2. `<body>` HTML structure:
   - `#errorPage` — error display (hidden by default)
   - `#gateOverlay` — email gate form
   - `#cvPage` — main content area (populated by JS)
   - `#modalOverlay` — modal container
   - `#cvToast` — toast notifications
3. `<script>` — all JS logic:
   - `escapeHtml(str)` — HTML entity escaper for XSS prevention
   - `verifyEmail()` — gate validation via `/api/client-data`
   - `loadShareData()` — data refresh
   - `renderPage()` — builds all sections
   - `renderRole(job)` — per-role section with cards + pipeline
   - `renderCard(c, job)` — individual candidate card
   - `renderPassedCard(c)` — greyed-out passed card
   - `renderPipelineBoard(candidates)` — 4-column Kanban
   - `callAction(type, jcId, data)` — POST to `/api/client-action`
   - `showInterviewModal(jcId)` / `showPassModal(jcId)` — modal rendering
   - `submitInterview(jcId)` / `submitPass(jcId)` — action submission

Key CSS classes (from spec mockups):
- `.cv-card`, `.cv-card.awaiting`, `.cv-card.expanded`, `.cv-card.passed-card`
- `.cv-new-banner`, `.cv-new-ribbon`, `.cv-new-fold`
- `.cv-awaiting-bar`
- `.cv-pipeline-board`, `.cv-pipeline-col`, `.cv-mini-card`
- `.cv-modal-overlay`, `.cv-modal`
- `.cv-btn-primary` (background: #204ECF), `.cv-btn-danger` (red)

Brand colors: `#204ECF` (primary blue), `#262D3D` (navy), `#D1D5DE` (borders), `#F7F8FA` (page bg)

All data-bound strings (candidate names, locations, feedback, notes) MUST be passed through `escapeHtml()` before insertion into HTML strings. The `escapeHtml` function replaces `&`, `<`, `>`, `"`, and `'` with their HTML entity equivalents.

The complete file should be approximately 500-600 lines of HTML/CSS/JS. Reference the mockup files in `.superpowers/brainstorm/46444-1773703908/` for exact visual treatment.

- [ ] **Step 2: Commit**

```bash
git add public/client.html
git commit -m "feat: add client view page with email gate, candidate cards, pipeline board, and action modals"
```

---

## Chunk 3: Admin-Side Integration

### Task 7: Add `client_rejected` Status to Main App

**Files:**
- Modify: `public/index.html` (~line 1878, STATUS_MAP)

- [ ] **Step 1: Add `client_rejected` to STATUS_MAP**

Find the STATUS_MAP object (around line 1878) and add after the `rejected` entry:

```javascript
'client_rejected': { cls: 'status-rejected', color: '#EF4444', label: 'Client Passed', dbValue: 'CLIENT REJECTED', actionLabel: 'Client Passed', actionClass: 'action-rejected' },
```

- [ ] **Step 2: Add `client_rejected` to normalizeStatus**

Find the `normalizeStatus` function (around line 1851). Add this case in the mapping:

```javascript
case 'CLIENT REJECTED': return 'client_rejected';
```

- [ ] **Step 3: Add `client_rejected` to dead-end statuses check**

Find the `deadStatuses` Set (around line 2816) and add `'client_rejected'`:

```javascript
var deadStatuses = new Set(['rejected', 'client_rejected', 'withdrawn', 'unavailable', 'removed_location', 'on_hold', 'consider_other']);
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add client_rejected status to STATUS_MAP and normalizeStatus"
```

---

### Task 8: Add "Create Client View" Button & Modal

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add CSS for client view share modal**

Find the end of the `<style>` block in index.html. Add styles for the share modal:
- `.cv-share-modal-overlay` — fixed overlay with backdrop
- `.cv-share-modal` — white card with padding, max-width 500px
- `.cv-share-modal h3` — title
- `.cv-share-modal label` — form labels
- `.cv-share-modal input` — form inputs
- `.role-checks` / `.role-check` — checkbox list for roles
- `.cv-share-result` — green success box with link input
- `.cv-share-btn` — blue generate button (#204ECF)
- `.cv-share-btn-cancel` — outline cancel button

- [ ] **Step 2: Add "Client View" button to project headers**

Find the project header rendering in `renderPipelineView()` (around line 2922-2940, where `bu-actions` div contains "Add Job" and "Add Candidate" buttons). After the "Add Candidate" button, add a third button:

```html
<button class="bu-action-btn" data-proj-client-view="[projectName]"
  style="background:#204ECF; color:white; border:none;">
  Client View
</button>
```

- [ ] **Step 3: Add `showClientViewModal()` function**

Add near `logActivity()` (~line 4200). This function:
1. Filters `FULFILLMENT_DATA` for jobs matching the project name
2. Renders a modal with:
   - Role checkboxes (all checked by default)
   - Email input (comma-separated)
   - Optional client logo URL input
   - "Generate Link" button
   - Result area showing the share URL
3. On generate: inserts into `client_shares` via Supabase client, displays URL

- [ ] **Step 4: Add `createClientShare()` function**

This function:
1. Reads checked role checkboxes to get job_ids array
2. Parses comma-separated emails
3. Inserts into `client_shares` table
4. Shows the resulting share URL in the result area
5. Logs activity via `logActivity()`

- [ ] **Step 5: Add event listener for Client View button**

Find the event delegation section (search for `data-proj-add-job` click handler). Add a matching handler:

```javascript
if (event.target.matches('[data-proj-client-view]')) {
  var projName = event.target.getAttribute('data-proj-client-view');
  showClientViewModal(projName);
}
```

- [ ] **Step 6: Update `loadFulfillmentData` to include new columns**

Find `loadFulfillmentData()` (~line 2225). In the candidate mapping loop (~line 2272-2287), add the new fields:

```javascript
client_viewed_at: jc.client_viewed_at || null,
client_feedback: jc.client_feedback || null,
client_action_at: jc.client_action_at || null,
interview_notes: jc.interview_notes || null,
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: add Create Client View button and modal on project headers"
```

---

### Task 9: Deploy & End-to-End Verification

- [ ] **Step 1: Push to GitHub for Vercel auto-deploy**

```bash
git push origin main
```

- [ ] **Step 2: Verify routing**

Visit `https://talent-pipeline-bay.vercel.app/client?token=test` — should show the email gate page (with error since token is fake, but the page should load).

- [ ] **Step 3: Verify DB tables**

In Supabase SQL Editor, run:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('client_shares', 'client_actions_log');
```

Expected: 2 rows returned.

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'job_candidates'
AND column_name IN ('client_viewed_at', 'client_feedback', 'client_action_at', 'interview_notes');
```

Expected: 4 rows returned.

- [ ] **Step 4: End-to-end test**

1. Open main app Pipeline tab, expand a project
2. Click "Client View" button on project header
3. Check roles to share, enter a test email, click "Generate Link"
4. Copy the link, open in a new incognito/private window
5. Enter the test email at the gate — should see candidate cards
6. Click "More Info" on a candidate — NEW banner should disappear on reload
7. Click "Request Interview" — fill in availability — submit — candidate should move to pipeline board
8. Click "Pass" on another candidate — add feedback — confirm — candidate should appear in passed section
9. Go back to main app — verify candidate statuses changed ("Interview Scheduled" and "Client Passed")
10. Verify activity log entries were created

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any issues found during e2e testing"
```
