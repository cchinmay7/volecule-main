import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Shared-secret check for the endpoints Google Apps Script calls
 * (X-Volecule-Secret header vs. INGESTION_SHARED_SECRET). Returns the
 * response to send back if the request must be rejected, or null when it's
 * authorised. Compares fixed-length digests in constant time so neither the
 * secret's value nor its length leaks through response timing.
 */
export function checkIngestionSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.INGESTION_SHARED_SECRET

  if (!expected) {
    console.error('[ingestion] INGESTION_SHARED_SECRET is not set')
    return NextResponse.json(
      { error: 'Server misconfiguration' },
      { status: 500 },
    )
  }

  const provided = req.headers.get('x-volecule-secret')
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}
