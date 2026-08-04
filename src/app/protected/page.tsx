import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/supabase/server'
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
    supabase.from('projects').select('id, name, site_id'),
    supabase
      .from('sites')
      .select('id, name, timezone')
      .order('created_at', { ascending: false }),
  ])

  const schemaNotReady = Boolean(projectsError || sitesError)
  const typedProjects = (projectsData ?? []) as ProjectRow[]
  const projectNamesBySiteId = typedProjects.reduce<Record<string, string[]>>(
    (acc, project) => {
      if (!project.site_id) return acc
      acc[project.site_id] = [...(acc[project.site_id] ?? []), project.name]
      return acc
    },
    {},
  )
  const typedSites = (sitesData ?? []) as SiteRow[]

  const siteStatusRows = await Promise.all(
    typedSites.map(async (site) => {
      const localDate = toLocalDateString(new Date(), site.timezone)
      const [
        { data: dayLogs, error: dayLogsError },
        { data: lastLog, error: lastLogError },
      ] = await Promise.all([
        supabase
          .from('site_logs')
          .select('shift')
          .eq('site_id', site.id)
          .eq('log_date', localDate),
        supabase
          .from('site_logs')
          .select('created_at')
          .eq('site_id', site.id)
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

      return {
        siteId: site.id,
        siteName: site.name,
        projectNames: projectNamesBySiteId[site.id] ?? [],
        localDate,
        hasMorning,
        hasEvening,
        lastSubmittedAt: lastLog?.[0]?.created_at ?? null,
        hasQueryError,
      }
    }),
  )
  const statusCardError = siteStatusRows.some((site) => site.hasQueryError)

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Per-site monitoring</h1>
        <p className="text-muted-foreground text-sm">
          Live morning/evening submission status by site.
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
            <CardTitle className="text-base">Today per-site status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {statusCardError ? (
              <p className="text-muted-foreground text-sm">
                Could not load all site statuses. Try refreshing the page.
              </p>
            ) : siteStatusRows.length > 0 ? (
              siteStatusRows.map((site) => (
                <div
                  key={site.siteId}
                  className="rounded-md border px-3 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{site.siteName}</p>
                      <p className="text-muted-foreground text-xs">
                        Projects:{' '}
                        {site.projectNames.length > 0
                          ? site.projectNames.join(', ')
                          : '--'}
                      </p>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      Date: {site.localDate}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={site.hasMorning ? 'default' : 'destructive'}
                    >
                      Morning: {site.hasMorning ? 'Submitted' : 'Missing'}
                    </Badge>
                    <Badge
                      variant={site.hasEvening ? 'default' : 'destructive'}
                    >
                      Evening: {site.hasEvening ? 'Submitted' : 'Missing'}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Last submission:{' '}
                    {site.lastSubmittedAt
                      ? new Date(site.lastSubmittedAt).toLocaleString()
                      : 'No submissions yet'}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">
                No sites configured yet.
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
