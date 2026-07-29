import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createClient } from '@/supabase/server'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'

type SiteRow = {
  id: string
  name: string
}

type SiteLogRow = {
  id: string
  site_id: string
  log_date: string
  shift: 'morning' | 'evening'
  source: 'google_form' | 'manual'
  created_at: string
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
  const [{ data: sites, error: sitesError }, { data: logs, error: logsError }] =
    await Promise.all([
      supabase.from('sites').select('id, name'),
      supabase
        .from('site_logs')
        .select('id, site_id, log_date, shift, source, created_at')
        .order('created_at', { ascending: false })
        .limit(30),
    ])

  const siteNameById = Object.fromEntries(
    ((sites ?? []) as SiteRow[]).map((site) => [site.id, site.name]),
  )
  const typedLogs = (logs ?? []) as SiteLogRow[]
  const hasSchemaError = Boolean(sitesError || logsError)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Site logs</CardTitle>
        <CardDescription>
          Recent morning/evening submissions captured for all sites.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasSchemaError ? (
          <p className="text-muted-foreground text-sm">
            site_logs table is not available yet. Run the bootstrap SQL and
            refresh this page.
          </p>
        ) : typedLogs.length > 0 ? (
          typedLogs.map((log) => (
            <div
              key={log.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <div className="space-y-1">
                <p className="font-medium">
                  {siteNameById[log.site_id] ?? log.site_id}
                </p>
                <p className="text-muted-foreground text-xs">
                  {log.log_date} • {log.shift}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{log.source}</Badge>
                <span className="text-muted-foreground text-xs">
                  {log.created_at}
                </span>
              </div>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">
            No site logs yet. Google Forms ingestion will populate this feed.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
