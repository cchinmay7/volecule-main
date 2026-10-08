import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase } from '@/test/fake-supabase'
import { PHOTO_BUCKET } from './photo-naming'
import { runPhotoStorageCheck } from './storage-check'

const PUBLIC_KEY = 'sb_publishable_test'

/** A fetch that behaves like Storage: a PUT to the signed URL stores the
 * object (when `accept` is true); a GET returns it. */
function storageFetch(
  fake: ReturnType<typeof createFakeSupabase>,
  accept: { put: boolean; get?: boolean } = { put: true },
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    if (init?.method === 'PUT') {
      if (!accept.put) {
        return new Response('{"message":"Invalid API key"}', { status: 401 })
      }
      const path = href.split(`/upload/sign/${PHOTO_BUCKET}/`)[1].split('?')[0]
      fake.putObject(PHOTO_BUCKET, path, {
        size: (init.body as Uint8Array).length,
        contentType: new Headers(init.headers).get('content-type') ?? '',
      })
      return new Response('{}', { status: 200 })
    }
    return new Response('png-bytes', {
      status: accept.get === false ? 403 : 200,
    })
  }) as unknown as typeof fetch
}

describe('runPhotoStorageCheck', () => {
  it('passes a full round trip and leaves nothing behind', async () => {
    const fake = createFakeSupabase()
    const fetchImpl = storageFetch(fake)

    const result = await runPhotoStorageCheck({
      admin: fake.supabase,
      publishableKey: PUBLIC_KEY,
      fetchImpl,
      now: () => 1234,
    })

    expect(result.ok).toBe(true)
    expect(result.steps.map((step) => step.name)).toEqual([
      'Sign an upload',
      'Upload with the public key',
      'Verify the stored file',
      'Read it back',
      'Clean up',
    ])
    expect(result.steps.every((step) => step.ok)).toBe(true)
    expect(fake.removedObjects).toEqual([
      `${PHOTO_BUCKET}/_smoke/check-1234.png`,
    ])
    expect(fake.hasObject(PHOTO_BUCKET, '_smoke/check-1234.png')).toBe(false)
  })

  it('uploads with only the public key and the issued headers, never a service key', async () => {
    const fake = createFakeSupabase()
    const fetchImpl = storageFetch(fake)

    await runPhotoStorageCheck({
      admin: fake.supabase,
      publishableKey: PUBLIC_KEY,
      fetchImpl,
    })

    const put = vi
      .mocked(fetchImpl)
      .mock.calls.find(([, init]) => init?.method === 'PUT')
    const headers = new Headers(put?.[1]?.headers)
    expect(headers.get('apikey')).toBe(PUBLIC_KEY)
    expect(headers.get('x-upsert')).toBe('true')
    expect(headers.get('content-type')).toBe('image/png')
    expect(headers.has('authorization')).toBe(false)
  })

  it('reports a refused upload, skips the later steps, and has nothing to clean up', async () => {
    const fake = createFakeSupabase()

    const result = await runPhotoStorageCheck({
      admin: fake.supabase,
      publishableKey: PUBLIC_KEY,
      fetchImpl: storageFetch(fake, { put: false }),
    })

    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.name)).toEqual([
      'Sign an upload',
      'Upload with the public key',
    ])
    expect(result.steps[1]).toMatchObject({ ok: false })
    expect(result.steps[1].detail).toContain('HTTP 401')
    expect(fake.removedObjects).toHaveLength(0)
  })

  it('still deletes the test file when a later step fails', async () => {
    const fake = createFakeSupabase()

    const result = await runPhotoStorageCheck({
      admin: fake.supabase,
      publishableKey: PUBLIC_KEY,
      fetchImpl: storageFetch(fake, { put: true, get: false }),
      now: () => 99,
    })

    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.name)).toEqual([
      'Sign an upload',
      'Upload with the public key',
      'Verify the stored file',
      'Read it back',
      'Clean up',
    ])
    // The failing step is listed before the clean-up that follows it.
    expect(result.steps[3]).toMatchObject({ name: 'Read it back', ok: false })
    expect(fake.removedObjects).toEqual([`${PHOTO_BUCKET}/_smoke/check-99.png`])
  })

  it('points at the SQL script when the bucket is missing', async () => {
    const admin = {
      storage: {
        from: () => ({
          createSignedUploadUrl: async () => ({
            data: null,
            error: { message: 'Bucket not found' },
          }),
        }),
      },
    } as unknown as SupabaseClient

    const result = await runPhotoStorageCheck({
      admin,
      publishableKey: PUBLIC_KEY,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].detail).toContain('db/photos_v1.sql')
  })
})
