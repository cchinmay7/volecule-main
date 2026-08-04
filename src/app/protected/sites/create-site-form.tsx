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
        <p className="text-sm text-green-600">Project created successfully.</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Project name</Label>
        <Input id="name" name="name" placeholder="Tower A - Floor 3" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="public_code">Project code (optional)</Label>
        <Input
          id="public_code"
          name="public_code"
          placeholder="Auto-generated if left blank"
        />
        <p className="text-muted-foreground text-xs">
          Use this stable code in form links/payloads. The ingestion payload key
          remains <code>site_code</code>.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="timezone">Timezone</Label>
        <Input
          id="timezone"
          name="timezone"
          defaultValue="Asia/Kolkata"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="google_form_url_morning">Morning form URL</Label>
        <Input id="google_form_url_morning" name="google_form_url_morning" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="google_form_url_evening">Evening form URL</Label>
        <Input id="google_form_url_evening" name="google_form_url_evening" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reminder_time_morning">Morning reminder</Label>
        <Input
          id="reminder_time_morning"
          name="reminder_time_morning"
          type="time"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reminder_time_evening">Evening reminder</Label>
        <Input
          id="reminder_time_evening"
          name="reminder_time_evening"
          type="time"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="whatsapp_target">WhatsApp target</Label>
        <Input id="whatsapp_target" name="whatsapp_target" />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create project'}
      </Button>
    </form>
  )
}
