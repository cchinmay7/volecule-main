# Volecule Operations Guide for Saras

## 1. Purpose
This guide explains exactly how Saras should operate Volecule day to day and onboard new sites/projects based on the current codebase behavior.

Important: some requested workflows (for example `/pull_scheduler` command, `PROJECT_CODE`, `FORM_TIME`) are not implemented in the current repository. These are marked clearly below.

## 2. Systems Used
- Volecule web app (`/auth/login`, `/protected`, `/protected/sites`, `/protected/projects`, `/protected/logs`)
- Supabase (database + auth)
- Vercel (deployment + runtime logs)
- Google Forms + Google Apps Script (submission integration)
- WhatsApp API provider (for reminder delivery)

Important UI naming switch now active:
- **Sites** tab points to `/protected/projects` and manages rows in `projects` table.
- **Projects** tab points to `/protected/sites` and manages rows in `sites` table (includes code, forms, reminders).
- Database table names are unchanged (`projects`, `sites`).

## 3. Prerequisites
- One allowed operator account email configured by developer in:
  - `ALLOWED_LOGIN_EMAIL`
  - Optional matching client pre-check: `NEXT_PUBLIC_ALLOWED_LOGIN_EMAIL`
- Access to:
  - Volecule production URL
  - Vercel project dashboard
  - Supabase project dashboard (Auth URL config + SQL editor)
  - Google account with permission to create/edit Forms and Apps Script
- Required environment variables (set by developer/admin):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `INGESTION_SHARED_SECRET`
  - `ALLOWED_LOGIN_EMAIL`
  - Optional for WhatsApp sending: `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, template vars
- Database bootstrap SQL must be applied:
  - `db/bootstrap_v1.sql`
- Two form templates needed per project:
  - Morning form
  - Evening form
- WhatsApp recipient must be valid digits format (8–15 digits after normalization).

Code reference: `src/supabase/proxy.ts` — `updateSession()`
Code reference: `src/components/login-form.tsx` — `LoginForm()`
Code reference: `db/bootstrap_v1.sql`
Code reference: `src/utils/reminders.ts` — `normalizeToE164Digits()`
Code reference: `.env.example`

## 4. Important Codes and Identifiers
- **Project ID** (Projects tab): internal UUID (`sites.id`)
- **Project public code**: stable operator-facing code (`sites.public_code`), accepted by ingestion as `site_code`
- **Site ID** (Sites tab): internal UUID (`projects.id`)
- **Legacy `PROJECT_CODE` variable**: **not implemented in current schema/code**
- **FORM_TIME** variable: **not implemented as a variable**; equivalent behavior is `shift` with allowed values:
  - `morning`
  - `evening`
- **External submission ID**: unique form submission ID (`external_submission_id`) for idempotent upserts

Code reference: `db/bootstrap_v1.sql`
Code reference: `src/app/api/integrations/google-forms/submit/route.ts` — `POST()`
Code reference: `src/app/protected/actions.ts` — `parseSiteFormData()`

## 5. Saras’ Day-to-Day Workflow

Step 1: Open Vercel project logs

Where:
Vercel dashboard for the production Volecule deployment.

Action:
Open Runtime/Function logs for the current deployment.

Expected result:
You can view request logs for ingestion and reminders endpoints.

If it fails:
Confirm Saras has Vercel project access; if missing, ask developer to grant access.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`
`src/app/api/reminders/send/route.ts` — `GET()`, `POST()`

Step 2: Verify daily submission status in Volecule dashboard

Where:
`/protected` (Dashboard).

Action:
Check each project’s Morning/Evening badges for Submitted/Missing.

Expected result:
Projects show current local-date status and last submission time.

If it fails:
Refresh once. If still failing, check DB/bootstrap and logs pages.

Code reference:
`src/app/protected/page.tsx` — `ProtectedDashboardContent()`

Step 3: Verify detailed submissions feed

Where:
`/protected/logs`

Action:
Review recent project logs, then open specific entry with “View details”.

Expected result:
Log details show project, sites, shift, payload, and timestamps.

If it fails:
Check if `site_logs` table exists and if ingestion endpoint is receiving valid payloads.

Code reference:
`src/app/protected/logs/page.tsx` — `LogsContent()`
`src/app/protected/logs/[logId]/page.tsx` — `LogDetailsPage()`

Step 4: Find project by code

Where:
`/protected/sites` or specific project detail page.

Action:
Locate the project and confirm its **Code** (`public_code`).

Expected result:
Correct project appears with its code and timezone.

If it fails:
Open project details and confirm `public_code` exists; if missing, ask developer to run bootstrap/backfill SQL.

Code reference:
`src/app/protected/sites/page.tsx` — `SitesContent()`
`src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`
`db/bootstrap_v1.sql`

Step 5: Trigger manual reminder send (morning/evening)

Where:
Project detail page (`/protected/sites/[siteId]`)

Action:
Click **Send morning form** or **Send evening form**.

Expected result:
Success message shown; reminder sent via WhatsApp provider.

If it fails:
Check site is active, form URL exists, WhatsApp target is valid, and WhatsApp env vars/provider are set.

Code reference:
`src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`
`src/app/protected/actions.ts` — `sendSiteReminderAction()`
`src/utils/reminders.ts` — `sendWhatsAppTemplate()`

Step 6: Scheduler retrieval command check

Where:
Repository command/route layer.

Action:
Use of `/pull_scheduler For Site Code: BLR-001` is requested.

Expected result:
Currently, this command does **not** exist in app routes/actions.

If it fails:
This is expected.  
Developer assistance required.

Code reference:
No matching implementation found in `src/**` for `/pull_scheduler`, scheduler retrieval route, or command handler.

## 6. Saras’ Site and Project Onboarding Workflow

Step 1: Create a project

Where:
`/protected/sites` (Projects tab).

Action:
Fill Create project form. Keep timezone as `Asia/Kolkata` unless instructed otherwise.

Expected result:
“Project created successfully.”

If it fails:
Verify required fields and project code uniqueness.

Code reference:
`src/app/protected/sites/create-site-form.tsx` — `CreateSiteForm()`
`src/app/protected/actions.ts` — `createSiteAction()`

Step 2: Record project identifiers

Where:
`/protected/sites` and project detail page.

Action:
Record:
- Project name
- Project ID (from URL)
- Project public code (`public_code`)

Expected result:
Project details visible and code present.

If it fails:
Edit project and set a valid unique public code.

Code reference:
`src/app/protected/sites/page.tsx` — `SitesContent()`
`src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`

Step 3: Create one or more sites linked to project

Where:
`/protected/projects` (Sites tab).

Action:
Use Create site form; select the correct project.

Expected result:
Site is created and listed with assigned project.

If it fails:
Ensure at least one project exists and selected project is valid.

Code reference:
`src/app/protected/projects/create-project-form.tsx` — `CreateProjectForm()`
`src/app/protected/actions.ts` — `createProjectAction()`

Step 4: Record site identifiers

Where:
Site list and site detail page.

Action:
Record:
- Site ID (from URL)
- Site name
- Linked project

Expected result:
Site detail shows assigned project and status.

If it fails:
Edit site and reassign correct project.

Code reference:
`src/app/protected/projects/page.tsx` — `ProjectsContent()`
`src/app/protected/projects/[projectId]/project-detail-view.tsx` — `ProjectDetailView()`

Step 5: Confirm each site is linked to correct project

Where:
Site detail page.

Action:
Open each site and verify the “Assigned project” section.

Expected result:
Assigned project matches onboarding records.

If it fails:
Edit site and update `site_id`.

Code reference:
`src/app/protected/projects/[projectId]/project-detail-view.tsx` — `ProjectDetailView()`
`src/app/protected/actions.ts` — `updateProjectAction()`

## 7. Morning Google Form Setup

Step 1: Create/prepare Morning form

Where:
Google Forms UI.

Action:
Create morning form fields that your script will map to:
- headcount
- targets_selected
- targets_achieved
- free_notes
- hidden `shift = morning`

Expected result:
Form is ready for on-submit trigger.

If it fails:
Use existing known-good template from your operations team.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`

Step 2: Save Morning form URL in project config

Where:
`/protected/sites/[siteId]`

Action:
Set `google_form_url_morning` and save.

Expected result:
Morning URL stored for reminders/manual send.

If it fails:
Check edit mode and validation errors.

Code reference:
`src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`
`src/app/protected/actions.ts` — `updateSiteAction()`

## 8. Evening Google Form Setup

Step 1: Create/prepare Evening form

Where:
Google Forms UI.

Action:
Create evening form with same payload structure and hidden `shift = evening`.

Expected result:
Form is ready for on-submit trigger.

If it fails:
Use existing known-good template from your operations team.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`

Step 2: Save Evening form URL in project config

Where:
`/protected/sites/[siteId]`

Action:
Set `google_form_url_evening` and save.

Expected result:
Evening URL stored for reminders/manual send.

If it fails:
Check edit mode and validation errors.

Code reference:
`src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`
`src/app/protected/actions.ts` — `updateSiteAction()`

## 9. Google Apps Script Configuration

Step 1: Configure webhook POST to Volecule ingestion endpoint

Where:
Google Apps Script linked to each form.

Action:
POST JSON to:
`/api/integrations/google-forms/submit`
with header:
`x-volecule-secret: <INGESTION_SHARED_SECRET>`

Expected result:
Endpoint accepts authenticated payload.

If it fails:
401 means secret mismatch or missing secret.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`

Step 2: Send required payload fields

Where:
Apps Script payload mapper.

Action:
Include:
- `site_id` or `site_code` (recommended: `site_code`)
- `shift` (`morning` or `evening`)
- `external_submission_id`
- `submitted_at` (ISO timestamp)
- `form_values` object

Expected result:
Returns `{ ok: true, log_date, shift }`.

If it fails:
Fix field names and value types to match API contract.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`

Step 3: Variable naming clarification (`FORM_TIME`, `PROJECT_CODE`)

Where:
Apps Script/team process documentation.

Action:
- `FORM_TIME`: not used directly by backend. Use `shift` with values `morning` or `evening`.
- `PROJECT_CODE`: not used by backend ingestion currently.
- Use `site_code` from site `public_code`.

Expected result:
Payload aligns with current implementation.

If it fails:
Developer assistance required.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`
`db/bootstrap_v1.sql`

## 10. Scheduler Retrieval

Step 1: Check current command availability

Where:
Application routes and actions.

Action:
Verify if `/pull_scheduler For Site Code: BLR-001` exists.

Expected result:
Not implemented.

If it fails:
This is expected in current build.  
Developer assistance required.

Code reference:
No scheduler command/route implementation found in `src/app/api/**` or protected actions.

Step 2: Temporary fallback

Where:
`/protected/logs`, `/protected`, site/project detail pages.

Action:
Use latest logs + project/site mapping for operational follow-up.

Expected result:
Operational monitoring works, but scheduler retrieval is unavailable.

If it fails:
Escalate for scheduler feature implementation.

Code reference:
`src/app/protected/logs/page.tsx` — `LogsContent()`
`src/app/protected/page.tsx` — `ProtectedDashboardContent()`

## 11. Verification Checklist

Step 1: Access control verification

Where:
`/`, `/auth/login`, `/protected`

Action:
Confirm:
- Not logged in -> redirects to login
- Logged in allowed user -> redirects to dashboard
- Logged in non-allowed user -> denied

Expected result:
Redirect behavior matches rules.

If it fails:
Check `ALLOWED_LOGIN_EMAIL` and auth session state.

Code reference:
`src/app/page.tsx` — `HomePage()`
`proxy.ts` — `proxy()`
`src/supabase/proxy.ts` — `updateSession()`

Step 2: Form ingestion verification

Where:
Google Form + `/protected/logs` + Vercel logs.

Action:
Submit test morning and evening forms; confirm two logs appear.

Expected result:
Logs appear with correct shift/date/site.

If it fails:
Inspect ingestion route errors in Vercel and payload fields.

Code reference:
`src/app/api/integrations/google-forms/submit/route.ts` — `POST()`
`src/app/protected/logs/page.tsx` — `LogsContent()`

Step 3: Reminder dispatch verification

Where:
Site detail page.

Action:
Use manual send buttons for morning and evening.

Expected result:
Success message in UI and provider accepts request.

If it fails:
Check project active status, WhatsApp target format, form URL, and provider credentials.

Code reference:
`src/app/protected/actions.ts` — `sendSiteReminderAction()`
`src/utils/reminders.ts` — `sendWhatsAppTemplate()`

## 12. Troubleshooting

Problem: Incorrect project code  
Likely cause: `project_code` is not part of current implementation.  
How Saras can verify it: Check project fields in Projects pages and DB schema; no `project_code` column used.  
Resolution: Use Project ID + Project public code for operations.  
When to contact a developer: If business requires human-readable project code.

Problem: Incorrect public project code  
Likely cause: Wrong/missing `public_code` in project config.  
How Saras can verify it: Check project detail “Public code” field and ingestion error `Unknown site_code`.  
Resolution: Update project `public_code` to correct unique value.  
When to contact a developer: If uniqueness conflicts persist.

Problem: Morning or Evening form not submitting  
Likely cause: Missing required payload fields or invalid `shift`.  
How Saras can verify it: Vercel logs show 400 errors such as invalid shift/missing fields.  
Resolution: Fix Apps Script payload mapping.  
When to contact a developer: If payload looks correct but still fails.

Problem: Google Apps Script authorization failure  
Likely cause: Missing/wrong `x-volecule-secret`.  
How Saras can verify it: Endpoint returns 401 Unauthorized.  
Resolution: Update script header to match `INGESTION_SHARED_SECRET`.  
When to contact a developer: If secret rotation is needed.

Problem: Missing environment variable  
Likely cause: Variable not set in Vercel.  
How Saras can verify it: Runtime errors in Vercel logs; features silently unavailable (for example WhatsApp configured fallback logs).  
Resolution: Add missing env var and redeploy.  
When to contact a developer: If unsure about expected variable names.

Problem: Vercel deployment failure  
Likely cause: Build/test failure or missing configuration.  
How Saras can verify it: Vercel deployment status and logs show failed build step.  
Resolution: Share failure log with developer.  
When to contact a developer: Always, for code/build failures.

Problem: No logs appearing  
Likely cause: No ingestion requests or schema not initialized.  
How Saras can verify it: `/protected/logs` empty + schema warning + no ingestion hits in Vercel logs.  
Resolution: Validate Apps Script trigger and run bootstrap SQL.  
When to contact a developer: If trigger fires and still nothing stored.

Problem: Scheduler command returning no data  
Likely cause: Scheduler retrieval command is not implemented.  
How Saras can verify it: No command handler/endpoint for `/pull_scheduler`.  
Resolution: Use monitoring/log workflow as fallback.  
When to contact a developer: To build scheduler retrieval feature.

Problem: Scheduler output has incorrect dates/tasks  
Likely cause: Scheduler output workflow does not exist in current app.  
How Saras can verify it: No scheduler generation route/command in code.  
Resolution: Escalate feature gap.  
When to contact a developer: Immediately.

Problem: WhatsApp number verification issues  
Likely cause: Invalid recipient format or provider restrictions/test mode.  
How Saras can verify it: Reminder send returns failure; provider error in logs.  
Resolution: Use valid approved recipient and correct number formatting.  
When to contact a developer: If provider rejects valid approved number.

Problem: Duplicate sites or projects  
Likely cause: Repeated manual creation; `public_code` uniqueness only prevents code duplication, not name duplication.  
How Saras can verify it: Multiple rows in Sites/Projects pages.  
Resolution: Use detail pages to delete wrong duplicate.  
When to contact a developer: If deletion blocked by policy.

## 13. Developer Escalation Guide
- Escalate immediately for:
  - Missing `/pull_scheduler` feature request
  - Need for `PROJECT_CODE`-based workflows
  - Build/deployment failures
  - DB policy/schema mismatches
  - Repeated ingestion failures after payload correction
- Share:
  - Site ID/public code
  - Project ID
  - Timestamp
  - Endpoint used
  - Exact error text from Vercel/app UI

## 14. Quick Reference Checklist
- Login works only for allowed email.
- Site exists, active, with valid public code.
- Project linked to correct site.
- Morning and evening form URLs set.
- Apps Script sends required headers and payload fields.
- Logs visible in `/protected/logs`.
- Manual reminder buttons tested.
- Scheduler retrieval command currently unavailable (known gap).

## 15. Code References
- `proxy.ts` — `proxy()`
- `src/supabase/proxy.ts` — `updateSession()`
- `src/app/page.tsx` — `HomePage()`
- `src/components/login-form.tsx` — `LoginForm()`
- `src/app/protected/page.tsx` — `ProtectedDashboardContent()`
- `src/app/protected/logs/page.tsx` — `LogsContent()`
- `src/app/protected/logs/[logId]/page.tsx` — `LogDetailsPage()`
- `src/app/protected/sites/create-site-form.tsx` — `CreateSiteForm()`
- `src/app/protected/projects/create-project-form.tsx` — `CreateProjectForm()`
- `src/app/protected/actions.ts` — `createSiteAction()`
- `src/app/protected/actions.ts` — `updateSiteAction()`
- `src/app/protected/actions.ts` — `createProjectAction()`
- `src/app/protected/actions.ts` — `updateProjectAction()`
- `src/app/protected/actions.ts` — `sendSiteReminderAction()`
- `src/app/protected/actions.ts` — `deleteSiteAction()`
- `src/app/protected/actions.ts` — `deleteProjectAction()`
- `src/app/protected/sites/[siteId]/site-detail-view.tsx` — `SiteDetailView()`
- `src/app/protected/projects/[projectId]/project-detail-view.tsx` — `ProjectDetailView()`
- `src/app/api/integrations/google-forms/submit/route.ts` — `POST()`
- `src/app/api/reminders/send/route.ts` — `GET()`, `POST()`
- `src/utils/reminders.ts` — `buildReminderMessage()`, `sendWhatsAppTemplate()`
- `src/supabase/admin.ts` — `createAdminClient()`
- `db/bootstrap_v1.sql`
- `.env.example`
- `md/manual_setup_checklist.md`

## Daily Checklist
- [ ] Sign in with allowed account.
- [ ] Open dashboard (`/protected`) and check morning/evening status by project.
- [ ] Open logs page and confirm recent submissions are arriving.
- [ ] Open any missing project and send manual morning/evening reminder if needed.
- [ ] Check Vercel logs for ingestion/reminder errors.
- [ ] Escalate any unresolved failures with exact error and project/site identifiers.

## New Project Onboarding Checklist
- [ ] Create project in `/protected/sites`.
- [ ] Record Project ID and Project public code.
- [ ] Create one or more sites in `/protected/projects` linked to that project.
- [ ] Record each Site ID and assigned project.
- [ ] Create Morning Google Form and set its URL on the project.
- [ ] Create Evening Google Form and set its URL on the project.
- [ ] Configure Apps Script to POST with `x-volecule-secret` header.
- [ ] Ensure payload uses `site_code` (or `site_id`) and `shift` (`morning`/`evening`).
- [ ] Submit test morning and evening responses.
- [ ] Verify both logs appear in `/protected/logs`.
- [ ] Test manual send buttons for both reminders.
- [ ] If scheduler retrieval is required, escalate (feature not implemented yet).
