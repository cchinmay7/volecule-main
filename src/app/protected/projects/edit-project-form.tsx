'use client'

import { useActionState } from 'react'
import { updateProjectAction } from '@/app/protected/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ProjectForEdit = {
  id: string
  name: string
  client_name: string
  status: string
}

export function EditProjectForm({
  project,
  siteCount,
}: {
  project: ProjectForEdit
  siteCount: number
}) {
  const [state, formAction, pending] = useActionState(updateProjectAction, null)
  const nameId = `project-name-${project.id}`
  const clientId = `project-client-${project.id}`
  const statusId = `project-status-${project.id}`

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-md border px-3 py-3 text-sm"
    >
      <input type="hidden" name="project_id" value={project.id} />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={nameId}>Project name</Label>
          <Input id={nameId} name="name" defaultValue={project.name} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor={clientId}>Client name</Label>
          <Input
            id={clientId}
            name="client_name"
            defaultValue={project.client_name}
            required
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[180px_1fr]">
        <div className="space-y-2">
          <Label htmlFor={statusId}>Status</Label>
          <select
            id={statusId}
            name="status"
            defaultValue={project.status}
            className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <Badge variant="outline">{siteCount} sites</Badge>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Project updated.</p>
      )}
    </form>
  )
}
