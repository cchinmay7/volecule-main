/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone, falling
 * back to the UTC date if the timezone is invalid. */
export function toLocalDateString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)

    const year = parts.find((p) => p.type === 'year')?.value
    const month = parts.find((p) => p.type === 'month')?.value
    const day = parts.find((p) => p.type === 'day')?.value

    if (year && month && day) return `${year}-${month}-${day}`
  } catch {
    // Fall through to the UTC date.
  }
  return date.toISOString().slice(0, 10)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-31). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  )
}

/** The app's display timezone. Every timestamp shown in the UI is rendered in
 * IST regardless of where the server or browser happens to run. */
export const APP_TIMEZONE = 'Asia/Kolkata'

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZoneName: 'short',
})

/** A timestamp formatted for display in IST, e.g. "12 Oct 2026, 1:45 am IST". */
export function formatDateTime(value: string | number | Date): string {
  return DATE_TIME_FORMAT.format(new Date(value))
}
