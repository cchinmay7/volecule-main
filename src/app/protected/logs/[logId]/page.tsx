import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { createAdminClient } from '@/supabase/admin'
import {
  BROWSER_RENDERABLE_MIME_TYPES,
  PHOTO_BUCKET,
} from '@/utils/photos/photo-naming'
import { getPhotoReadUrls } from '@/utils/photos/photo-storage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/utils/dates'

type LogRow = {
  id: string
  project_id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: 'google_form' | 'manual'
  external_submission_id: string | null
  headcount_json: unknown
  targets_selected_json: unknown
  targets_achieved_json: unknown
  free_notes: string | null
  escalate_to_volecule: boolean
  source_payload_json: unknown
  created_at: string
}

type ProjectRow = {
  id: string
  site_id: string | null
  name: string
  public_code: string | null
}

type SiteRow = {
  id: string
  name: string
  client_name: string
}

type PhotoRow = {
  id: string
  storage_path: string
  sequence: number
  original_filename: string | null
  mime_type: string
  size_bytes: number | null
  question: string | null
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

type LogDetailsPageProps = {
  params: Promise<{ logId: string }>
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2)
}

export default async function LogDetailsPage({ params }: LogDetailsPageProps) {
  noStore()
  await connection()

  const { logId } = await params
  const supabase = await createClient()

  const { data: log, error: logError } = await supabase
    .from('project_logs')
    .select(
      'id, project_id, log_date, shift, source, external_submission_id, headcount_json, targets_selected_json, targets_achieved_json, free_notes, escalate_to_volecule, source_payload_json, created_at',
    )
    .eq('id', logId)
    .single()

  if (logError || !log) {
    notFound()
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, site_id, name, public_code')
    .eq('id', (log as LogRow).project_id)
    .single()

  const typedProject = project as ProjectRow | null

  const { data: site } = typedProject?.site_id
    ? await supabase
        .from('sites')
        .select('id, name, client_name')
        .eq('id', typedProject.site_id)
        .single()
    : { data: null as SiteRow | null }

  const typedLog = log as LogRow

  // Photos live in a table added after the original schema; if it doesn't
  // exist yet (db/photos_v1.sql not run) the log still renders, just
  // without a photo section.
  const { data: photoData } = await supabase
    .from('project_log_photos')
    .select(
      'id, storage_path, sequence, original_filename, mime_type, size_bytes, question',
    )
    .eq('project_log_id', logId)
    .eq('storage_bucket', PHOTO_BUCKET)
    .order('sequence', { ascending: true })

  const photos = (photoData ?? []) as PhotoRow[]
  const photoUrls =
    photos.length > 0
      ? await getPhotoReadUrls(
          createAdminClient(),
          photos.map((photo) => photo.storage_path),
        )
      : new Map<string, string>()

  return (
    <div className="space-y-4">
      <Link href="/protected/logs">
        <Button variant="outline" size="sm">
          Back to logs
        </Button>
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Log details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {typedLog.escalate_to_volecule && (
              <Badge variant="destructive">Escalated to Volecule</Badge>
            )}
            <Badge variant="outline">{typedLog.shift}</Badge>
            <Badge variant="outline">{typedLog.source}</Badge>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(typedLog.created_at)}
            </span>
          </div>

          <div className="space-y-1">
            <p>
              <span className="font-medium">Project:</span>{' '}
              {typedProject?.name ?? typedLog.project_id}
            </p>
            <p>
              <span className="font-medium">Site:</span>{' '}
              {site ? `${site.name} (${site.client_name})` : '--'}
            </p>
            <p>
              <span className="font-medium">Public code:</span>{' '}
              {typedProject?.public_code ?? '--'}
            </p>
            <p>
              <span className="font-medium">Log date:</span> {typedLog.log_date}
            </p>
            <p>
              <span className="font-medium">External submission id:</span>{' '}
              {typedLog.external_submission_id ?? '--'}
            </p>
          </div>

          <section className="space-y-2">
            <p className="font-medium">Headcount</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              {prettyJson(typedLog.headcount_json)}
            </pre>
          </section>

          <section className="space-y-2">
            <p className="font-medium">Targets selected</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              {prettyJson(typedLog.targets_selected_json)}
            </pre>
          </section>

          <section className="space-y-2">
            <p className="font-medium">Targets achieved</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              {prettyJson(typedLog.targets_achieved_json)}
            </pre>
          </section>

          <section className="space-y-2">
            <p className="font-medium">Notes</p>
            <p className="bg-muted rounded-md p-3 text-xs">
              {typedLog.free_notes ?? '--'}
            </p>
          </section>

          {photos.length > 0 && (
            <section className="space-y-2">
              <p className="font-medium">Photos ({photos.length})</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {photos.map((photo) => {
                  const url = photoUrls.get(photo.storage_path)
                  const renderable = BROWSER_RENDERABLE_MIME_TYPES.includes(
                    photo.mime_type,
                  )
                  const fileName = photo.storage_path.split('/').pop()

                  return (
                    <figure key={photo.id} className="space-y-1">
                      {url && renderable ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={photo.original_filename ?? fileName}
                            loading="lazy"
                            className="bg-muted aspect-square w-full rounded-md border object-cover"
                          />
                        </a>
                      ) : (
                        <div className="bg-muted text-muted-foreground flex aspect-square w-full items-center justify-center rounded-md border p-2 text-center text-xs">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              Open {photo.mime_type.replace('image/', '')} file
                            </a>
                          ) : (
                            'Preview unavailable'
                          )}
                        </div>
                      )}
                      <figcaption className="text-muted-foreground text-xs">
                        <span className="text-foreground font-mono">
                          {fileName}
                        </span>
                        {photo.question && <> · {photo.question}</>}
                        {photo.size_bytes !== null && (
                          <> · {formatBytes(photo.size_bytes)}</>
                        )}
                      </figcaption>
                    </figure>
                  )
                })}
              </div>
            </section>
          )}

          <section className="space-y-2">
            <p className="font-medium">Raw payload</p>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              {prettyJson(typedLog.source_payload_json)}
            </pre>
          </section>
        </CardContent>
      </Card>
    </div>
  )
}
