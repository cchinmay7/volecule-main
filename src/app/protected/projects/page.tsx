import { createClient } from '@/supabase/server'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/utils/tailwind'
import { Suspense } from 'react'
import { connection } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { CreateProjectForm } from './create-project-form'

type ProjectRow = {
  id: string
  site_id: string | null
  name: string
  client_name: string
  status: string
  created_at: string
}

type SiteRow = {
  id: string
  name: string
  status: string
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
      .select('id, site_id, name, client_name, status, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('sites').select('id, name, status'),
  ])

  const typedProjects = (projects ?? []) as ProjectRow[]
  const typedSites = (sites ?? []) as SiteRow[]
  const siteById = Object.fromEntries(typedSites.map((site) => [site.id, site]))

  const hasSchemaError = Boolean(projectsError || sitesError)

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create project</CardTitle>
          <CardDescription>
            Add a project and associate it to a site.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              Run the bootstrap SQL before creating projects.
            </p>
          ) : typedSites.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Create a site before adding projects.
            </p>
          ) : (
            <CreateProjectForm
              sites={typedSites.map((site) => ({
                id: site.id,
                name: site.name,
              }))}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projects</CardTitle>
          <CardDescription>
            Browse projects and open full details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSchemaError ? (
            <p className="text-muted-foreground text-sm">
              v1 schema tables are not available yet. Run the bootstrap SQL and
              refresh this page.
            </p>
          ) : typedProjects.length > 0 ? (
            typedProjects.map((project) => {
              const site = project.site_id ? siteById[project.site_id] : null
              return (
                <div
                  key={project.id}
                  className="space-y-3 rounded-md border px-3 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{project.name}</p>
                      <p className="text-muted-foreground text-xs">
                        Client: {project.client_name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Site: {site?.name ?? project.site_id ?? '--'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {site && (
                        <Badge
                          variant={
                            site.status === 'active' ? 'default' : 'secondary'
                          }
                        >
                          Site {site.status}
                        </Badge>
                      )}
                      <Badge
                        variant={
                          project.status === 'active' ? 'default' : 'secondary'
                        }
                      >
                        {project.status}
                      </Badge>
                    </div>
                  </div>
                  <Link
                    href={`/protected/projects/${project.id}`}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'sm' }),
                    )}
                  >
                    View details
                  </Link>
                </div>
              )
            })
          ) : (
            <p className="text-muted-foreground text-sm">
              No projects yet. Create the first project from the form.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
