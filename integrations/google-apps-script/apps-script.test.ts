// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * Runs the real morning/evening scripts, together with the two helper files
 * they depend on, inside a vm with Apps Script's globals faked. Catches the
 * mistakes that only show up on a live form: a helper that isn't defined, a
 * question title that doesn't match, a payload field renamed on one side.
 */

const DIR = path.resolve(process.cwd(), 'integrations/google-apps-script')
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8')

type Question = { title: string; type: string }
type Answer = { title: string; value: string | string[] }

function setup(
  script: 'morning-form.gs' | 'evening-form.gs',
  formQuestions: Question[],
  answers: Answer[],
  submitStatus = 200,
  /** Which helper files are present in the Apps Script project. */
  helpers: { common?: boolean; photos?: boolean } = {},
) {
  const { common = true, photos = true } = helpers
  const calls: { url: string; payload: Record<string, unknown> }[] = []
  const logs: string[] = []

  const item = (q: { title: string; type: string }) => ({
    getTitle: () => q.title,
    getType: () => q.type,
  })

  const context = vm.createContext({
    FormApp: {
      ItemType: {
        FILE_UPLOAD: 'FILE_UPLOAD',
        TEXT: 'TEXT',
        CHECKBOX: 'CHECKBOX',
      },
      getActiveForm: () => ({
        getTitle: () => 'Test form',
        getItems: () => formQuestions.map(item),
      }),
    },
    DriveApp: { getRootFolder: () => ({}) },
    UrlFetchApp: {
      fetch: (url: string, options: { payload?: string }) => {
        calls.push({
          url,
          payload: options.payload ? JSON.parse(options.payload) : {},
        })
        return {
          getResponseCode: () => submitStatus,
          getContentText: () => '{"ok":true}',
        }
      },
    },
    Logger: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    event: {
      response: {
        getTimestamp: () => new Date('2026-10-07T13:00:00Z'),
        getId: () => 'resp-9',
        getItemResponses: () =>
          answers.map((answer) => ({
            getItem: () =>
              item(
                formQuestions.find((q) => q.title === answer.title) ?? {
                  title: answer.title,
                  type: 'TEXT',
                },
              ),
            getResponse: () => answer.value,
          })),
      },
    },
  })

  vm.runInContext(
    [
      ...(common ? [read('volecule-common.gs')] : []),
      ...(photos ? [read('volecule-photos.gs')] : []),
      read(script),
    ].join('\n'),
    context,
  )

  return {
    logs,
    calls,
    run: () => vm.runInContext('onFormSubmit(event)', context),
    runCode: (code: string) => vm.runInContext(code, context),
  }
}

// The evening form as listFormQuestions() printed it on the live form.
const EVENING_QUESTIONS: Question[] = [
  { title: 'Site Engineer', type: 'TEXT' },
  { title: 'The Tasks that were Completed today', type: 'CHECKBOX' },
  { title: 'Manpower - Actual( by team)', type: 'SECTION_HEADER' },
  { title: 'Barbenders', type: 'TEXT' },
  { title: 'Carpenters', type: 'TEXT' },
  { title: 'Masons', type: 'TEXT' },
  { title: 'Helpers', type: 'TEXT' },
  { title: 'Operators', type: 'TEXT' },
  { title: 'Others', type: 'TEXT' },
  { title: 'Site Photo', type: 'FILE_UPLOAD' },
  { title: 'Escalate to Volecule', type: 'MULTIPLE_CHOICE' },
  { title: 'Evening Notes', type: 'PARAGRAPH_TEXT' },
]

describe('evening-form.gs', () => {
  const answers: Answer[] = [
    { title: 'Site Engineer', value: 'Rahul' },
    { title: 'Masons', value: '4' },
    { title: 'Helpers', value: '6' },
    {
      title: 'The Tasks that were Completed today',
      value: ['W12 - Slab', 'W13 - Beam'],
    },
    { title: 'Escalate to Volecule', value: 'No' },
    { title: 'Evening Notes', value: 'Rain after lunch' },
  ]

  it('sends the answers, headcount and project code to /submit', () => {
    const { run, calls, logs } = setup(
      'evening-form.gs',
      EVENING_QUESTIONS,
      answers,
    )
    run()

    expect(calls).toHaveLength(1)
    const payload = calls[0].payload
    expect(calls[0].url).toMatch(/\/google-forms\/submit$/)
    expect(payload).toMatchObject({
      shift: 'evening',
      external_submission_id: 'resp-9',
      submitted_at: '2026-10-07T13:00:00.000Z',
      photos_drive: [],
      form_values: {
        site_engineer: 'Rahul',
        headcount: { masons: '4', helpers: '6', barbenders: null },
        targets_achieved: ['W12 - Slab', 'W13 - Beam'],
        escalate_to_volecule: 'No',
        free_notes: 'Rain after lunch',
      },
    })
    // Everything configured exists on the form, so nothing is flagged.
    expect(logs.join('\n')).not.toContain('WARNING')
  })

  it('reports a configured question that is not on the form, and still submits', () => {
    // The wrong script was once deployed on an evening form: it looked for
    // the morning planning question's title instead of the completions
    // checklist, so every tick was silently dropped.
    const questions = EVENING_QUESTIONS.map((q) =>
      q.title === 'The Tasks that were Completed today'
        ? { ...q, title: 'Which of these will be completed by EOD today?' }
        : q,
    )
    const { run, calls, logs } = setup('evening-form.gs', questions, [
      {
        title: 'Which of these will be completed by EOD today?',
        value: ['W12 - Slab'],
      },
    ])
    run()

    const log = logs.join('\n')
    expect(log).toContain('WARNING')
    expect(log).toContain('The Tasks that were Completed today')
    // It lists what IS on the form, so the fix is a copy-paste.
    expect(log).toContain('Which of these will be completed by EOD today?')
    // The submission still goes out; the ticks are the part that is missed.
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.form_values).toMatchObject({ targets_achieved: [] })
  })

  it('matches question titles ignoring capitalisation and extra spaces', () => {
    // The form says "Evening Notes"; a script written "Evening notes" still finds it.
    const questions = EVENING_QUESTIONS.map((q) =>
      q.title === 'Evening Notes' ? { ...q, title: '  EVENING   notes ' } : q,
    )
    const { run, calls, logs } = setup('evening-form.gs', questions, [
      { title: '  EVENING   notes ', value: 'Rain after lunch' },
    ])
    run()

    expect(calls[0].payload.form_values).toMatchObject({
      free_notes: 'Rain after lunch',
    })
    expect(logs.join('\n')).not.toContain('WARNING')
  })

  it('records the uploaded photo question and its Drive file id with the log', () => {
    const { run, calls } = setup('evening-form.gs', EVENING_QUESTIONS, [
      ...answers,
      { title: 'Site Photo', value: ['drive-file-1', 'drive-file-2'] },
    ])
    run()

    expect(calls[0].payload.photos_drive).toEqual([
      { drive_file_id: 'drive-file-1', question: 'Site Photo' },
      { drive_file_id: 'drive-file-2', question: 'Site Photo' },
    ])
  })

  it('skips photo sync when the form data is rejected', () => {
    const { run, calls, logs } = setup(
      'evening-form.gs',
      EVENING_QUESTIONS,
      answers,
      401,
    )
    run()
    expect(calls).toHaveLength(1)
    expect(logs.join('\n')).toContain('Skipping photo sync')
  })

  it('makes no photo calls when the response has no upload answer', () => {
    const { run, calls } = setup('evening-form.gs', EVENING_QUESTIONS, answers)
    run()
    expect(calls.every((call) => call.url.endsWith('/submit'))).toBe(true)
  })
})

describe('morning-form.gs', () => {
  // The morning form as listFormQuestions() printed it on the live form.
  const MORNING_QUESTIONS: Question[] = [
    { title: 'Site Engineer', type: 'TEXT' },
    { title: 'Which of these are being started today?', type: 'CHECKBOX' },
    {
      title: 'Which of these will be completed by EOD today?',
      type: 'CHECKBOX',
    },
    { title: 'Manpower - Planned (by team)', type: 'SECTION_HEADER' },
    { title: 'Barbenders', type: 'TEXT' },
    { title: 'Carpenters', type: 'TEXT' },
    { title: 'Masons', type: 'TEXT' },
    { title: 'Helpers', type: 'TEXT' },
    { title: 'Operators', type: 'TEXT' },
    { title: 'Others', type: 'TEXT' },
    { title: 'Weather(AM)', type: 'TEXT' },
    { title: 'Anticipated Blockers', type: 'TEXT' },
    { title: 'Morning Notes', type: 'PARAGRAPH_TEXT' },
  ]

  it('sends every answer the form asks for, and flags nothing', () => {
    const { run, calls, logs } = setup('morning-form.gs', MORNING_QUESTIONS, [
      { title: 'Site Engineer', value: 'Rahul' },
      {
        title: 'Which of these are being started today?',
        value: ['W12 - Slab'],
      },
      {
        title: 'Which of these will be completed by EOD today?',
        value: ['W10 - Columns'],
      },
      { title: 'Masons', value: '4' },
      { title: 'Weather(AM)', value: 'Clear' },
      { title: 'Anticipated Blockers', value: 'Cement delivery' },
      { title: 'Morning Notes', value: 'Crew arrives at 8' },
    ])
    run()

    expect(calls[0].payload).toMatchObject({
      shift: 'morning',
      photos_drive: [],
      form_values: {
        site_engineer: 'Rahul',
        starts_confirmed: ['W12 - Slab'],
        targets_selected: ['W10 - Columns'],
        headcount: { masons: '4', helpers: null },
        weather_am: 'Clear',
        anticipated_blocker: 'Cement delivery',
        free_notes: 'Crew arrives at 8',
      },
    })
    // Every configured title exists on the form, so nothing is reported.
    expect(logs.join('\n')).not.toContain('WARNING')
  })

  it('reports the headcount questions a form does not have', () => {
    const { run, logs } = setup(
      'morning-form.gs',
      [{ title: 'Morning Notes', type: 'PARAGRAPH_TEXT' }],
      [],
    )
    run()
    expect(logs.join('\n')).toContain('Barbenders')
  })
})

describe('a project missing its helper files', () => {
  // A form-submit trigger that throws loses that submission: it never
  // reaches Volecule. The helpers are conveniences, so the data must go out
  // whether or not they are present in the project.
  const evening = [
    { title: 'Masons', type: 'TEXT' },
    { title: 'The Tasks that were Completed today', type: 'CHECKBOX' },
    { title: 'Evening Notes', type: 'PARAGRAPH_TEXT' },
  ]
  const answers: Answer[] = [
    { title: 'Masons', value: '4' },
    { title: 'The Tasks that were Completed today', value: ['W12 - Slab'] },
    { title: 'Evening Notes', value: 'Rain after lunch' },
  ]

  it.each(['evening-form.gs', 'morning-form.gs'] as const)(
    '%s still sends the form data with no helper files at all',
    (script) => {
      const { run, calls, logs } = setup(
        script,
        script === 'evening-form.gs' ? evening : [],
        script === 'evening-form.gs' ? answers : [],
        200,
        { common: false, photos: false },
      )

      expect(() => run()).not.toThrow()
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toMatch(/\/google-forms\/submit$/)
      expect(calls[0].payload).toMatchObject({
        external_submission_id: 'resp-9',
        photos_drive: [],
      })

      // And it says what is missing, so the cause is obvious.
      const log = logs.join('\n')
      expect(log).toContain('volecule-common is missing')
      expect(log).toContain('volecule-photos is missing')
    },
  )

  it('keeps the headcount and answers when only the common helper is missing', () => {
    const { run, calls, logs } = setup(
      'evening-form.gs',
      evening,
      answers,
      200,
      { common: false },
    )
    run()

    expect(calls[0].payload.form_values).toMatchObject({
      headcount: { masons: '4', helpers: null },
      targets_achieved: ['W12 - Slab'],
      free_notes: 'Rain after lunch',
    })
    expect(logs.join('\n')).toContain('volecule-common is missing')
    expect(logs.join('\n')).not.toContain('volecule-photos is missing')
  })

  it('stays quiet when both helper files are present', () => {
    const { run, logs } = setup('evening-form.gs', EVENING_QUESTIONS, [])
    run()
    expect(logs.join('\n')).not.toContain('is missing')
  })
})

describe('listFormQuestions', () => {
  it('shows each title with its type and any stray whitespace', () => {
    const { runCode, logs } = setup(
      'evening-form.gs',
      [
        { title: ' Masons ', type: 'TEXT' },
        { title: 'Site photo', type: 'FILE_UPLOAD' },
      ],
      [],
    )
    runCode('listFormQuestions()')

    expect(logs).toContain('Form: Test form')
    expect(logs).toContain('1. [TEXT] " Masons "')
    expect(logs).toContain('2. [FILE_UPLOAD] "Site photo"')
  })
})

describe('the committed scripts', () => {
  it('carry placeholders, never a real secret or project code', () => {
    for (const name of ['morning-form.gs', 'evening-form.gs']) {
      const text = read(name)
      expect(text).toContain("INGEST_SECRET = '<PASTE")
      expect(text).toContain("SITE_CODE = '<PASTE")
      expect(text).not.toContain('strong-random-secret')
    }
  })
})
