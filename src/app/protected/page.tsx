import { createClient } from '@/supabase/server'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/utils/tailwind'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

type SiteRow = {
  id: string
  name: string
  timezone: string
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  google_form_url_morning: string | null
  google_form_url_evening: string | null
  whatsapp_target: string | null
}

type SiteLogRow = {
  id: string
  site_id: string
  log_date: string
  shift: 'morning' | 'evening'
  created_at: string
}

export default function ProtectedPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">
          Loading dashboard...
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
    { count: projectsCount, error: projectsError },
    { count: sitesCount, error: sitesError },
    { data: latestLogs, error: logsError },
    { data: sitesData, error: sitesDataError },
  ] = await Promise.all([
    supabase.from('projects').select('*', { count: 'exact', head: true }),
    supabase.from('sites').select('*', { count: 'exact', head: true }),
    supabase
      .from('site_logs')
      .select('id, site_id, log_date, shift, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('sites')
      .select(
        'id, name, timezone, reminder_time_morning, reminder_time_evening, google_form_url_morning, google_form_url_evening, whatsapp_target',
      )
      .order('created_at', { ascending: false }),
  ])

  const schemaNotReady = Boolean(
    projectsError || sitesError || logsError || sitesDataError,
  )

  const typedSites = (sitesData ?? []) as SiteRow[]
  const typedLatestLogs = (latestLogs ?? []) as SiteLogRow[]

  const siteStatusRows = await Promise.all(
    typedSites.map(async (site) => {
      const localDate = toLocalDateString(new Date(), site.timezone)
      const [
        { data: dayLogs, error: dayLogsError },
        { data: lastLog, error: lastLogError },
      ] = await Promise.all([
        supabase
          .from('site_logs')
          .select('shift, created_at')
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

      const morningConfigured = Boolean(
        site.reminder_time_morning &&
        site.google_form_url_morning &&
        site.whatsapp_target,
      )
      const eveningConfigured = Boolean(
        site.reminder_time_evening &&
        site.google_form_url_evening &&
        site.whatsapp_target,
      )

      return {
        siteId: site.id,
        siteName: site.name,
        localDate,
        hasMorning,
        hasEvening,
        morningConfigured,
        eveningConfigured,
        lastSubmittedAt: lastLog?.[0]?.created_at ?? null,
        hasQueryError,
      }
    }),
  )
  const statusCardError = siteStatusRows.some((site) => site.hasQueryError)

  return (
    <div className="flex w-full flex-1 flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Operations Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Track project setup progress and daily form ingestion status.
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
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Projects</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{projectsCount ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Sites</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{sitesCount ?? 0}</p>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/protected/projects"
              className={cn(buttonVariants({ variant: 'default' }))}
            >
              Manage Projects
            </Link>
            <Link
              href="/protected/sites"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              Manage Sites
            </Link>
            <Link
              href="/protected/logs"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              View Logs
            </Link>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Latest activity</CardTitle>
            </CardHeader>
            <CardContent>
              {typedLatestLogs.length > 0 ? (
                <div className="space-y-2 text-sm">
                  {typedLatestLogs.map((log) => (
                    <div
                      key={log.id}
                      className="text-muted-foreground flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <span>
                        {log.shift} log for site {log.site_id}
                      </span>
                      <span>{log.log_date}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No logs found yet. Connect Google Forms ingestion to start
                  seeing site activity.
                </p>
              )}
            </CardContent>
          </Card>

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
                      <p className="font-medium">{site.siteName}</p>
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
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          site.morningConfigured ? 'secondary' : 'outline'
                        }
                      >
                        Morning reminder:{' '}
                        {site.morningConfigured ? 'Configured' : 'Incomplete'}
                      </Badge>
                      <Badge
                        variant={
                          site.eveningConfigured ? 'secondary' : 'outline'
                        }
                      >
                        Evening reminder:{' '}
                        {site.eveningConfigured ? 'Configured' : 'Incomplete'}
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
        </>
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
