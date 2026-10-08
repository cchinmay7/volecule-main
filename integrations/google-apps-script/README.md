# Google Forms → Volecule: Apps Script

Source of truth for the Apps Script behind the morning and evening forms. The
live copies are pasted into each form's own Apps Script project; keep this
folder in step with them.

**"Project" here means an Apps Script project, not a Volecule site project.**
Every Google Form has its own Apps Script project (open the form, then
⋮ → **Script editor**). There are two to set up: the morning form's and the
evening form's. An **extra file** is a further file inside one of those
projects, next to the main script (in the editor: **+** beside **Files** →
**Script**, name it, paste the code). Files in the same project share one
scope, so the main script can call the helpers directly.

| File                 | Goes in                                                  |
| -------------------- | -------------------------------------------------------- |
| `morning-form.gs`    | the morning form's Apps Script project, as the main file |
| `evening-form.gs`    | the evening form's Apps Script project, as the main file |
| `volecule-common.gs` | **each** form's Apps Script project, as an extra file    |
| `volecule-photos.gs` | **each** form's Apps Script project, as an extra file    |

When you're done, each form's project holds three files: its main script plus
`volecule-common` and `volecule-photos`, identical in both.

The `.gs` files here hold placeholders, never real values. Keep the secret and
the Volecule project code you already have in the live scripts.

## Question titles are the weak spot

The scripts read each answer by its question **title**. A title that doesn't
match the form exactly (copied from the other form, renamed, a stray space)
doesn't raise an error; the answer is simply never found, so nothing is sent
and nothing says why. That is how a form can submit happily for weeks while
its headcount, or every completed-task tick, goes missing.

Matching ignores capitalisation and extra spaces ("Evening notes" and "Evening Notes" are the same
question), but wording and punctuation must match ("Escalate to Volecule" is not "Escalate to Volecule?").

So each main script keeps its titles in one `QUESTIONS` block at the top, and
on every submission `volecule-common.gs` checks them against the form's real
questions and writes a `WARNING: these questions are not on this form` line to
the execution log, listing what the form does have.

## What changed with photo storage

Photos used to stay in the Google Drive folder Google Forms creates. Now, after
the form data is accepted, the script uploads every photo to Supabase Storage
(private bucket `site-photos`) and Volecule files it against the log. See the
"Site Photo Storage" design doc for the full flow.

Compared with the scripts before photo storage, the main scripts:

- send `photos_drive` (Drive file ids) with the form data, so a photo that
  fails to sync can always be recovered from Drive;
- call `syncFormPhotos(e, externalId)` once the form data returns HTTP 200;
- no longer send `site_photo` (it was only the first photo's Drive id) or log
  the raw response (a leftover debug line).

## Setup (per form)

1. Run `db/photos_v1.sql` in the Supabase SQL editor (creates the bucket and
   the `project_log_photos` table). Safe to re-run.
2. Deploy the app version that includes the photo routes.
3. Check that photo storage works. After the app is deployed, log in and open
   **/protected/photo-check** (also linked from the Logs page), then click
   **Run check**. It uploads a one-pixel test image the same way the script does,
   reads it back and deletes it. Every step should show a tick. It uses the keys
   the server already has, so there is nothing to copy.

   The same round trip is available from a terminal if you prefer:
   `node scripts/verify-photo-upload.mjs` needs the project URL, publishable key
   and service role key (Supabase dashboard > Project Settings > API), in
   `.env.local` or set for one PowerShell session so nothing is saved to disk:

   ```powershell
   $env:NEXT_PUBLIC_SUPABASE_URL = "https://<project-ref>.supabase.co"
   $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "<publishable key>"
   $env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
   node scripts/verify-photo-upload.mjs
   ```

4. Open the form → ⋮ → **Script editor** (this is the form's Apps Script project).
   - Add two extra files, `volecule-common` and `volecule-photos`, and paste
     `volecule-common.gs` and `volecule-photos.gs` into them.
   - Run **`listFormQuestions`** once and read **Execution log**: it prints every
     question on the form with its exact title (stray spaces shown).
5. Replace the main script with `morning-form.gs` / `evening-form.gs`, then put
   back your real `INGEST_SECRET` and `SITE_CODE`, and make the `QUESTIONS`
   block match what step 4 printed. Delete the line for any question the form
   doesn't have (for example headcount, if it isn't asked).
6. Run **`authorizeVoleculePhotos`** once from the editor and accept the
   permission prompt (reading photos from Drive is a new permission). The
   existing "On form submit" trigger keeps working; no need to recreate it.
7. Submit a test response (with a photo if the form has that question), then
   check **Executions** in the script editor. There should be no `WARNING`
   line. A healthy run logs `Status: 200` followed by
   `Photo attach (200): {"ok":true,"attached":[…]}`. In Supabase the object
   appears under `site-photos/{project_code}/{date}/{shift}/`, and the photo
   shows on the log's detail page.

## Troubleshooting

| Log line                                              | Meaning / fix                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Skipping photo sync: the form data was not accepted` | `/submit` failed first (wrong secret or project code). Photos wait; fix and resubmit. |
| `Photo signing failed (401)`                          | `INGEST_SECRET` doesn't match `INGESTION_SHARED_SECRET` in Vercel.                    |
| `Photo signing failed (404)`                          | No log for this submission yet — `/submit` didn't store it.                           |
| `Photo … rejected: unsupported_type` / `too_large`    | Only JPEG/PNG/WebP/HEIC/HEIF up to 20 MB are stored. The original stays in Drive.     |
| `Photo … upload failed (4xx)`                         | Storage refused the PUT — run `scripts/verify-photo-upload.mjs` to see why.           |
| `Photo … cannot read from Drive`                      | The authorise step (6) wasn't done, or the script owner can't open the form's files.  |
| `WARNING: these questions are not on this form`       | A title in `QUESTIONS` doesn't match the form. The log lists the form's real titles.  |

## Rotating the shared secret

The secret is the only thing protecting the ingestion routes. If it is guessable
or has been pasted anywhere public, replace it with a long random value:

```bash
openssl rand -hex 32
```

Set it as `INGESTION_SHARED_SECRET` in Vercel (redeploy), then update
`INGEST_SECRET` in **both** forms' scripts.
