// Morning form — Apps Script (form-bound, installable "On form submit" trigger).
// Also add volecule-common.gs and volecule-photos.gs to this project; they
// provide the question check and syncFormPhotos(). See README.md.
//
// The morning form has no photo question today. Photo support is wired in
// anyway, so adding a file-upload question to it later just works.

const INGEST_URL =
  'https://volecule-main.vercel.app/api/integrations/google-forms/submit'
const INGEST_SECRET = '<PASTE INGESTION_SHARED_SECRET>' // must match Vercel env var INGESTION_SHARED_SECRET
const SHIFT = 'morning'
const SITE_CODE = '<PASTE PROJECT PUBLIC CODE>' // the project's code from its detail page; identical in the evening script

// Question titles exactly as they appear on THIS form. Run listFormQuestions()
// once to see them (it shows stray spaces too). Delete the line for any
// question this form doesn't have. A title that isn't on the form is reported
// in the execution log on every submission instead of silently sending nothing.
const QUESTIONS = {
  starts: 'Which of these are being started today?', // the tasks ticked as started today
  notes: 'Morning Notes',
  targetsSelected: 'Which of these will be completed by EOD today?',
  siteEngineer: 'Site Engineer',
  headcount: {
    barbenders: 'Barbenders',
    carpenters: 'Carpenters',
    masons: 'Masons',
    helpers: 'Helpers',
    operators: 'Operators',
    others: 'Others',
  },
  weather: 'Weather(AM)',
  blocker: 'Anticipated Blockers',
}

// Question titles are matched ignoring capitalisation and extra spaces, so
// "Evening notes" and "Evening Notes" are the same question. Wording and
// punctuation still have to match.
function normalizeKey(key) {
  return String(key).trim().replace(/\s+/g, ' ').toLowerCase()
}

function getNamedValuesFromEvent(e) {
  if (!e)
    throw new Error(
      'No event object. Run via form submit trigger, not manual Run.',
    )

  let raw
  if (e.namedValues) {
    raw = e.namedValues
  } else if (e.response) {
    raw = {}
    e.response.getItemResponses().forEach((ir) => {
      const response = ir.getResponse()
      raw[ir.getItem().getTitle()] = Array.isArray(response)
        ? response
        : [String(response ?? '')]
    })
  } else {
    throw new Error('Unsupported trigger event shape.')
  }

  // Google Forms can bake leading/trailing whitespace into a question's title
  // — normalize every key so lookups aren't broken by it.
  const normalized = {}
  Object.keys(raw).forEach((key) => {
    normalized[normalizeKey(key)] = raw[key]
  })
  return normalized
}

function firstValue(namedValues, key) {
  const v = namedValues[normalizeKey(key)]
  return Array.isArray(v) && v.length > 0 ? v[0] : null
}

function allValues(namedValues, key) {
  const v = namedValues[normalizeKey(key)]
  if (!Array.isArray(v)) return []
  return v.filter(
    (x) => x !== null && x !== undefined && String(x).trim() !== '',
  )
}

function onFormSubmit(e) {
  warnAboutMissingQuestions_(QUESTIONS)
  const namedValues = getNamedValuesFromEvent(e)

  const submittedAt = e.response
    ? new Date(e.response.getTimestamp()).toISOString()
    : new Date().toISOString()

  // Stable per submission — do NOT append Date.now(), or retries stop deduping.
  const externalId = e.response ? e.response.getId() : `manual-${Date.now()}`

  const payload = {
    site_code: SITE_CODE,
    shift: SHIFT,
    external_submission_id: externalId,
    submitted_at: submittedAt,
    form_values: {
      site_engineer: QUESTIONS.siteEngineer
        ? firstValue(namedValues, QUESTIONS.siteEngineer)
        : null,
      headcount: QUESTIONS.headcount
        ? mapObject_(QUESTIONS.headcount, (title) =>
            firstValue(namedValues, title),
          )
        : null,
      targets_selected: QUESTIONS.targetsSelected
        ? allValues(namedValues, QUESTIONS.targetsSelected)
        : null,
      starts_confirmed: allValues(namedValues, QUESTIONS.starts),
      weather_am: QUESTIONS.weather
        ? firstValue(namedValues, QUESTIONS.weather)
        : null,
      anticipated_blocker: QUESTIONS.blocker
        ? firstValue(namedValues, QUESTIONS.blocker)
        : null,
      free_notes: firstValue(namedValues, QUESTIONS.notes),
    },
    // Drive file ids of every uploaded photo, kept with the log so a photo
    // that fails to sync below can always be recovered from Drive.
    photos_drive: listPhotoFilesSafely(e),
  }

  const res = UrlFetchApp.fetch(INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Volecule-Secret': INGEST_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  })

  Logger.log('Status: ' + res.getResponseCode())
  Logger.log('Body: ' + res.getContentText())

  // Photos attach to the log, so only sync them once the log was accepted.
  if (res.getResponseCode() === 200) {
    syncFormPhotos(e, externalId)
  } else {
    Logger.log('Skipping photo sync: the form data was not accepted.')
  }
}
