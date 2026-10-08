'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import { deleteSiteAction, updateSiteAction } from '@/app/protected/actions'
import { DeleteConfirmForm } from '@/app/protected/delete-confirm-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SiteDetails = {
  id: string
  name: string
  client_name: string
  status: string
  created_at: string
}

type ProjectOption = {
  id: string
  name: string
  public_code: string | null
  status: string
  timezone: string
}

export function SiteDetailView({
  site,
  projects,
}: {
  site: SiteDetails
  projects: ProjectOption[]
}) {
  const [isEditing, setIsEditing] = useState(false)
  const router = useRouter()

  const [updateState, updateAction, updatePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateSiteAction>> | null,
      formData: FormData,
    ) => {
      const result = await updateSiteAction(prevState, formData)
      if (result.success) setIsEditing(false)
      return result
    },
    null,
  )

  const [deleteState, deleteAction, deletePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof deleteSiteAction>> | null,
      formData: FormData,
    ) => {
      const result = await deleteSiteAction(prevState, formData)
      if (result.success) router.push('/protected/sites')
      return result
    },
    null,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{site.name}</h1>
          <p className="text-muted-foreground text-sm">
            Site details and its projects.
          </p>
        </div>
        <Button
          type="button"
          variant={isEditing ? 'secondary' : 'outline'}
          onClick={() => setIsEditing((prev) => !prev)}
          disabled={updatePending || deletePending}
        >
          {isEditing ? 'Cancel edit' : 'Edit'}
        </Button>
      </div>

      <form action={updateAction} className="space-y-4 rounded-md border p-4">
        <input type="hidden" name="site_id" value={site.id} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="site_name">Site name</Label>
            <Input
              id="site_name"
              name="name"
              defaultValue={site.name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="client_name">Client name</Label>
            <Input
              id="client_name"
              name="client_name"
              defaultValue={site.client_name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="site_status">Site status</Label>
            <select
              id="site_status"
              name="status"
              defaultValue={site.status}
              disabled={!isEditing || updatePending || deletePending}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>Created at</Label>
            <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm">
              {new Date(site.created_at).toLocaleString()}
            </p>
          </div>
        </div>

        {isEditing && (
          <Button type="submit" disabled={updatePending || deletePending}>
            {updatePending ? 'Saving…' : 'Save changes'}
          </Button>
        )}

        {updateState && !updateState.success && (
          <p className="text-destructive text-sm">{updateState.error}</p>
        )}
        {updateState?.success && (
          <p className="text-sm text-green-600">Site updated.</p>
        )}
      </form>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Projects at this site</h2>
          <Badge variant="outline">{projects.length} projects</Badge>
        </div>
        {projects.length > 0 ? (
          <div className="space-y-2">
            {projects.map((project) => (
              <div
                key={project.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-muted-foreground text-xs">
                    Code: {project.public_code ?? '--'} • Timezone:{' '}
                    {project.timezone}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      project.status === 'active' ? 'default' : 'secondary'
                    }
                  >
                    {project.status}
                  </Badge>
                  <Link href={`/protected/projects/${project.id}`}>
                    <Button type="button" variant="outline" size="sm">
                      View project details
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No projects have been initialized against this site yet.
          </p>
        )}
      </section>

      <DeleteConfirmForm
        action={deleteAction}
        idFieldName="site_id"
        idValue={site.id}
        entityLabel="site"
        entityName={site.name}
        warning={
          projects.length > 0
            ? `This permanently deletes the site and all ${projects.length} project(s) under it — including their schedules and logs.`
            : 'This permanently deletes the site.'
        }
        pending={deletePending}
        disabled={updatePending}
        error={deleteState && !deleteState.success ? deleteState.error : null}
      />
    </div>
  )
}
