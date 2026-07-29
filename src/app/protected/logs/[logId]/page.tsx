import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type LogRow = {
  id: string
  site_id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: 'google_form' | 'manual'
  external_submission_id: string | null
  headcount_json: unknown
  targets_selected_json: unknown
  targets_achieved_json: unknown
  free_notes: string | null
  source_payload_json: unknown
  created_at: string
}

type SiteRow = {
  id: string
  name: string
  public_code: string | null
  project_id: string
}

type ProjectRow = {
  id: string
  name: string
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
    .from('site_logs')
    .select(
      'id, site_id, log_date, shift, source, external_submission_id, headcount_json, targets_selected_json, targets_achieved_json, free_notes, source_payload_json, created_at',
    )
    .eq('id', logId)
    .single()

  if (logError || !log) {
    notFound()
  }

  const { data: site } = await supabase
    .from('sites')
    .select('id, name, public_code, project_id')
    .eq('id', (log as LogRow).site_id)
    .single()

  const { data: project } =
    site && site.project_id
      ? await supabase
          .from('projects')
          .select('id, name')
          .eq('id', site.project_id)
          .single()
      : { data: null }

  const typedSite = site as SiteRow | null
  const typedProject = project as ProjectRow | null
  const typedLog = log as LogRow

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
            <Badge variant="outline">{typedLog.shift}</Badge>
            <Badge variant="outline">{typedLog.source}</Badge>
            <span className="text-muted-foreground text-xs">
              {new Date(typedLog.created_at).toLocaleString()}
            </span>
          </div>

          <div className="space-y-1">
            <p>
              <span className="font-medium">Site:</span>{' '}
              {typedSite?.name ?? typedLog.site_id}
            </p>
            <p>
              <span className="font-medium">Project:</span>{' '}
              {typedProject?.name ?? typedSite?.project_id ?? '--'}
            </p>
            <p>
              <span className="font-medium">Public code:</span>{' '}
              {typedSite?.public_code ?? '--'}
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
