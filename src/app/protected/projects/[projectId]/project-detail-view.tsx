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
  name: string
  client_name: string
  status: string
  created_at: string
}

type AssociatedSite = {
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
  sites: AssociatedSite[]
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-muted-foreground text-sm">
            Project details and associated sites.
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
            <Label htmlFor="project_name">Project name</Label>
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
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="project_status">Status</Label>
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
          <p className="text-sm text-green-600">Project updated.</p>
        )}
      </form>

      <section className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Associated sites</h2>
          <Badge variant="outline">{sites.length} sites</Badge>
        </div>
        {sites.length > 0 ? (
          <div className="space-y-3">
            {sites.map((site) => (
              <div
                key={site.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{site.name}</p>
                  <p className="text-muted-foreground text-xs">
                    Code: {site.public_code ?? '--'} • Timezone: {site.timezone}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={site.status === 'active' ? 'default' : 'secondary'}
                  >
                    {site.status}
                  </Badge>
                  <Link href={`/protected/sites/${site.id}`}>
                    <Button type="button" variant="outline" size="sm">
                      View details
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No sites are associated with this project yet.
          </p>
        )}
      </section>

      <form
        action={deleteAction}
        className="space-y-2 border-t pt-6"
        onSubmit={(event) => {
          if (
            !window.confirm(
              'Delete this project and all associated sites/logs permanently?',
            )
          ) {
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
          {deletePending ? 'Deleting…' : 'Delete project'}
        </Button>
        <p className="text-muted-foreground text-xs">
          This action cascades and removes all associated sites and logs.
        </p>
        {deleteState && !deleteState.success && (
          <p className="text-destructive text-sm">{deleteState.error}</p>
        )}
      </form>
    </div>
  )
}
