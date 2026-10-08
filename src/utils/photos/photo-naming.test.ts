import { describe, expect, it } from 'vitest'
import {
  buildPhotoPath,
  isAllowedPhotoMimeType,
  normalizeMimeType,
  parsePhotoPath,
  sanitizeCodeSegment,
} from './photo-naming'

describe('normalizeMimeType', () => {
  it('lower-cases, drops parameters and folds image/jpg', () => {
    expect(normalizeMimeType('IMAGE/JPEG')).toBe('image/jpeg')
    expect(normalizeMimeType('image/png; charset=binary')).toBe('image/png')
    expect(normalizeMimeType('image/jpg')).toBe('image/jpeg')
  })

  it('only allows the supported image types', () => {
    expect(isAllowedPhotoMimeType('image/heic')).toBe(true)
    expect(isAllowedPhotoMimeType('application/pdf')).toBe(false)
    expect(isAllowedPhotoMimeType('image/gif')).toBe(false)
  })
})

describe('sanitizeCodeSegment', () => {
  it('keeps normal project codes unchanged', () => {
    expect(sanitizeCodeSegment('BLR-001')).toBe('BLR-001')
    expect(sanitizeCodeSegment('S-4-TERRACE-MUMTY-3360AAF6')).toBe(
      'S-4-TERRACE-MUMTY-3360AAF6',
    )
  })

  it('replaces path-unsafe characters and never returns an empty segment', () => {
    expect(sanitizeCodeSegment('A B/C..D')).toBe('A-B-C..D')
    expect(sanitizeCodeSegment('../etc')).toBe('etc')
    expect(sanitizeCodeSegment('///')).toBe('project')
  })
})

describe('buildPhotoPath', () => {
  const base = {
    projectCode: 'BLR-001',
    logDate: '2026-10-07',
    shift: 'evening' as const,
  }

  it('follows the folder + self-describing filename convention', () => {
    expect(
      buildPhotoPath({ ...base, sequence: 1, mimeType: 'image/jpeg' }),
    ).toBe('BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_01.jpg')
  })

  it('derives the extension from the mime type, zero-pads, and grows past 99', () => {
    expect(
      buildPhotoPath({ ...base, sequence: 12, mimeType: 'image/png' }),
    ).toMatch(/_12\.png$/)
    expect(
      buildPhotoPath({ ...base, sequence: 100, mimeType: 'image/heic' }),
    ).toMatch(/_100\.heic$/)
  })

  it('returns null for an unsupported type or a bad sequence', () => {
    expect(
      buildPhotoPath({ ...base, sequence: 1, mimeType: 'application/pdf' }),
    ).toBeNull()
    expect(
      buildPhotoPath({ ...base, sequence: 0, mimeType: 'image/jpeg' }),
    ).toBeNull()
  })
})

describe('parsePhotoPath', () => {
  it('round-trips what buildPhotoPath produces', () => {
    const path = buildPhotoPath({
      projectCode: 'BLR-001',
      logDate: '2026-10-07',
      shift: 'morning',
      sequence: 3,
      mimeType: 'image/webp',
    }) as string
    expect(parsePhotoPath(path, 'BLR-001')).toEqual({
      logDate: '2026-10-07',
      shift: 'morning',
      sequence: 3,
    })
  })

  it('rejects another project, mismatched folder/filename, and traversal', () => {
    const good = 'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_evening_01.jpg'
    expect(parsePhotoPath(good, 'OTHER-1')).toBeNull()
    expect(
      parsePhotoPath(
        'BLR-001/2026-10-07/evening/BLR-001_2026-10-08_evening_01.jpg',
        'BLR-001',
      ),
    ).toBeNull()
    expect(
      parsePhotoPath(
        'BLR-001/2026-10-07/evening/BLR-001_2026-10-07_morning_01.jpg',
        'BLR-001',
      ),
    ).toBeNull()
    expect(
      parsePhotoPath('BLR-001/../x/evening/evil.jpg', 'BLR-001'),
    ).toBeNull()
    expect(parsePhotoPath(`${good}.exe`, 'BLR-001')).toBeNull()
  })

  it('treats regex characters in a project code literally', () => {
    const path = buildPhotoPath({
      projectCode: 'A.B',
      logDate: '2026-10-07',
      shift: 'morning',
      sequence: 1,
      mimeType: 'image/jpeg',
    }) as string
    expect(parsePhotoPath(path, 'A.B')).not.toBeNull()
    expect(parsePhotoPath(path.replace('A.B', 'AxB'), 'A.B')).toBeNull()
  })
})
