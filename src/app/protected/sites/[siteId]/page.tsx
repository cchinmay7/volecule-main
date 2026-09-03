import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Button } from '@/components/ui/button'
import { SiteDetailView } from './site-detail-view'

type SiteRow = {
  id: string
  project_id: string | null
  name: string
  client_name: string
  status: string
  created_at: string
}

type ProjectRow = {
  id: string
  name: string
  public_code: string | null
  status: string
  timezone: string
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
      .select('id, project_id, name, client_name, status, created_at')
      .eq('id', siteId)
      .single(),
    supabase
      .from('projects')
      .select('id, name, public_code, status, timezone')
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
          Could not load project options.
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
