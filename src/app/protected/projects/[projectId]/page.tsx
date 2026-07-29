import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Button } from '@/components/ui/button'
import { ProjectDetailView } from './project-detail-view'

type ProjectRow = {
  id: string
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
      .from('projects')
      .select('id, name, client_name, status, created_at')
      .eq('id', projectId)
      .single(),
    supabase
      .from('sites')
      .select('id, name, public_code, status, timezone')
      .eq('project_id', projectId)
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
            Back to projects
          </Button>
        </Link>
        <p className="text-destructive text-sm">
          Could not load associated sites.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Link href="/protected/projects">
        <Button variant="outline" size="sm">
          Back to projects
        </Button>
      </Link>
      <ProjectDetailView
        project={project as ProjectRow}
        sites={(sites ?? []) as SiteRow[]}
      />
    </div>
  )
}
