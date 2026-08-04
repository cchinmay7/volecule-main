import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Button } from '@/components/ui/button'
import { SiteDetailView } from './site-detail-view'

type SiteRow = {
  id: string
  name: string
  public_code: string | null
  timezone: string
  google_form_url_morning: string | null
  google_form_url_evening: string | null
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  whatsapp_target: string | null
  status: string
  created_at: string
}

type ProjectRow = {
  id: string
  name: string
  client_name: string
  status: string
}

type SiteDetailPageProps = {
  params: Promise<{ siteId: string }>
}

export default async function SiteDetailPage({ params }: SiteDetailPageProps) {
  noStore()
  await connection()

  const { siteId } = await params
  const supabase = await createClient()

  const [
    { data: site, error: siteError },
    { data: projects, error: projectsError },
  ] = await Promise.all([
    supabase
      .from('sites')
      .select(
        'id, name, public_code, timezone, google_form_url_morning, google_form_url_evening, reminder_time_morning, reminder_time_evening, whatsapp_target, status, created_at',
      )
      .eq('id', siteId)
      .single(),
    supabase
      .from('projects')
      .select('id, name, client_name, status')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false }),
  ])

  if (siteError || !site) {
    notFound()
  }

  if (projectsError) {
    return (
      <div className="space-y-4">
        <Link href="/protected/sites">
          <Button variant="outline" size="sm">
            Back to sites
          </Button>
        </Link>
        <p className="text-destructive text-sm">
          Could not load associated projects.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Link href="/protected/sites">
        <Button variant="outline" size="sm">
          Back to sites
        </Button>
      </Link>
      <SiteDetailView
        site={site as SiteRow}
        projects={(projects ?? []) as ProjectRow[]}
      />
    </div>
  )
}
