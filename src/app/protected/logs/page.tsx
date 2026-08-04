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
  name: string
  public_code: string | null
}

type SiteRow = {
  id: string
  name: string
  project_id: string | null
}

type SiteLogRow = {
  id: string
  project_id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: 'google_form' | 'manual'
  created_at: string
  free_notes: string | null
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
    supabase.from('projects').select('id, name, public_code'),
    supabase.from('sites').select('id, name, project_id'),
    supabase
      .from('project_logs')
      .select('id, project_id, log_date, shift, source, created_at, free_notes')
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const typedSites = (sites ?? []) as SiteRow[]
  const siteNamesByProjectId = typedSites.reduce<Record<string, string[]>>(
    (acc, site) => {
      if (!site.project_id) return acc
      acc[site.project_id] = [...(acc[site.project_id] ?? []), site.name]
      return acc
    },
    {},
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
          Recent morning/evening submissions with site visibility.
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
            const siteNames = project
              ? (siteNamesByProjectId[project.id] ?? [])
              : []

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
                      Sites:{' '}
                      {siteNames.length > 0 ? siteNames.join(', ') : '--'} •
                      Code: {project?.public_code ?? '--'}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {log.log_date} • {log.shift}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
