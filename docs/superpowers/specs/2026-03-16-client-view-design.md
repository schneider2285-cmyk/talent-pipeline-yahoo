# Client View — Design Spec

## Overview

A secured, shareable page where clients review candidates presented for their open roles. Clients can view candidate cards, request interviews, pass on candidates with feedback, and track interview progress through a pipeline board. All actions sync back to the internal talent pipeline tool in real time.

## Access Model

- **Email gate**: Admin enters client email(s) when creating a share. Client accesses via unique URL, enters their email address (must match an allowed email), and gains access. No passwords or verification codes.
- **Session persistence**: After successful email verification, the email is stored in `localStorage` keyed by the share token (`cv_email_<token>`). On subsequent visits, the stored email is sent with every API call. Client can click "Not you?" to clear and re-enter.
- **Share scope**: Per-project, with specific roles selected. A single share link covers all selected roles within one project.
- **Token-based URLs**: Each share generates a unique token (UUID). URL format: `/client?token=<uuid>`.
- **Deactivation**: Admin can revoke a share at any time from the main tool.

## Creating a Client View (Admin Side)

- **"Create Client View" button** on each project header in the Pipeline tab.
- Clicking opens a modal/form:
  - Checkboxes to select which roles to include
  - Text input for client email addresses (comma-separated)
  - Optional client logo URL field
  - "Generate Link" button
- On submit: creates a `client_shares` row, returns the shareable URL.
- Share link appears on the project header as a small link icon after creation.

## Client View Page Layout

### Branding & Header

- **Font**: Figtree (400, 600, 700, 800 weights) via Google Fonts. This is intentionally different from the main app (DM Sans + Fraunces) — the client view uses Toptal's brand font for a cohesive client-facing experience.
- **Primary blue**: `#204ECF` (Toptal brand)
- **Navy**: `#262D3D` (Toptal brand)
- **Header**: `[Toptal Logo PNG] x [Client Logo]` left-aligned, BU pill + Project pill right-aligned
- **Toptal logo**: sourced from `toptal-logo.png` stored locally in `/public/assets/`
- **Client logo**: configurable per client (stored as URL in `client_shares.client_logo_url`, fallback to client name text)
- **Border accent**: 2px `#204ECF` bottom border on header

### Per-Role Sections

Each selected role renders as a section with:
- Role title and opening count
- Candidate count

### Candidate Cards (3 states)

**1. New / Unreviewed**
- White card, `#D1D5DE` border
- Amber "NEW" ribbon banner (top-right, folded edge)
- Candidate headshot (from `avatar_url` field on `candidates` table, 64-72px circle, amber border for new)
- Name, location, availability (FT/PT + hours)
- "Added [date]" timestamp (from `job_candidates.date_introduced`)
- Skill tags (colored pills)
- Short bio/summary (from `candidates.notes` or `candidates.profile_summary`)
- Action buttons: "More Info" | "Request Interview" (Toptal blue `#204ECF`) | "Pass" (red) | "Profile →" link (opens `candidates.profile_link` in new tab)

**2. Expanded / Reviewed**
- Blue border (`#204ECF`), elevated shadow
- Everything from collapsed state, plus:
- "Why this candidate fits" panel: 2x2 grid showing role-relevant details (certs, cloud platforms, timezone, availability)
- Larger "Request Interview" CTA button
- "Pass" button and "Profile →" link

**3. Passed / Rejected**
- 65% opacity, greyed out
- Name strikethrough, photo desaturated (CSS `grayscale(50%)`)
- Red "PASSED" badge
- Client feedback displayed in red-tinted panel below
- Collapsed into a "Passed Candidates (N)" section at the bottom

### Awaiting Action Highlight

- Candidates unreviewed for 3+ days (based on `date_introduced` vs current date, and `client_viewed_at` is null) get:
  - Amber border (`#F59E0B`)
  - Amber gradient bar at top: "Awaiting your review — added N days ago"
  - Sorted to top of the review section (oldest first)

### Interview Request Flow

When client clicks "Request Interview":
- Inline modal appears with:
  - Candidate photo + name + role context
  - Two scheduling options side by side:
    - **Option A**: "Share Calendly Link" — text input for URL
    - **Option B**: "Share Your Availability" — textarea for free-text times
  - Optional "Additional notes" textarea
  - "Submit Interview Request" button (Toptal blue) + "Cancel"

### Pass/Reject Flow

When client clicks "Pass":
- Inline modal with:
  - Candidate photo + name + role context
  - "Feedback (optional but helps us find better matches)" textarea with placeholder examples
  - "Confirm Pass" button (red gradient) + "Cancel"

### Interview Pipeline Board

Below the candidate cards, a 4-column Kanban board. The pipeline board is **read-only for the client** — stage progression is admin-only. The board reflects current status so clients can track where their candidates stand.

| 1st Interview | 2nd Interview | Pending Decision | Hired |
|---|---|---|---|
| Blue bg `#E8EEFB` | Purple bg `#F5F3FF` | Amber bg `#FFFBEB` | Green bg `#F0FDF4` |

Each column shows:
- Column header with colored dot, label, and count badge
- Mini candidate cards: headshot (32px), name, location, scheduled date, skill tags
- Empty state: "No candidates yet"

### Error & Empty States

- **Invalid/deactivated token**: "This link is no longer active. Please contact your Toptal representative."
- **Email not recognized**: "We don't have that email on file for this project. Please check with your Toptal representative." (No indication of which emails are valid, to prevent enumeration.)
- **API error**: Toast-style error message at top of page with retry option.
- **No candidates yet**: "No candidates have been presented yet. We'll notify you when candidates are ready for review."
- **Loading**: Skeleton card placeholders while data fetches.

## Status Mapping

The client view maps to existing statuses in the codebase. The `normalizeStatus` function and `STATUS_MAP` in `index.html` already handle these values.

| Client Action | DB Status Value Written | Existing STATUS_MAP Key |
|---|---|---|
| Client views candidate | No status change (sets `client_viewed_at` only) | — |
| Client requests interview | `interview_scheduled` | `interview_scheduled` (already exists) |
| Client passes on candidate | `client_rejected` | `client_rejected` (already exists in codebase) |
| Admin moves to 2nd interview | `pending_2nd_interview` | `pending_2nd_interview` (already exists) |
| Admin moves to pending decision | `pending_decision` | `pending_decision` (already exists) |
| Admin marks as hired | `hired` | `hired` (already exists) |

**Pipeline board column → status mapping:**

| Board Column | Status Values |
|---|---|
| 1st Interview | `interview_scheduled` |
| 2nd Interview | `pending_2nd_interview` |
| Pending Decision | `pending_decision` |
| Hired | `hired` |

No new status values are introduced. All client actions use existing statuses.

## Data Model

### New Table: `client_shares`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `token` | uuid (unique) | URL token for access |
| `project_name` | text | Project this share covers. Note: projects are denormalized labels on jobs, not a separate table. If a project is renamed, shares must be manually updated. |
| `bu` | text | Business unit |
| `job_ids` | uuid[] | Array of job IDs included in this share |
| `allowed_emails` | text[] | Client email addresses allowed to access |
| `client_logo_url` | text | Optional client logo URL |
| `created_by` | uuid (FK → auth.users) | Admin who created the share |
| `created_at` | timestamptz | Creation timestamp |
| `updated_at` | timestamptz | Last modification timestamp |
| `is_active` | boolean | Can be deactivated to revoke access |

### New Columns on `job_candidates`

| Column | Type | Description |
|---|---|---|
| `client_viewed_at` | timestamptz | When client first clicked "More Info" |
| `client_feedback` | text | Feedback text from client when passing |
| `client_action_at` | timestamptz | Last client action timestamp |
| `interview_notes` | text | Calendly link or availability text from client's interview request |

Note: The existing `date_interview` field on `job_candidates` continues to be used for the interview date. `interview_notes` stores the client's scheduling preferences/link. The admin sets `date_interview` when the interview is actually confirmed.

### New Table: `client_actions_log`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `share_id` | uuid (FK → client_shares) | Which share this action belongs to |
| `job_candidate_id` | uuid (FK → job_candidates) | Which candidate |
| `action_type` | text | `viewed`, `interview_requested`, `passed` |
| `action_data` | jsonb | Additional data (feedback text, scheduling info, etc.) |
| `actor_email` | text | Client email who performed the action |
| `created_at` | timestamptz | When the action occurred |

## Data Flow: Client Action → Pipeline

| Client Action | DB Update | Pipeline UI Effect |
|---|---|---|
| Views candidate (More Info) | `client_viewed_at` set on `job_candidates` | NEW banner removed on client view; "Client viewed [date]" shown on candidate row in main app |
| Requests Interview | Status → `interview_scheduled`; `interview_notes` populated | Status badge turns blue. Role fulfillment bar "Interview" count increases. Activity log entry: "Client requested interview with [name]" |
| Passes on candidate | Status → `client_rejected`; `client_feedback` populated | Status badge turns red with "Client Passed" label. Feedback visible in expandable row. Sourcing alert triggers if no viable candidates remain. |
| Admin moves through stages | Status → `pending_2nd_interview` / `pending_decision` / `hired` | Pipeline board updates on client view. Fulfillment bar recalculates. Opening count decreases on hire. |

## API Architecture

### `api/client-data.js` — GET endpoint (data retrieval)

Called when client page loads and after each action to refresh.

- **Input**: `token` (query param), `email` (query param or header)
- **Validation**: Verifies token exists, share is active, email is in `allowed_emails`
- **Returns**: Share metadata (project, BU, client logo) + jobs with candidates and current statuses
- **Auth**: Uses `SUPABASE_SERVICE_ROLE_KEY` to query DB (no JWT — client has no Supabase account)

### `api/client-action.js` — POST endpoint (client actions)

Called when client views, requests interview, or passes on a candidate.

- **Input**: `token`, `email`, `action_type`, `job_candidate_id`, `action_data` (JSON body)
- **Validation**:
  1. Verify token exists and share is active
  2. Verify email is in `allowed_emails`
  3. Verify `job_candidate_id` belongs to a job in the share's `job_ids` array
- **Actions**: Updates `job_candidates` status/fields, inserts into `client_actions_log`, calls `logActivity`
- **Auth**: Uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS)

## File Architecture

| File | Purpose |
|---|---|
| `public/client.html` | Client-facing page (standalone HTML, no auth required beyond email gate) |
| `public/assets/toptal-logo.png` | Local copy of Toptal logo |
| `public/index.html` | Main app — add "Create Client View" button + modal on project headers |
| `api/client-data.js` | Vercel serverless function — validates token/email, returns share data + candidates |
| `api/client-action.js` | Vercel serverless function — handles client actions (view, interview request, pass). Validates token + email + job_id scope on every request. |
| `vercel.json` | Add rewrite rule: `{ "source": "/client", "destination": "/client.html" }` BEFORE the catch-all `/(.*) → /index.html` rule |
| `supabase-setup.sql` | Add `client_shares` table, `client_actions_log` table, new columns on `job_candidates` |

## Security

- **Share tokens**: UUIDs — cryptographically unguessable (122 bits of entropy)
- **Email validation**: Must match `allowed_emails` on every API request (not just the initial gate)
- **Job scope enforcement**: `api/client-action.js` verifies that the target `job_candidate_id` belongs to a job in the share's `job_ids` before allowing any write
- **No RLS dependency**: Since the client has no Supabase JWT, both API endpoints use `SUPABASE_SERVICE_ROLE_KEY`. All authorization logic lives in the serverless functions, not in RLS policies.
- **Deactivation**: Admin can set `is_active = false` to immediately revoke access
- **Email enumeration protection**: Invalid emails get a generic "email not recognized" message with no hints about valid addresses
- **Rate limiting**: Vercel's built-in rate limiting applies. Application-level rate limiting is deferred to v2 if abuse is observed.
- **No sensitive data exposure**: Client page only shows candidate name, location, skills, bio, and avatar — no internal notes, rates, or pipeline-internal fields

## Responsive Design

- 2-column card grid on desktop, collapses to 1 column on mobile
- Pipeline board scrolls horizontally on mobile
- All touch targets minimum 44px for mobile usability
