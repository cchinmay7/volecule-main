'use client'

import { useActionState } from 'react'
import { createProjectAction } from '@/app/protected/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SiteOption = { id: string; name: string }

export function CreateProjectForm({ sites }: { sites: SiteOption[] }) {
  const [state, formAction, pending] = useActionState(createProjectAction, null)

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Project created successfully.</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="site_id">Site</Label>
        <select
          id="site_id"
          name="site_id"
          required
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Project name</Label>
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
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create project'}
      </Button>
    </form>
  )
}
