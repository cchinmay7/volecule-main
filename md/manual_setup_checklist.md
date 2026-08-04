# Manual Setup Checklist

Use this checklist after deploying to ensure form ingestion and access control work end-to-end.

## 1) Vercel Environment Variables

Set these in Vercel project settings:

- `INGESTION_SHARED_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_API_URL`
- `WHATSAPP_API_KEY`
- `ALLOWED_LOGIN_EMAIL` (server-side allowlist)
- `NEXT_PUBLIC_ALLOWED_LOGIN_EMAIL` (optional client-side pre-check; set same value)

Optional template vars (if your WhatsApp template needs them):

- `WHATSAPP_TEMPLATE_NAME`
- `WHATSAPP_TEMPLATE_LANG`
- `WHATSAPP_TEMPLATE_BODY_VAR1_MODE`
- `WHATSAPP_TEMPLATE_BUTTON_URL_VAR1_MODE`
- `WHATSAPP_TEMPLATE_BUTTON_INDEX`

## 2) Supabase Auth URL Configuration

In Supabase Auth URL Configuration, set these redirect URL patterns:

- `http://localhost:3000/**`
- `https://volecule-main.vercel.app/**`
- `https://volecule-main-*-onlychinmay-9411s-projects.vercel.app/**`

Also set your site URL to your primary production domain:

- `https://volecule-main.vercel.app`

## 3) Supabase SQL / Policies

Run `db/bootstrap_v1.sql` in your Supabase SQL editor.

It includes:

- project -> many sites model (`sites.project_id`)
- legacy schema compatibility updates
- required RLS delete policies

## 4) Data Model Checks in App

- A project can have multiple sites
- Every new site must be linked to a project
- Projects can exist without sites

## 5) Project Configuration in App

For each project, confirm:

- `status = active`
- `timezone = Asia/Kolkata` (default)
- `google_form_url_morning` and/or `google_form_url_evening`
- `reminder_time_morning` and/or `reminder_time_evening`
- valid `whatsapp_target`

## 6) Google Forms + Apps Script

For each morning/evening form:

1. Create/update Google Form fields as expected by the integration script.
2. Add Apps Script webhook code to submit form payload to:
   - `POST /api/integrations/google-forms/submit`
3. Pass required auth header:
   - `x-volecule-secret: <INGESTION_SHARED_SECRET>`
4. Map form fields correctly (`project_code` or `project_id`, date/shift/headcount/target/notes as configured).
5. Install `onFormSubmit` trigger (manual runs do not provide the event object).

## 7) WhatsApp Setup

- For Meta test mode, recipient must be an approved test recipient.
- For production sending, use verified business sender/number.
- Ensure API URL points to correct phone-number endpoint.

## 8) Verification Checklist

1. Open `https://volecule-main.vercel.app/`:
   - not logged in -> login page
   - logged in with allowed account -> dashboard
2. Create/update a project.
3. Create one or more sites under that project.
4. Use project detail page manual buttons:
   - **Send morning form**
   - **Send evening form**
5. Submit a real Google Form response and verify log ingestion in app.

## 9) Common Failure Cases

- Login loop back to login:
  - `ALLOWED_LOGIN_EMAIL` does not match the signed-in user email
- `Unauthorized` on ingestion endpoint:
  - missing/wrong `INGESTION_SHARED_SECRET`
- Delete returns policy-like failure:
  - bootstrap SQL not fully applied
- No WhatsApp delivery:
  - invalid target format, missing WhatsApp env vars, or non-approved test recipient
- Reminder not triggered at expected local time:
  - timezone mismatch or missing reminder/form fields
