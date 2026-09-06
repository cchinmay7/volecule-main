import Link from 'next/link'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createClient } from '@/supabase/server'
import { Button } from '@/components/ui/button'
import { ProjectDetailView } from './project-detail-view'

type ProjectRow = {
  id: string
  site_id: string | null
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

type SiteRow = {
  id: string
  name: string
  client_name: string
  status: string
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

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select(
      'id, site_id, name, public_code, timezone, google_form_url_morning, google_form_url_evening, reminder_time_morning, reminder_time_evening, whatsapp_target, status, created_at',
    )
    .eq('id', projectId)
    .single()

  if (projectError || !project) {
    notFound()
  }

  const typedProject = project as ProjectRow

  const [{ data: sites, error: sitesError }, { data: allSites }] =
    await Promise.all([
      typedProject.site_id
        ? supabase
            .from('sites')
            .select('id, name, client_name, status')
            .eq('id', typedProject.site_id)
        : Promise.resolve({ data: [] as SiteRow[], error: null }),
      supabase
        .from('sites')
        .select('id, name, client_name, status')
        .order('name', { ascending: true }),
    ])

  if (sitesError) {
    return (
      <div className="space-y-4">
        <Link href="/protected/projects">
          <Button variant="outline" size="sm">
            Back to projects
          </Button>
        </Link>
        <p className="text-destructive text-sm">Could not load the site.</p>
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
        project={typedProject}
        site={((sites ?? [])[0] as SiteRow | undefined) ?? null}
        allSites={(allSites ?? []) as SiteRow[]}
      />
    </div>
  )
}
