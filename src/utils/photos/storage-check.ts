import type { SupabaseClient } from '@supabase/supabase-js'
import { PHOTO_BUCKET } from '@/utils/photos/photo-naming'

/**
 * Live round trip through the photo bucket, for the "is photo storage
 * working?" page. It does what a real photo does, in the same way:
 *
 *   1. issue a signed upload URL for a throwaway path
 *   2. PUT a tiny PNG to it using only the public key and the issued
 *      headers (what Apps Script sends), never the service role key
 *   3. confirm the stored object's type and size
 *   4. read it back through a signed read URL (what the log page uses)
 *   5. delete it
 *
 * It stops at the first failing step but always tries to clean up, and
 * writes nothing to any table.
 */

export type StorageCheckStep = { name: string; ok: boolean; detail: string }
export type StorageCheckResult = { ok: boolean; steps: StorageCheckStep[] }

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export async function runPhotoStorageCheck({
  admin,
  publishableKey,
  fetchImpl = fetch,
  now = Date.now,
}: {
  admin: SupabaseClient
  publishableKey: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<StorageCheckResult> {
  const steps: StorageCheckStep[] = []
  const bucket = admin.storage.from(PHOTO_BUCKET)
  const path = `_smoke/check-${now()}.png`
  const png = new Uint8Array(Buffer.from(PNG_1X1_BASE64, 'base64'))
  let created = false

  const fail = (name: string, detail: string): StorageCheckResult => {
    steps.push({ name, ok: false, detail })
    return { ok: false, steps }
  }

  // Always called with the step that decided the outcome already recorded,
  // so the clean-up appears after it in the list.
  const finish = async (
    outcome: StorageCheckResult,
  ): Promise<StorageCheckResult> => {
    if (created) {
      const { error } = await bucket.remove([path])
      steps.push(
        error
          ? {
              name: 'Clean up',
              ok: false,
              detail: `Could not delete ${path}: ${error.message}`,
            }
          : { name: 'Clean up', ok: true, detail: 'Test file deleted.' },
      )
    }
    return { ok: outcome.ok && steps.every((step) => step.ok), steps }
  }

  // 1. Sign
  const { data: signed, error: signError } = await bucket.createSignedUploadUrl(
    path,
    { upsert: true },
  )
  if (signError || !signed) {
    return fail(
      'Sign an upload',
      `${signError?.message ?? 'No URL returned'}. Does the "${PHOTO_BUCKET}" bucket exist? Run db/photos_v1.sql.`,
    )
  }
  steps.push({
    name: 'Sign an upload',
    ok: true,
    detail: 'Storage issued a signed upload URL.',
  })

  // 2. Upload exactly as Apps Script does.
  let response: Response
  try {
    response = await fetchImpl(signed.signedUrl, {
      method: 'PUT',
      headers: {
        apikey: publishableKey,
        'x-upsert': 'true',
        'cache-control': 'max-age=3600',
        'content-type': 'image/png',
      },
      body: png,
    })
  } catch (error) {
    return fail(
      'Upload with the public key',
      `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  created = response.ok
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300)
    return finish(
      fail('Upload with the public key', `HTTP ${response.status}: ${body}`),
    )
  }
  steps.push({
    name: 'Upload with the public key',
    ok: true,
    detail: `Accepted (HTTP ${response.status}) with only the public key and the issued headers.`,
  })

  // 3. Verify what was stored.
  const { data: info, error: infoError } = await bucket.info(path)
  if (infoError || !info) {
    return finish(
      fail(
        'Verify the stored file',
        `Not found after upload: ${infoError?.message ?? 'no info'}`,
      ),
    )
  }
  const storedType = String(info.contentType ?? '')
  if (storedType !== 'image/png' || info.size !== png.length) {
    return finish(
      fail(
        'Verify the stored file',
        `Expected image/png, ${png.length} bytes; stored ${storedType || 'unknown type'}, ${info.size} bytes.`,
      ),
    )
  }
  steps.push({
    name: 'Verify the stored file',
    ok: true,
    detail: `${info.size} bytes, ${storedType}.`,
  })

  // 4. Read back the way the log page does.
  const { data: urls, error: urlError } = await bucket.createSignedUrls(
    [path],
    60,
  )
  const readUrl = urls?.[0]?.signedUrl
  if (urlError || !readUrl) {
    return finish(
      fail(
        'Read it back',
        `No read URL: ${urlError?.message ?? urls?.[0]?.error ?? 'none returned'}`,
      ),
    )
  }
  try {
    const read = await fetchImpl(readUrl)
    if (!read.ok) {
      return finish(
        fail('Read it back', `Signed read URL returned HTTP ${read.status}.`),
      )
    }
  } catch (error) {
    return finish(
      fail(
        'Read it back',
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
  steps.push({
    name: 'Read it back',
    ok: true,
    detail: 'A signed read URL returns the file, as the log page needs.',
  })

  return finish({ ok: true, steps })
}
