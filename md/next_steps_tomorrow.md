# Next Steps for Tomorrow (V1 Continuation)

Date saved: 2026-07-21

## Current status recap

Completed so far:

- Bootstrap schema (`projects`, `sites`, `site_logs`) with RLS and indexes
- Protected dashboard and navigation (`/protected`, Projects, Sites, Logs)
- Project/site creation flows with validation and error handling
- Google Forms ingestion endpoint (`/api/integrations/google-forms/submit`)
- Reminder sender endpoint (`/api/reminders/send`)
- Dashboard visibility enhancements:
  - Per-site morning/evening submitted or missing status
  - Reminder configuration status
  - Last submission timestamp
- Local API smoke tests passed (ingestion, dedupe/upsert, reminder endpoint)

## Priority next steps

1. Deploy app to a public URL (Vercel recommended)
   - Configure env vars in deployment target:
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `INGESTION_SHARED_SECRET`
     - `WHATSAPP_API_URL` (when provider is ready)
     - `WHATSAPP_API_KEY` (when provider is ready)

2. Wire Google Apps Script to the deployed ingestion endpoint
   - Keep form questions engineer-facing only (no `site_id` input)
   - Inject metadata in script:
     - `site_code` (stable site code from Volecule site config)
     - `shift`
     - `external_submission_id`
     - `submitted_at`

3. Run real end-to-end test on deployed environment
   - Submit one morning form + one evening form
   - Verify rows in `site_logs`
   - Verify dashboard status updates correctly

4. WhatsApp provider integration
   - Continue Meta Cloud API onboarding when account restriction clears
   - Configure provider URL/key and test reminder delivery
   - Confirm delivery to configured `whatsapp_target`

5. Enable scheduled reminders
   - Add cron/scheduler calling `/api/reminders/send`
   - Verify dispatch at configured local site times

## Stretch (only if time permits)

- Add top-level summary chips on dashboard:
  - number of sites missing morning log today
  - number of sites missing evening log today

## Notes

- Image handling is intentionally deferred (v1.1)
- Keep this release focused on reliable data capture + reminders + visibility
