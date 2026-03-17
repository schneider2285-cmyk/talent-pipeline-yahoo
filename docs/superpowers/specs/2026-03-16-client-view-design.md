# Client View — Design Spec

## Overview

A secured, shareable page where clients review candidates presented for their open roles. Clients can view candidate cards, request interviews, pass on candidates with feedback, and track interview progress through a pipeline board. All actions sync back to the internal talent pipeline tool in real time.

## Access Model

- **Email gate**: Admin enters client email(s) when creating a share. Client accesses via unique URL, enters their email address (must match an allowed email), and gains access. No passwords or verification codes.
- **Share scope**: Per-project, with specific roles selected. A single share link covers all selected roles within one project.
- **Token-based URLs**: Each share generates a unique token (UUID). URL format: `/client?token=<uuid>`.
- **Deactivation**: Admin can revoke a share at any time from the main tool.

## Creating a Client View (Admin Side)

- **"Create Client View" button** on each project header in the Pipeline tab.
- Clicking opens a modal/form:
  - Checkboxes to select which roles to include
  - Text input for client email addresses (comma-separated)
  - "Generate Link" button
- On submit: creates a `client_shares` row, returns the shareable URL.
- Share link appears on the project header as a small link icon after creation.

## Client View Page Layout

### Branding & Header

- **Font**: Figtree (400, 600, 700, 800 weights) via Google Fonts
- **Primary blue**: `#204ECF` (Toptal brand)
- **Navy**: `#262D3D` (Toptal brand)
- **Header**: `[Toptal Logo PNG] x [Client Logo]` left-aligned, BU pill + Project pill right-aligned
- **Toptal logo**: sourced from `toptal-logo.png` stored locally
- **Client logo**: configurable per client (stored as URL in `client_shares` or fallback to text)
- **Border accent**: 2px `#204ECF` bottom border on header

### Per-Role Sections

Each selected role renders as a section with:
- Role title and opening count
- Candidate count

### Candidate Cards (3 states)

**1. New / Unreviewed**
- White card, `#D1D5DE` border
- Amber "NEW" ribbon banner (top-right, folded edge)
- Candidate headshot (from `avatar_url` field, 64-72px circle, amber border for new)
- Name, location, availability (FT/PT + hours)
- "Added [date]" timestamp
- Skill tags (colored pills)
- Short bio/summary
- Action buttons: "More Info" | "Request Interview" (Toptal blue `#204ECF`) | "Pass" (red) | "Profile →" link

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

- Candidates unreviewed for 3+ days get:
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

Below the candidate cards, a 4-column Kanban board:

| 1st Interview | 2nd Interview | Pending Decision | Hired |
|---|---|---|---|
| Blue bg `#E8EEFB` | Purple bg `#F5F3FF` | Amber bg `#FFFBEB` | Green bg `#F0FDF4` |

Each column shows:
- Column header with colored dot, label, and count badge
- Mini candidate cards: headshot (32px), name, location, scheduled date, skill tags
- Empty state: "No candidates yet"

Candidate cards move between columns as their status progresses.

## Data Model

### New Table: `client_shares`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `token` | uuid (unique) | URL token for access |
| `project_name` | text | Project this share covers |
| `bu` | text | Business unit |
| `job_ids` | uuid[] | Array of job IDs included in this share |
| `allowed_emails` | text[] | Client email addresses allowed to access |
| `client_logo_url` | text | Optional client logo URL |
| `created_by` | uuid (FK → users) | Admin who created the share |
| `created_at` | timestamptz | Creation timestamp |
| `is_active` | boolean | Can be deactivated to revoke access |

### New Columns on `job_candidates`

| Column | Type | Description |
|---|---|---|
| `client_viewed_at` | timestamptz | When client first clicked "More Info" |
| `client_feedback` | text | Feedback text from client when passing |
| `client_action_at` | timestamptz | Last client action timestamp |
| `interview_scheduled_at` | timestamptz | When interview was scheduled |
| `interview_notes` | text | Calendly link or availability text |

### New Table: `client_actions_log`

| Column | Type | Description |
|---|---|---|
| `id` | uuid (PK) | Auto-generated |
| `share_id` | uuid (FK → client_shares) | Which share this action belongs to |
| `job_candidate_id` | uuid (FK → job_candidates) | Which candidate |
| `action_type` | text | `viewed`, `interview_requested`, `passed`, `stage_moved` |
| `action_data` | jsonb | Additional data (feedback text, scheduling info, etc.) |
| `actor_email` | text | Client email who performed the action |
| `created_at` | timestamptz | When the action occurred |

## Data Flow: Client Action → Pipeline

| Client Action | DB Update | Pipeline UI Effect |
|---|---|---|
| Views candidate (More Info) | `client_viewed_at` set | NEW banner removed; "Client viewed [date]" shown on candidate row |
| Requests Interview | Status → `interview_requested`; `interview_notes` + `interview_scheduled_at` set | Status badge turns blue. Role fulfillment bar "Interview" count increases. Activity log entry created. |
| Passes on candidate | Status → `rejected`; `client_feedback` populated | Status badge turns red. Feedback visible in expandable row. Sourcing alert triggers if no viable candidates remain. |
| Interview stage progression | Status → `interview_1` / `interview_2` / `pending_decision` / `hired` | Status badge updates. Fulfillment bar recalculates. Opening count decreases on hire. |

## File Architecture

| File | Purpose |
|---|---|
| `public/client.html` | Client-facing page (standalone HTML, no auth required beyond email gate) |
| `public/index.html` | Main app — add "Create Client View" button + modal on project headers |
| `api/client-action.js` | Vercel serverless function — handles client actions (view, interview request, pass, stage move). Validates share token + email. |
| `supabase-setup.sql` | Add `client_shares` table, `client_actions_log` table, new columns on `job_candidates`, RLS policies |

## Security

- Share tokens are UUIDs — unguessable
- Email must match `allowed_emails` array on the share
- RLS policies: client API endpoint only reads/writes data for jobs included in the share's `job_ids`
- `api/client-action.js` validates both token and email on every request
- No Supabase JWT needed for client page — uses token + email validation via serverless function
- Shares can be deactivated (soft delete) by admin at any time

## Responsive Design

- 2-column card grid on desktop, collapses to 1 column on mobile
- Pipeline board scrolls horizontally on mobile
- All touch targets minimum 44px for mobile usability
