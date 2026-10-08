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
) {
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
    [read('volecule-common.gs'), read('volecule-photos.gs'), read(script)].join(
      '\n',
    ),
    context,
  )

  return {
    logs,
    calls,
    run: () => vm.runInContext('onFormSubmit(event)', context),
    runCode: (code: string) => vm.runInContext(code, context),
  }
}

const EVENING_QUESTIONS: Question[] = [
  'Site Engineer',
  'Barbenders',
  'Carpenters',
  'Masons',
  'Helpers',
  'Operators',
  'Others',
  'Tick the tasks completed today as per the scheduler',
  'Escalate to Volecule?',
  'Evening notes',
].map((title) => ({ title, type: 'TEXT' }))

describe('evening-form.gs', () => {
  const answers: Answer[] = [
    { title: 'Site Engineer', value: 'Rahul' },
    { title: 'Masons', value: '4' },
    { title: 'Helpers', value: '6' },
    {
      title: 'Tick the tasks completed today as per the scheduler',
      value: ['W12 - Slab', 'W13 - Beam'],
    },
    { title: 'Escalate to Volecule?', value: 'No' },
    { title: 'Evening notes', value: 'Rain after lunch' },
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
      q.title === 'Tick the tasks completed today as per the scheduler'
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
    expect(log).toContain('Tick the tasks completed today as per the scheduler')
    // It lists what IS on the form, so the fix is a copy-paste.
    expect(log).toContain('Which of these will be completed by EOD today?')
    // The submission still goes out; the ticks are the part that is missed.
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.form_values).toMatchObject({ targets_achieved: [] })
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
  const questions: Question[] = [
    'Which of these are being started today?',
    'Which of these will be completed by EOD today?',
    'Morning notes',
  ].map((title) => ({ title, type: 'TEXT' }))

  it('sends the start checklist and notes', () => {
    const { run, calls } = setup('morning-form.gs', questions, [
      {
        title: 'Which of these are being started today?',
        value: ['W12 - Slab'],
      },
      { title: 'Morning notes', value: 'Crew arrives at 8' },
    ])
    run()

    expect(calls[0].payload).toMatchObject({
      shift: 'morning',
      form_values: {
        starts_confirmed: ['W12 - Slab'],
        free_notes: 'Crew arrives at 8',
        targets_selected: [],
      },
    })
  })

  it('warns about the headcount questions this form does not have', () => {
    const { run, logs } = setup('morning-form.gs', questions, [])
    run()
    expect(logs.join('\n')).toContain('Barbenders')
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
