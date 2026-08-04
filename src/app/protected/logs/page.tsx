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
  site_id: string | null
}

type SiteRow = {
  id: string
  name: string
  public_code: string | null
}

type SiteLogRow = {
  id: string
  site_id: string
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
            <CardTitle className="text-base">Site logs</CardTitle>
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
    supabase.from('projects').select('id, name, site_id'),
    supabase.from('sites').select('id, name, public_code'),
    supabase
      .from('site_logs')
      .select('id, site_id, log_date, shift, source, created_at, free_notes')
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const typedProjects = (projects ?? []) as ProjectRow[]
  const projectNamesBySiteId = typedProjects.reduce<Record<string, string[]>>(
    (acc, project) => {
      if (!project.site_id) return acc
      acc[project.site_id] = [...(acc[project.site_id] ?? []), project.name]
      return acc
    },
    {},
  )
  const siteById = Object.fromEntries(
    ((sites ?? []) as SiteRow[]).map((site) => [site.id, site]),
  )
  const typedLogs = (logs ?? []) as SiteLogRow[]
  const hasSchemaError = Boolean(projectsError || sitesError || logsError)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Site logs</CardTitle>
        <CardDescription>
          Recent morning/evening submissions with project visibility.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasSchemaError ? (
          <p className="text-muted-foreground text-sm">
            site_logs table is not available yet. Run the bootstrap SQL and
            refresh this page.
          </p>
        ) : typedLogs.length > 0 ? (
          typedLogs.map((log) => {
            const site = siteById[log.site_id]
            const projectNames = site
              ? (projectNamesBySiteId[site.id] ?? [])
              : []

            return (
              <div
                key={log.id}
                className="space-y-3 rounded-md border px-3 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{site?.name ?? log.site_id}</p>
                    <p className="text-muted-foreground text-xs">
                      Projects:{' '}
                      {projectNames.length > 0 ? projectNames.join(', ') : '--'}{' '}
                      • Code: {site?.public_code ?? '--'}
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
            No site logs yet. Google Forms ingestion will populate this feed.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
