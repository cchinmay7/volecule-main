'use client'

import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Destructive-delete form that makes the operator type the exact name of
 * what they're deleting before the button enables — a site delete cascades
 * through every project under it, so a stray click on a native confirm()
 * dialog isn't enough friction. The match is also re-checked server-side
 * (confirm_name vs. the row's real name) in deleteSiteAction /
 * deleteProjectAction, so this isn't the only line of defence.
 */
export function DeleteConfirmForm({
  action,
  idFieldName,
  idValue,
  entityLabel,
  entityName,
  warning,
  pending,
  disabled,
  error,
}: {
  action: (formData: FormData) => void
  idFieldName: string
  idValue: string
  entityLabel: string
  entityName: string
  warning: string
  pending: boolean
  disabled: boolean
  error: string | null
}) {
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === entityName.trim()

  return (
    <form action={action} className="space-y-3 border-t pt-6">
      <input type="hidden" name={idFieldName} value={idValue} />
      <div className="space-y-2">
        <Label htmlFor={inputId}>Delete this {entityLabel}</Label>
        <p className="text-muted-foreground text-sm">
          {warning} Type{' '}
          <span className="text-foreground font-mono font-medium">
            {entityName}
          </span>{' '}
          below to confirm.
        </p>
        <Input
          id={inputId}
          name="confirm_name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={entityName}
          autoComplete="off"
          disabled={pending || disabled}
          className="max-w-sm"
        />
      </div>
      <Button
        type="submit"
        variant="destructive"
        disabled={!matches || pending || disabled}
      >
        {pending ? 'Deleting…' : `Delete ${entityLabel}`}
      </Button>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </form>
  )
}
