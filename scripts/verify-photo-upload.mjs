// Live check that Supabase Storage accepts a photo uploaded the way Apps
// Script does it: a raw PUT to a signed upload URL carrying only the
// headers /photos/sign hands out (the public key, not the service role).
// Run it once after creating the bucket (db/photos_v1.sql):
//
//   node scripts/verify-photo-upload.mjs
//
// It needs three values (Supabase dashboard > Project Settings > API, or
// the same names in your Vercel environment variables). Supply them either
// in a .env.local file, or just for one PowerShell session:
//
//   $env:NEXT_PUBLIC_SUPABASE_URL = "https://<project-ref>.supabase.co"
//   $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "<publishable key>"
//   $env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
//
// The PowerShell form leaves nothing on disk, which suits a service role
// key. The script uploads a 1x1 PNG under _smoke/ and removes it again;
// nothing is written to any table.

import { createClient } from '@supabase/supabase-js'

const BUCKET = 'site-photos'

// Read .env.local when there is one. Variables already set in the shell
// win, and a missing file is fine.
try {
  process.loadEnvFile('.env.local')
} catch {
  // No .env.local; fall back to the shell's environment.
}

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]
const missing = REQUIRED.filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')}\n`)
  console.error(
    [
      'Find them in the Supabase dashboard under Project Settings > API (or in',
      'your Vercel environment variables), then either put them in .env.local',
      'or set them for this PowerShell session:',
      '',
      '  $env:NEXT_PUBLIC_SUPABASE_URL = "https://<project-ref>.supabase.co"',
      '  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "<publishable key>"',
      '  $env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"',
      '  node scripts/verify-photo-upload.mjs',
    ].join('\n'),
  )
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const path = `_smoke/verify-${Date.now()}.png`

async function main() {
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { upsert: true })
  if (signError || !signed) {
    throw new Error(
      `Could not sign an upload (does the "${BUCKET}" bucket exist? run db/photos_v1.sql): ${signError?.message}`,
    )
  }
  console.log('1/3 signed upload URL issued')

  // Exactly what volecule-photos.gs sends: the public key and the headers
  // from the sign response — never the service role key.
  const response = await fetch(signed.signedUrl, {
    method: 'PUT',
    headers: {
      apikey: publishableKey,
      'x-upsert': 'true',
      'cache-control': 'max-age=3600',
      'content-type': 'image/png',
    },
    body: PNG_1X1,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Signed PUT failed (${response.status}): ${text}`)
  }
  console.log('2/3 signed PUT accepted:', response.status)

  const { data: info, error: infoError } = await admin.storage
    .from(BUCKET)
    .info(path)
  if (infoError || !info) {
    throw new Error(`Object not found after upload: ${infoError?.message}`)
  }
  console.log(
    `3/3 object verified: ${info.size} bytes, content-type ${info.contentType}`,
  )
}

main()
  .then(() => console.log('\nPASS — Apps Script uploads will work as designed.'))
  .catch((error) => {
    console.error(`\nFAIL — ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await admin.storage.from(BUCKET).remove([path])
  })
