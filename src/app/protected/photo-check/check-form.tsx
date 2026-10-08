'use client'

import { useActionState } from 'react'
import { runPhotoStorageCheckAction } from '@/app/protected/photo-check/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function CheckForm() {
  const [state, action, pending] = useActionState(
    runPhotoStorageCheckAction,
    null,
  )

  return (
    <form action={action} className="space-y-4">
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Run check'}
      </Button>

      {state && 'error' in state && (
        <p className="text-destructive text-sm">{state.error}</p>
      )}

      {state && 'steps' in state && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant={state.ok ? 'default' : 'destructive'}>
              {state.ok ? 'Working' : 'Not working'}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {state.ok
                ? 'Photos from the forms can be stored and shown.'
                : 'Fix the failing step below, then run it again.'}
            </span>
          </div>
          <ol className="space-y-2">
            {state.steps.map((step) => (
              <li
                key={step.name}
                className="flex gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <span
                  aria-label={step.ok ? 'passed' : 'failed'}
                  className={step.ok ? 'text-green-600' : 'text-destructive'}
                >
                  {step.ok ? '✓' : '✗'}
                </span>
                <div>
                  <p className="font-medium">{step.name}</p>
                  <p className="text-muted-foreground text-xs break-words">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </form>
  )
}
