// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/test/fake-supabase'

/**
 * Contract test between integrations/google-apps-script/volecule-photos.gs
 * and the two photo routes. Apps Script's UrlFetchApp.fetch is synchronous
 * and the route handlers are async, so the script can't be wired straight
 * to them. Instead the chain is walked one hop at a time: run the real
 * script until it makes a call, capture exactly what it sent, hand that to
 * the real route handler, then run the script again with the handler's real
 * response. A field renamed on either side breaks the chain here instead of
 * in production.
 */

const holder = vi.hoisted(() => ({
  fake: null as null | ReturnType<
    typeof import('@/test/fake-supabase').createFakeSupabase
  >,
}))

vi.mock('@/supabase/admin', () => ({
  createAdminClient: () => holder.fake?.supabase,
}))

import { POST as signRoute } from './sign/route'
import { POST as attachRoute } from './attach/route'

const SECRET = 'test-secret'
const INGEST_URL =
  'https://app.example.com/api/integrations/google-forms/submit'
const PHOTO_SCRIPT = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'integrations/google-apps-script/volecule-photos.gs',
  ),
  'utf8',
)

type FetchCall = { url: string; options: Record<string, unknown> }
type FetchReply = { status: number; body: string }

class StopScript extends Error {}

/** Runs syncFormPhotos in a vm with Apps Script globals faked. Each
 * `replies` entry answers one UrlFetchApp.fetch call in order; once the
 * replies run out, the next call is recorded and the script is stopped. */
function runScript(replies: FetchReply[]) {
  const calls: FetchCall[] = []
  const logs: string[] = []

  const driveFiles: Record<
    string,
    { name: string; mime: string; size: number }
  > = {
    'drive-1': {
      name: 'IMG_0001 - Rahul.jpg',
      mime: 'image/jpeg',
      size: 2_500_000,
    },
    'drive-2': {
      name: 'IMG_0002 - Rahul.png',
      mime: 'image/png',
      size: 900_000,
    },
  }

  const event = {
    response: {
      getItemResponses: () => [
        {
          getItem: () => ({
            getType: () => 'TEXT',
            getTitle: () => 'Site Engineer',
          }),
          getResponse: () => 'Rahul',
        },
        {
          getItem: () => ({
            getType: () => 'FILE_UPLOAD',
            getTitle: () => '  Site   photo ',
          }),
          getResponse: () => ['drive-1', 'drive-2'],
        },
      ],
    },
  }

  const context = vm.createContext({
    FormApp: { ItemType: { FILE_UPLOAD: 'FILE_UPLOAD' } },
    DriveApp: {
      getRootFolder: () => ({}),
      getFileById: (id: string) => {
        const file = driveFiles[id]
        return {
          getName: () => file.name,
          getMimeType: () => file.mime,
          getSize: () => file.size,
          getBlob: () => ({ getBytes: () => [1, 2, 3] }),
        }
      },
    },
    UrlFetchApp: {
      fetch: (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options })
        const reply = replies[calls.length - 1]
        if (!reply) throw new StopScript('end of scripted replies')
        return {
          getResponseCode: () => reply.status,
          getContentText: () => reply.body,
        }
      },
    },
    Logger: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    event,
  })

  vm.runInContext(
    `const INGEST_URL = ${JSON.stringify(INGEST_URL)};
     const INGEST_SECRET = ${JSON.stringify(SECRET)};
     const SITE_CODE = 'BLR-001';
     ${PHOTO_SCRIPT}`,
    context,
  )

  return {
    calls,
    logs,
    listed: vm.runInContext('listPhotoFilesSafely(event)', context),
    sync: () => vm.runInContext("syncFormPhotos(event, 'resp-1')", context),
  }
}

async function callRoute(
  route: (req: NextRequest) => Promise<Response>,
  body: unknown,
) {
  const response = await route(
    new NextRequest('http://localhost/api', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-volecule-secret': SECRET,
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, text: await response.text() }
}

describe('Apps Script <-> photo routes contract', () => {
  beforeEach(() => {
    process.env.INGESTION_SHARED_SECRET = SECRET
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
    holder.fake = createFakeSupabase({
      projects: [{ id: 'p1', public_code: 'BLR-001' }],
      project_logs: [
        {
          id: 'log1',
          project_id: 'p1',
          log_date: '2026-10-07',
          shift: 'evening',
          external_submission_id: 'resp-1',
        },
      ],
      project_log_photos: [],
    })
  })

  it('lists every file-upload answer with a tidy question title', () => {
    const { listed } = runScript([])
    expect(JSON.parse(JSON.stringify(listed))).toEqual([
      { drive_file_id: 'drive-1', question: 'Site photo' },
      { drive_file_id: 'drive-2', question: 'Site photo' },
    ])
  })

  it('sign -> upload -> attach round-trips through the real routes', async () => {
    // Hop 1: what does the script send to /photos/sign?
    const first = runScript([])
    first.sync()
    expect(first.calls).toHaveLength(1)
    const signCall = first.calls[0]
    expect(signCall.url).toBe(
      'https://app.example.com/api/integrations/google-forms/photos/sign',
    )
    expect(
      (signCall.options.headers as Record<string, string>)['X-Volecule-Secret'],
    ).toBe(SECRET)
    const signBody = JSON.parse(signCall.options.payload as string)
    expect(signBody.files[0]).toMatchObject({
      drive_file_id: 'drive-1',
      original_filename: 'IMG_0001 - Rahul.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 2_500_000,
      question: 'Site photo',
    })

    // The real sign route accepts exactly that.
    const signed = await callRoute(signRoute, signBody)
    expect(signed.status).toBe(200)
    const signJson = JSON.parse(signed.text)
    expect(signJson.files.map((f: { status: string }) => f.status)).toEqual([
      'ready',
      'ready',
    ])
    expect(signJson.files[0].path).toBe(
      'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_01.jpg',
    )
    expect(signJson.files[1].path).toMatch(/_02\.png$/)

    // Hop 2: with the real sign response, what does the script upload and
    // then attach?
    const second = runScript([
      { status: 200, body: signed.text },
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    ])
    second.sync()
    // sign, PUT, PUT, then the attach call that stops the script.
    expect(second.calls).toHaveLength(4)

    const [, firstPut, secondPut, attachCall] = second.calls
    expect(firstPut.url).toBe(signJson.files[0].upload_url)
    expect(firstPut.options).toMatchObject({
      method: 'put',
      contentType: 'image/jpeg',
      headers: signJson.upload_headers,
    })
    expect(secondPut.options).toMatchObject({ contentType: 'image/png' })
    expect(signJson.upload_headers.apikey).toBe('sb_publishable_test')

    expect(attachCall.url).toBe(
      'https://app.example.com/api/integrations/google-forms/photos/attach',
    )
    const attachBody = JSON.parse(attachCall.options.payload as string)
    expect(attachBody.photos).toEqual([
      {
        path: signJson.files[0].path,
        drive_file_id: 'drive-1',
        original_filename: 'IMG_0001 - Rahul.jpg',
        question: 'Site photo',
      },
      {
        path: signJson.files[1].path,
        drive_file_id: 'drive-2',
        original_filename: 'IMG_0002 - Rahul.png',
        question: 'Site photo',
      },
    ])

    // Hop 3: the PUTs landed in the bucket, and the real attach route
    // accepts what the script sent.
    holder.fake?.putObject('site-photos', signJson.files[0].path, {
      size: 2_500_000,
      contentType: 'image/jpeg',
    })
    holder.fake?.putObject('site-photos', signJson.files[1].path, {
      size: 900_000,
      contentType: 'image/png',
    })
    const attached = await callRoute(attachRoute, attachBody)
    expect(attached.status).toBe(200)
    expect(JSON.parse(attached.text)).toEqual({
      ok: true,
      attached: [signJson.files[0].path, signJson.files[1].path],
      rejected: [],
    })
    expect(holder.fake?.tables.project_log_photos).toHaveLength(2)

    // Hop 4: a retried submission is told there is nothing left to upload.
    const retrySign = await callRoute(signRoute, signBody)
    expect(
      JSON.parse(retrySign.text).files.map((f: { status: string }) => f.status),
    ).toEqual(['already_attached', 'already_attached'])
  })

  it('rejects calls without the shared secret', async () => {
    const response = await signRoute(
      new NextRequest('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(401)
  })

  it('stops quietly when signing fails, never throwing into the form handler', () => {
    const run = runScript([{ status: 500, body: 'boom' }])
    expect(() => run.sync()).not.toThrow()
    expect(run.logs.join('\n')).toContain('Photo signing failed (500)')
    expect(run.calls).toHaveLength(1)
  })
})
