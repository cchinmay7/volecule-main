import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Button } from '@/components/ui/button'
import { SiteDetailView } from './site-detail-view'

type ProjectRow = {
  id: string
  project_id: string | null
  name: string
  client_name: string
  status: string
  created_at: string
}

type SiteRow = {
  id: string
  name: string
  public_code: string | null
  status: string
  timezone: string
}

type ProjectDetailPageProps = {
  params: Promise<{ projectId: string }>
}

export default async function ProjectDetailPage({
  params,
}: ProjectDetailPageProps) {
  noStore()
  await connection()

  const { projectId } = await params
  const supabase = await createClient()

  const [
    { data: project, error: projectError },
    { data: sites, error: sitesError },
  ] = await Promise.all([
    supabase
      .from('sites')
      .select('id, project_id, name, client_name, status, created_at')
      .eq('id', projectId)
      .single(),
    supabase
      .from('projects')
      .select('id, name, public_code, status, timezone')
      .order('created_at', { ascending: false }),
  ])

  if (projectError || !project) {
    notFound()
  }

  if (sitesError) {
    return (
      <div className="space-y-4">
        <Link href="/protected/projects">
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
      <Link href="/protected/projects">
        <Button variant="outline" size="sm">
          Back to sites
        </Button>
      </Link>
      <SiteDetailView
        project={project as ProjectRow}
        sites={(sites ?? []) as SiteRow[]}
      />
    </div>
  )
}
