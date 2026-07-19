# Volecule Next Steps Plan (1-Week Minimal V1)

Date: 2026-07-18

## 1) Scope Lock

Build only what is required to remove the founder bottleneck in v1:

1. Analyst can create projects and sites.
2. Site engineer submits morning and evening Google Forms.
3. Form responses automatically populate Supabase logs.
4. Reminder messages with Google Form links are sent at configured times.

Delivery constraint for this plan:

1. One week total.
2. Maximum 60 minutes per day.

Reference: [md/volecule_main.md](md/volecule_main.md)

## 2) Minimal Data Model

Keep only 3 tables for now.

1. projects
- id uuid pk
- name text not null
- client_name text not null
- status text not null default active
- created_by uuid references auth.users(id)
- created_at timestamptz default now()

2. sites
- id uuid pk
- project_id uuid not null references projects(id) on delete cascade
- name text not null
- timezone text not null default Asia/Kolkata
- google_form_url_morning text
- google_form_url_evening text
- reminder_time_morning time
- reminder_time_evening time
- whatsapp_target text
- status text not null default active
- created_at timestamptz default now()

3. site_logs
- id uuid pk
- site_id uuid not null references sites(id) on delete cascade
- log_date date not null
- shift text not null check (shift in (morning, evening))
- headcount_json jsonb
- targets_selected_json jsonb
- targets_achieved_json jsonb
- free_notes text
- source text not null default google_form check (source in (google_form, manual))
- external_submission_id text
- source_payload_json jsonb
- created_at timestamptz default now()

Cardinality:
- One project to many sites.
- One site to many logs.

Uniqueness:
- unique (site_id, log_date, shift)
- unique (site_id, external_submission_id) where external_submission_id is not null

## 3) Why Other Tables Are Deferred

Deferred as non-essential for first usable cycle:

1. site_recipients
- Reason: one whatsapp_target on sites is enough for v1.

2. site_reminder_rules
- Reason: morning and evening reminder times on sites are enough.

3. reminder_dispatches
- Reason: no strict delivery audit required to start; can add once core flow is stable.

4. form_ingestion_events
- Reason: raw payload can live in site_logs.source_payload_json for v1.

## 4) Minimal Security (Only Must-Have)

Keep security intentionally small, but do not skip these controls:

1. Keep dashboard pages behind existing Supabase auth (`/protected`).
2. Keep Google Forms ingestion endpoint server-side only.
3. Require one shared secret header for ingestion requests.
4. Reject payloads missing site_id, shift, or timestamp/submission id.
5. Keep all provider secrets and ingestion secret in env vars only.

Deferred after week-1:

1. Role matrix (`analyst`, `admin`).
2. Full RLS policy hardening.
3. Signed request verification beyond shared secret.
4. Advanced rate limiting and IP allowlist.

## 5) Google Forms To Supabase (Automatic)

Use Google Apps Script linked to each form response sheet:

1. onFormSubmit trigger fires.
2. Script sends normalized payload to api/integrations/google-forms/submit.
3. Endpoint validates secret.
4. Endpoint resolves site_id and shift.
5. Endpoint upserts into site_logs using (site_id, log_date, shift).

Required hidden fields in each Google Form:

1. site_id
2. shift (morning or evening)
3. external_submission_id

## 6) 7-Day Plan (60 Minutes Per Day)

Day 1 (60 min) - Bootstrap model + dashboard skeleton

1. Create bootstrap SQL for projects, sites, site_logs.
2. Replace protected starter page with a simple dashboard shell.
3. Add nav links: Projects, Sites, Logs.

Day 2 (60 min) - Project and site create flow

1. Build minimal projects list page.
2. Add create-project form.
3. Add create-site form under selected project.

Day 3 (60 min) - Google Forms ingestion endpoint

1. Add api/integrations/google-forms/submit route.
2. Validate shared secret and required fields.
3. Persist with upsert into site_logs.

Day 4 (60 min) - Mapping and dedupe hardening

1. Map incoming payload to headcount/targets/notes json fields.
2. Enforce unique behavior via (site_id, log_date, shift).
3. Return clear errors for invalid shift/site.

Day 5 (60 min) - Reminder sender (minimal)

1. Add basic scheduled handler reading sites reminder times.
2. Build message body with site-specific morning/evening form link.
3. Send WhatsApp using one provider path.

Day 6 (60 min) - Dashboard visibility

1. Show latest morning/evening logs per site.
2. Show missing-log warning for today.
3. Show reminder config status per site.

Day 7 (60 min) - Dry run + fixes

1. Run end-to-end test with one real site.
2. Submit morning and evening Google Forms.
3. Verify Supabase rows and reminder message.
4. Fix top 1-2 blocking issues only.

## 7) Build Order (Minimal)

Day 1

1. Add bootstrap schema SQL for projects, sites, site_logs.
2. Build projects page and site creation under each project.

Day 2

1. Add api/integrations/google-forms/submit endpoint.
2. Add payload mapping and upsert logic for site_logs.

Day 3

1. Add reminder sender using sites.reminder_time_morning and sites.reminder_time_evening.
2. Add basic dashboard widgets: projects count, sites count, latest logs.

## 8) No Migration Overhead

Since there is no production data yet:

1. Use one bootstrap SQL file and evolve it quickly.
2. Delay strict migration/versioning until schema stabilizes after first full site cycle.

## 9) Acceptance Criteria

1. Analyst can create a project and at least one site.
2. Morning and evening form submissions auto-create or update site_logs records.
3. Duplicate submission does not create duplicate log rows.
4. Reminder messages include correct form link for the site.
5. Ingestion endpoint rejects requests without valid shared secret.

## 10) Immediate Next Steps In This Repo

1. Replace starter protected page with a dashboard shell.
2. Create projects and sites pages.
3. Add bootstrap SQL schema for projects, sites, site_logs.
4. Add api/integrations/google-forms/submit endpoint.
5. Add basic reminder scheduler based on morning and evening times in sites.

Next 60-minute block order:

1. Day 1 tasks first.
2. Day 2 tasks second.
3. Continue sequentially; do not parallelize features this week.
