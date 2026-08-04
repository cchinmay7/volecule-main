'use client'

import { useActionState } from 'react'
import { createProjectAction } from '@/app/protected/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SiteOption = { id: string; name: string }

export function CreateProjectForm({ sites }: { sites: SiteOption[] }) {
  const [state, formAction, pending] = useActionState(createProjectAction, null)
  const hasProjectOptions = sites.length > 0

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Site created successfully.</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="site_id">Project</Label>
        <select
          id="site_id"
          name="site_id"
          required
          disabled={!hasProjectOptions || pending}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {hasProjectOptions ? (
            sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))
          ) : (
            <option value="">No projects available</option>
          )}
        </select>
        {!hasProjectOptions && (
          <p className="text-muted-foreground text-xs">
            Create a project first in the Projects tab to enable site creation.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Site name</Label>
        <Input id="name" name="name" placeholder="Shivalik Floors" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="client_name">Client name</Label>
        <Input
          id="client_name"
          name="client_name"
          placeholder="Manish Sabani"
          required
        />
      </div>
      <Button
        type="submit"
        className="w-full"
        disabled={pending || !hasProjectOptions}
      >
        {pending ? 'Creating…' : 'Create site'}
      </Button>
    </form>
  )
}
