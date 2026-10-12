'use client'

import { useActionState, useId } from 'react'
import type { UpdateActionState } from '@/app/protected/updates/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/utils/tailwind'

export type CorrectionField = {
  name: string
  label: string
  type?: 'date' | 'text'
  defaultValue?: string
  readOnly?: boolean
  required?: boolean
  max?: string
  maxLength?: number
  /** A free-text field that needs room, such as a task name. */
  wide?: boolean
}

type CorrectionAction = (
  prev: UpdateActionState | null,
  formData: FormData,
) => Promise<UpdateActionState>

/**
 * One operator correction: a titled box with its fields, an optional note
 * ("why"), a submit button and the result. Every action on the Updates
 * page's Tasks tab is one of these, so they all look and report alike.
 */
export function CorrectionForm({
  title,
  help,
  action,
  hidden,
  fields,
  submitLabel,
}: {
  title: string
  help: string
  action: CorrectionAction
  hidden: Record<string, string>
  fields: CorrectionField[]
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, null)
  const id = useId()

  return (
    <form
      action={formAction}
      className="bg-background space-y-2 rounded-md border p-3"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{help}</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {fields.map((f) => (
          <div
            key={f.name}
            className={cn('space-y-1', f.wide && 'min-w-[240px] flex-[2]')}
          >
            <Label htmlFor={`${id}-${f.name}`} className="text-xs">
              {f.label}
            </Label>
            <Input
              id={`${id}-${f.name}`}
              name={f.name}
              type={f.type ?? 'date'}
              defaultValue={f.defaultValue}
              readOnly={f.readOnly}
              required={f.required ?? true}
              max={f.max}
              maxLength={f.maxLength}
              disabled={pending}
              className={cn('h-8 text-xs', f.wide ? 'w-full' : 'w-[150px]')}
            />
          </div>
        ))}
        <div className="min-w-[180px] flex-1 space-y-1">
          <Label htmlFor={`${id}-note`} className="text-xs">
            Note (why)
          </Label>
          <Input
            id={`${id}-note`}
            name="note"
            type="text"
            required={false}
            disabled={pending}
            placeholder="Optional"
            className="h-8 text-xs"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>

      {state && !state.success && (
        <p className="text-destructive text-xs">{state.error}</p>
      )}
      {state?.success && (
        <p className="text-xs text-green-600">{state.message}</p>
      )}
    </form>
  )
}
