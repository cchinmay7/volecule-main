'use client'

import { useActionState } from 'react'
import { createSiteAction } from '@/app/protected/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function CreateSiteForm() {
  const [state, formAction, pending] = useActionState(createSiteAction, null)

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.success && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-sm text-green-600">Site created successfully.</p>
      )}
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
      <p className="text-muted-foreground text-xs">
        A site is a standalone, top-level entity. Create one or more projects
        under it later from the Start page.
      </p>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create site'}
      </Button>
    </form>
  )
}
