// Live check that Supabase Storage accepts a photo uploaded the way Apps
// Script does it: a raw PUT to a signed upload URL carrying only the
// headers /photos/sign hands out (the public key, not the service role).
// Run it once after creating the bucket (db/photos_v1.sql):
//
//   node --env-file=.env.local scripts/verify-photo-upload.mjs
//
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
// SUPABASE_SERVICE_ROLE_KEY. Uploads a 1x1 PNG under _smoke/ and removes it
// again; nothing is written to any table.

import { createClient } from '@supabase/supabase-js'

const BUCKET = 'site-photos'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !publishableKey || !serviceKey) {
  console.error(
    'Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY.',
  )
  process.exit(1)
}

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
