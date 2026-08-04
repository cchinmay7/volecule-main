'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteProjectAction,
  updateProjectAction,
} from '@/app/protected/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ProjectDetails = {
  id: string
  site_id: string | null
  name: string
  client_name: string
  status: string
  created_at: string
}

type SiteOption = {
  id: string
  name: string
  public_code: string | null
  status: string
  timezone: string
}

export function ProjectDetailView({
  project,
  sites,
}: {
  project: ProjectDetails
  sites: SiteOption[]
}) {
  const [isEditing, setIsEditing] = useState(false)
  const router = useRouter()

  const [updateState, updateAction, updatePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateProjectAction>> | null,
      formData: FormData,
    ) => {
      const result = await updateProjectAction(prevState, formData)
      if (result.success) setIsEditing(false)
      return result
    },
    null,
  )

  const [deleteState, deleteAction, deletePending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof deleteProjectAction>> | null,
      formData: FormData,
    ) => {
      const result = await deleteProjectAction(prevState, formData)
      if (result.success) router.push('/protected/projects')
      return result
    },
    null,
  )

  const selectedSite = project.site_id
    ? (sites.find((site) => site.id === project.site_id) ?? null)
    : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-muted-foreground text-sm">
            Site details and assigned project.
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
        <input type="hidden" name="project_id" value={project.id} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="project_name">Site name</Label>
            <Input
              id="project_name"
              name="name"
              defaultValue={project.name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="client_name">Client name</Label>
            <Input
              id="client_name"
              name="client_name"
              defaultValue={project.client_name}
              required
              disabled={!isEditing || updatePending || deletePending}
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="project_site_id">Project</Label>
            <select
              id="project_site_id"
              name="site_id"
              defaultValue={project.site_id ?? ''}
              disabled={!isEditing || updatePending || deletePending}
              className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project_status">Site status</Label>
            <select
              id="project_status"
              name="status"
              defaultValue={project.status}
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
              {new Date(project.created_at).toLocaleString()}
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
          <h2 className="text-base font-semibold">Assigned project</h2>
          {selectedSite && (
            <Badge
              variant={
                selectedSite.status === 'active' ? 'default' : 'secondary'
              }
            >
              {selectedSite.status}
            </Badge>
          )}
        </div>
        {selectedSite ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">{selectedSite.name}</p>
            <p className="text-muted-foreground text-xs">
              Code: {selectedSite.public_code ?? '--'} • Timezone:{' '}
              {selectedSite.timezone}
            </p>
            <Link href={`/protected/sites/${selectedSite.id}`}>
              <Button type="button" variant="outline" size="sm">
                View project details
              </Button>
            </Link>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No project is assigned to this site.
          </p>
        )}
      </section>

      <form
        action={deleteAction}
        className="space-y-2 border-t pt-6"
        onSubmit={(event) => {
          if (!window.confirm('Delete this site permanently?')) {
            event.preventDefault()
          }
        }}
      >
        <input type="hidden" name="project_id" value={project.id} />
        <Button
          type="submit"
          variant="destructive"
          disabled={deletePending || updatePending}
        >
          {deletePending ? 'Deleting…' : 'Delete site'}
        </Button>
        {deleteState && !deleteState.success && (
          <p className="text-destructive text-sm">{deleteState.error}</p>
        )}
      </form>
    </div>
  )
}
