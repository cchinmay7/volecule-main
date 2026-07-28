import { createClient } from '@/supabase/server'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { CreateProjectForm, QuickAddSiteForm } from './create-project-form'
import { EditProjectForm } from './edit-project-form'

type ProjectRow = {
  id: string
  name: string
  client_name: string
  status: string
  created_at: string
}

type SiteRow = {
  id: string
  project_id: string
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground text-sm">Loading projects...</div>
      }
    >
      <ProjectsContent />
    </Suspense>
  )
}

async function ProjectsContent() {
  noStore()
  await connection()

  const supabase = await createClient()
  const [
    { data: projects, error: projectsError },
    { data: sites, error: sitesError },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, client_name, status, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('sites').select('id, project_id'),
  ])

  const typedProjects = (projects ?? []) as ProjectRow[]
  const typedSites = (sites ?? []) as SiteRow[]
  const siteCountByProject = typedSites.reduce<Record<string, number>>(
    (acc, site) => {
      acc[site.project_id] = (acc[site.project_id] ?? 0) + 1
      return acc
    },
    {},
  )

  const hasSchemaError = Boolean(projectsError || sitesError)

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create project</CardTitle>
          <CardDescription>
            Add a project so sites can be configured underneath it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projects</CardTitle>
          <CardDescription>
            Existing projects and their configured site counts. Update in place.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              v1 schema tables are not available yet. Run the bootstrap SQL and
              refresh this page.
            </p>
          ) : typedProjects.length > 0 ? (
            typedProjects.map((project) => (
              <EditProjectForm
                key={project.id}
                project={project}
                siteCount={siteCountByProject[project.id] ?? 0}
              />
            ))
          ) : (
            <p className="text-muted-foreground text-sm">
              No projects yet. Create the first project from the form.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Quick add site</CardTitle>
          <CardDescription>
            Create a site under an existing project with reminder configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before adding sites.
            </p>
          ) : typedProjects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Create a project before adding a site.
            </p>
          ) : (
            <QuickAddSiteForm projects={typedProjects} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
