import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/supabase/server'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

type SiteRow = {
  id: string
  name: string
}

type ProjectRow = {
  id: string
  site_id: string | null
  name: string
  timezone: string
}

export default function ProtectedPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">
          Loading monitoring view...
        </div>
      }
    >
      <ProtectedDashboardContent />
    </Suspense>
  )
}

async function ProtectedDashboardContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: projectsData, error: projectsError },
    { data: sitesData, error: sitesError },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, site_id, name, timezone')
      .order('created_at', { ascending: false }),
    supabase.from('sites').select('id, name'),
  ])

  const schemaNotReady = Boolean(projectsError || sitesError)
  const typedSites = (sitesData ?? []) as SiteRow[]
  const siteNameById = Object.fromEntries(
    typedSites.map((site) => [site.id, site.name]),
  )
  const typedProjects = (projectsData ?? []) as ProjectRow[]

  const projectStatusRows = await Promise.all(
    typedProjects.map(async (project) => {
      const localDate = toLocalDateString(new Date(), project.timezone)
      const [
        { data: dayLogs, error: dayLogsError },
        { data: lastLog, error: lastLogError },
      ] = await Promise.all([
        supabase
          .from('project_logs')
          .select('shift, escalate_to_volecule')
          .eq('project_id', project.id)
          .eq('log_date', localDate),
        supabase
          .from('project_logs')
          .select('created_at')
          .eq('project_id', project.id)
          .order('created_at', { ascending: false })
          .limit(1),
      ])

      const hasQueryError = Boolean(dayLogsError || lastLogError)

      const hasMorning = Boolean(
        dayLogs?.some((log) => log.shift === 'morning'),
      )
      const hasEvening = Boolean(
        dayLogs?.some((log) => log.shift === 'evening'),
      )
      const isEscalatedToday = Boolean(
        dayLogs?.some((log) => log.escalate_to_volecule),
      )

      return {
        projectId: project.id,
        projectName: project.name,
        siteName: project.site_id
          ? (siteNameById[project.site_id] ?? null)
          : null,
        localDate,
        hasMorning,
        hasEvening,
        isEscalatedToday,
        lastSubmittedAt: lastLog?.[0]?.created_at ?? null,
        hasQueryError,
      }
    }),
  )
  const statusCardError = projectStatusRows.some(
    (project) => project.hasQueryError,
  )

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Per-project monitoring</h1>
        <p className="text-muted-foreground text-sm">
          Live morning/evening submission status by project.
        </p>
      </div>

      {schemaNotReady && (
        <div className="bg-destructive/10 border-destructive/30 rounded-md border px-4 py-3 text-sm">
          <p className="font-medium">Schema not initialised</p>
          <p className="text-muted-foreground text-xs">
            Run <code>db/bootstrap_v1.sql</code> in your Supabase project and
            refresh this page.
          </p>
        </div>
      )}

      {!schemaNotReady && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Today per-project status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {statusCardError ? (
              <p className="text-muted-foreground text-sm">
                Could not load all project statuses. Try refreshing the page.
              </p>
            ) : projectStatusRows.length > 0 ? (
              projectStatusRows.map((project) => (
                <div
                  key={project.projectId}
                  className="rounded-md border px-3 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{project.projectName}</p>
                      <p className="text-muted-foreground text-xs">
                        Site: {project.siteName ?? '--'}
                      </p>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      Date: {project.localDate}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {project.isEscalatedToday && (
                      <Badge variant="destructive">Escalated</Badge>
                    )}
                    <Badge
                      variant={project.hasMorning ? 'default' : 'destructive'}
                    >
                      Morning: {project.hasMorning ? 'Submitted' : 'Missing'}
                    </Badge>
                    <Badge
                      variant={project.hasEvening ? 'default' : 'destructive'}
                    >
                      Evening: {project.hasEvening ? 'Submitted' : 'Missing'}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Last submission:{' '}
                    {project.lastSubmittedAt
                      ? new Date(project.lastSubmittedAt).toLocaleString()
                      : 'No submissions yet'}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">
                No projects configured yet.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function toLocalDateString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)

    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value

    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    // Fall back to UTC date string if timezone is invalid.
  }
  return date.toISOString().slice(0, 10)
}
