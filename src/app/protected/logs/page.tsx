import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createClient } from '@/supabase/server'
import { cn } from '@/utils/tailwind'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

type ProjectRow = {
  id: string
  site_id: string | null
  name: string
  public_code: string | null
}

type SiteRow = {
  id: string
  name: string
}

type SiteLogRow = {
  id: string
  project_id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: 'google_form' | 'manual'
  created_at: string
  free_notes: string | null
  escalate_to_volecule: boolean
}

export default async function LogsPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project logs</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Loading logs...
          </CardContent>
        </Card>
      }
    >
      <LogsContent />
    </Suspense>
  )
}

async function LogsContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: projects, error: projectsError },
    { data: sites, error: sitesError },
    { data: logs, error: logsError },
  ] = await Promise.all([
    supabase.from('projects').select('id, site_id, name, public_code'),
    supabase.from('sites').select('id, name'),
    supabase
      .from('project_logs')
      .select(
        'id, project_id, log_date, shift, source, created_at, free_notes, escalate_to_volecule',
      )
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  // Photo counts come from a table added after the original schema, so a
  // failure here (db/photos_v1.sql not run yet) just means no badges.
  const photoCountByLogId = new Map<string, number>()
  const logIds = ((logs ?? []) as { id: string }[]).map((log) => log.id)
  if (logIds.length > 0) {
    const { data: photoRows } = await supabase
      .from('project_log_photos')
      .select('project_log_id')
      .in('project_log_id', logIds)
    for (const row of (photoRows ?? []) as { project_log_id: string }[]) {
      photoCountByLogId.set(
        row.project_log_id,
        (photoCountByLogId.get(row.project_log_id) ?? 0) + 1,
      )
    }
  }

  const typedSites = (sites ?? []) as SiteRow[]
  const siteNameById = Object.fromEntries(
    typedSites.map((site) => [site.id, site.name]),
  )
  const projectById = Object.fromEntries(
    ((projects ?? []) as ProjectRow[]).map((project) => [project.id, project]),
  )
  const typedLogs = (logs ?? []) as SiteLogRow[]
  const hasSchemaError = Boolean(projectsError || sitesError || logsError)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Project logs</CardTitle>
        <CardDescription>
          Recent morning/evening submissions with site visibility. Photos not
          showing?{' '}
          <Link href="/protected/photo-check" className="underline">
            Run the photo storage check
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasSchemaError ? (
          <p className="text-muted-foreground text-sm">
            project_logs table is not available yet. Run the bootstrap SQL and
            refresh this page.
          </p>
        ) : typedLogs.length > 0 ? (
          typedLogs.map((log) => {
            const project = projectById[log.project_id]
            const siteName = project?.site_id
              ? (siteNameById[project.site_id] ?? null)
              : null

            return (
              <div
                key={log.id}
                className="space-y-3 rounded-md border px-3 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {project?.name ?? log.project_id}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Site: {siteName ?? '--'} • Code:{' '}
                      {project?.public_code ?? '--'}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {log.log_date} • {log.shift}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {log.escalate_to_volecule && (
                      <Badge variant="destructive">Escalated</Badge>
                    )}
                    {(photoCountByLogId.get(log.id) ?? 0) > 0 && (
                      <Badge variant="secondary">
                        {photoCountByLogId.get(log.id)} photo
                        {photoCountByLogId.get(log.id) === 1 ? '' : 's'}
                      </Badge>
                    )}
                    <Badge variant="outline">{log.source}</Badge>
                    <span className="text-muted-foreground text-xs">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-muted-foreground line-clamp-1 text-xs">
                    {log.free_notes ?? 'No notes'}
                  </p>
                  <Link
                    href={`/protected/logs/${log.id}`}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                    )}
                  >
                    View details
                  </Link>
                </div>
              </div>
            )
          })
        ) : (
          <p className="text-muted-foreground text-sm">
            No project logs yet. Google Forms ingestion will populate this feed.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
