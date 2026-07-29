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
import { CreateSiteForm } from './create-site-form'
import { EditSiteForm } from './edit-site-form'

type ProjectRow = {
  id: string
  name: string
}

type SiteRow = {
  id: string
  name: string
  public_code: string | null
  project_id: string
  timezone: string
  google_form_url_morning: string | null
  google_form_url_evening: string | null
  reminder_time_morning: string | null
  reminder_time_evening: string | null
  whatsapp_target: string | null
  status: string
}

export default function SitesPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">Loading sites...</div>
      }
    >
      <SitesContent />
    </Suspense>
  )
}

async function SitesContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: projects, error: projectsError },
    { data: sites, error: sitesError },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name')
      .order('created_at', { ascending: false }),
    supabase
      .from('sites')
      .select(
        'id, name, public_code, project_id, timezone, google_form_url_morning, google_form_url_evening, reminder_time_morning, reminder_time_evening, whatsapp_target, status',
      )
      .order('created_at', { ascending: false }),
  ])

  const typedProjects = (projects ?? []) as ProjectRow[]
  const typedSites = (sites ?? []) as SiteRow[]
  const projectNameById = Object.fromEntries(
    typedProjects.map((project) => [project.id, project.name]),
  )
  const hasSchemaError = Boolean(projectsError || sitesError)

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create site</CardTitle>
          <CardDescription>
            Configure form links, reminder times, and notification target.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before adding sites.
            </p>
          ) : typedProjects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Create a project before adding sites.
            </p>
          ) : (
            <CreateSiteForm projects={typedProjects} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            Current sites and reminder configuration. Expand a row to edit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              v1 schema tables are not available yet. Run the bootstrap SQL and
              refresh this page.
            </p>
          ) : typedSites.length > 0 ? (
            typedSites.map((site) => (
              <EditSiteForm
                key={site.id}
                site={site}
                projects={typedProjects}
                projectName={
                  projectNameById[site.project_id] ?? site.project_id
                }
              />
            ))
          ) : (
            <p className="text-muted-foreground text-sm">
              No sites yet. Create a site to start morning/evening capture.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
