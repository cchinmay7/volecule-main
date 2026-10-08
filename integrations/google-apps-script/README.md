# Google Forms → Volecule: Apps Script

Source of truth for the Apps Script behind the morning and evening forms. The
live copies are pasted into each form's own Apps Script project; keep this
folder in step with them.

| File                 | Goes in                                      |
| -------------------- | -------------------------------------------- |
| `morning-form.gs`    | the morning form's script, as the main file  |
| `evening-form.gs`    | the evening form's script, as the main file  |
| `volecule-photos.gs` | **both** projects, as a second file          |

The `.gs` files here hold placeholders, never real values. Keep the secret and
project code you already have in the live scripts.

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
3. Optional but recommended, once: `node --env-file=.env.local scripts/verify-photo-upload.mjs`
   confirms Storage accepts uploads exactly the way the script sends them.
4. Open the form → ⋮ → **Script editor**.
   - Add a new file `volecule-photos` and paste `volecule-photos.gs`.
   - Replace the main script with `morning-form.gs` / `evening-form.gs`, then
     put back your real `INGEST_SECRET` and `SITE_CODE`.
5. Run **`authorizeVoleculePhotos`** once from the editor and accept the
   permission prompt (reading photos from Drive is a new permission). The
   existing "On form submit" trigger keeps working; no need to recreate it.
6. Submit a test response with a photo, then check **Executions** in the script
   editor. A healthy run logs `Status: 200` followed by
   `Photo attach (200): {"ok":true,"attached":[…]}`. In Supabase the object
   appears under `site-photos/{project_code}/{date}/{shift}/`, and the photo
   shows on the log's detail page.

## Troubleshooting

| Log line                                              | Meaning / fix                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Skipping photo sync: the form data was not accepted` | `/submit` failed first (wrong secret or project code). Photos wait; fix and resubmit.    |
| `Photo signing failed (401)`                          | `INGEST_SECRET` doesn't match `INGESTION_SHARED_SECRET` in Vercel.                       |
| `Photo signing failed (404)`                          | No log for this submission yet — `/submit` didn't store it.                              |
| `Photo … rejected: unsupported_type` / `too_large`    | Only JPEG/PNG/WebP/HEIC/HEIF up to 20 MB are stored. The original stays in Drive.        |
| `Photo … upload failed (4xx)`                         | Storage refused the PUT — run `scripts/verify-photo-upload.mjs` to see why.              |
| `Photo … cannot read from Drive`                      | The authorise step (5) wasn't done, or the script owner can't open the form's files.     |

## Rotating the shared secret

The secret is the only thing protecting the ingestion routes. If it is guessable
or has been pasted anywhere public, replace it with a long random value:

```bash
openssl rand -hex 32
```

Set it as `INGESTION_SHARED_SECRET` in Vercel (redeploy), then update
`INGEST_SECRET` in **both** forms' scripts.
