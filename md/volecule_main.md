# VOLECULE — HANDOFF DOCUMENT

## Quick orientation

- Pilot: Shivalik commercial floors; Clients: Manish Sabani (day-to-day) + Lavina Kapoor, via one WhatsApp group.
- Volecule is already a functioning consultancy (~25% savings, 8-day designs). The buyer/willingness-to-pay question is retired for this pilot — clients already trust and use the service.
- V1's real job: remove the founder as the single bottleneck. Nothing else.
- Two locked decisions: (1) thin slice only; (2) flag-don't-propagate for delays.
- Open dependency you still owe yourself: Rebant's actual 8–12 red-flag checklist items (Stage 2, Tier 0 Q4).
- Watch-out: don't let scope re-expand to the full site-operating-system Rebant described — that gap is what kills a 2-week build.

## STAGE 1 — STRATEGY CHECK

### Core value proposition

"An independent, always-on record of what's actually happening on your construction site — so you catch overbilling, delays, and quality problems before they cost you." The wedge is trust asymmetry: the client can't be on site; Volecule is their eyes and makes the invisible (material usage vs billing, schedule slippage, workmanship) legible. The report is not the product — the product is confidence and leverage. The moat is the analyst-vetting layer + accumulated project context, not the AI.

### Target audience — who signs the check

- Primary (v1): the individual Delhi-NCR homeowner building a single ₹40L–₹2Cr house, not present daily, afraid of being cheated.
- Secondary (later): small developers/builders with 2–5 concurrent sites who can't visit daily.
- NOT large developers/GCs — they have their own PM software and no incentive to invite an independent auditor; they're who you audit against.
- [Updated by founder in conversation: v1 is INTERNAL, serving people who already trust Volecule (Rebant's relationships), and includes big builders who can't visit sites daily. This retires the CAC problem for v1 but makes report-accuracy MORE important, since trusting clients act without scrutiny.]

### Top 3 risks + mitigation

1. Garbage in, garbage out. The site engineer may be aligned with the contractor you're surveilling; a vague form yields fluent-but-wrong reports. Mitigation: define a minimum structured daily log with required timestamped/geostamped photos; test with Rebant role-playing a lazy/adversarial engineer before writing report code.
2. Liability without domain knowledge. A wrong "all normal" report gives false assurance and creates exposure. The analyst step is doing enormous load-bearing work and is under-specified. Mitigation: make analyst sign-off a structured checklist (8–12 binary red-flag items from Rebant); no report ships without a recorded sign-off.
3. Business-model risk. Per-project consulting = low recurring revenue, one-time buyers, easily-copied AI. The real assets are Rebant's know-how and the analyst network. Mitigation: run a one-day willingness-to-pay test before building. [Largely retired for the internal/trusted pilot.]

### Pushbacks on the original concept

1. 2-week target is unrealistic for a trustworthy client-facing product; realistic only for a thin internal analyst tool. Build internal; keep clients out of the loop until quality is proven.
2. The full pipeline (Forms→RDS→S3→Claude→S3) is premature before proving one report has value. Consider a manual "Wizard of Oz" pilot on one live site first.
3. Drop "saving clients money" as the headline until provable; lead with "independent transparency + audit trail."
4. Don't model financials until Rebant defines what "money saved" is measured against.
5. Per-project running Summary.md is a smart, cheap memory idea — keep it, cap its length, analyst edits it on approval.

## STAGE 2 — QUESTIONS FOR REBANT (with his answers folded in)

Purpose: close domain gaps on (a) daily log contents, (b) financials scope, (c) the analyst sign-off checklist. Two audiences: homeowner ("am I being cheated?") vs builder ("which site needs me today?").

### Tier 0 — before any code

- Pilot site: Shivalik commercial floors; clients Manish + Lavina; coordination today via WhatsApp/verbal/occasional Claude PDFs.
- Problem solved: client has no time to manage vendors/decisions/quotations; Volecule is the single point of orchestration.
- Week-1 success metric: speed (3 designs in 8 days; ~75% basement flooring done fast) + ~25% cost savings vs market.
- Today's workflow: no permanent on-site staff; vendors send updates on request; founder condenses → posts to WhatsApp; not standardized.
- Biggest bottleneck: EVERYTHING flows through the founder → delays, forgotten updates.
- STILL OWED: the 8–12 binary red-flag conditions an analyst must confirm/deny per report. This is the liability firewall and has NOT been answered.

### Tier 1 — daily log (Rebant's spec)

Site engineer submits TWICE daily:

- Morning: team-wise headcount; timestamped + geostamped photo proof each team is present; select expected targets from a dropdown auto-generated from the approved schedule.
- Evening: how many morning workers still present; photos of work completed; mark which morning targets were achieved (misses need a reason).

### Tier 2 — financials (Rebant's answers)

- Wants V1 to track every financial transaction on/for/by the site, including contractor petty cash / spot purchases made in Volecule's absence. [STRATEGIST FLAG: petty-cash-in-absence is an evidence problem, not software; deferred to v2.]
- No approval workflow in v1 (tracking only).
- Site engineer enters cost data. Outputs required: weekly spend snapshot, budget-vs-actual variance, upcoming cash requirement.
- Budget baseline exists because Volecule sets the plan and rates itself → reconciliation is feasible in principle.

### Tier 3 — report shape (Rebant's answers)

- Weekly report contents in order: (1) Targets for the week with achieved/not + reasons for misses; (2) Vendor efficiency per team (e.g., carpenters 6/10, steel 18/20); (3) Expense tracker (bills, weekly total, cumulative, remaining work, next-week cash, total remaining requirement).
- Report is internal-first: Volecule vets, then sends to Manish + Lavina.
- Tone: reassuring/confidence-building, but clearly alert the client if something serious is wrong.
- Missed target → name responsible vendor TEAM (not individual) + reason; and the schedule must update dependent downstream tasks (propagation).
- Three core weekly deliverables: Monday target plan, Sunday progress report, weekly expense tracker.
- 90-day success: client stops calling for routine updates; calls reserved for exceptions; vendor/contractor efficiency becomes measurable.

## STAGE 3 — BUILD PLAN: V1 (THIN SLICE)

### Scope lock

IN v1: schedule as a flat task list per site → auto-generated daily questions → structured twice-daily logs (geo/timestamped photos, headcount, target selection) → Claude drafts the Sunday weekly report → analyst vets & edits → approved report posted to client WhatsApp group. Bills/quotations logged as simple records with a running total.

CUT from v1 (staged): CPM schedule-propagation engine (v2); automated vendor-efficiency SCORING (v1.5 — analyst reads raw numbers); petty-cash/spot-purchase capture (v2); transaction approvals (Rebant said no); client dashboard/portal (v2 — WhatsApp is the channel).

DELAY HANDLING (flag-don't-propagate): a missed target is logged with responsible vendor + reason and surfaced in the report; the analyst manually edits affected dates during vetting. Software stores dates; humans move them. Real propagation engine is v2.

If you slip, cut in this order: (1) auto-generated questions → fixed daily form; (2) financials logging; (3) report formatting → plain text. Protect the log-capture pipeline above all.

### Three phases & milestones

- Phase A — Capture (Days 1–5). Milestone: engineer submits a real morning+evening log; photos in S3, structured data in RDS; you can query "what happened today." No AI yet.
- Phase B — Generate (Days 6–10). Milestone: a week of logs + schedule + Summary.md → Claude Sunday draft in Q17 order → lands in S3 → analyst can read it. Bills logging works.
- Phase C — Vet & Deliver (Days 11–14). Milestone: analyst edits a draft, records red-flag sign-off, approves; final exported WhatsApp-ready and posted. One full real cycle on Shivalik.

### Data model (confirm cardinality with Rebant)

- clients (one → many projects)
- projects
- sites (model site = floor/space for Shivalik if needed)
- schedule_tasks: id, site_id, name, vendor_team, planned_start, planned_end, status[pending/in_progress/done/missed], depends_on (nullable — STORED, not acted on in v1), notes
- daily_questions: id, site_id, date, question_text, source_task_id
- site_logs: id, site_id, date, shift[morning/evening], submitted_by, headcount_json, targets_selected_json, targets_achieved_json, free_notes, created_at
- log_photos: id, site_log_id, s3_key, taken_at, geo_lat, geo_lng, caption, metadata_missing
- vendors: id, name, trade
- bills: id, site_id, vendor_id, description, amount, bill_date, s3_key, type[quotation/bill], entered_by
- reports: id, site_id, week_start, status[draft/vetted/approved], s3_key_draft, s3_key_final, generated_at, approved_by, approved_at
- report_signoffs: id, report_id, checklist_json, signed_by, signed_at
- Summary.md per site in S3; analyst-edited on approval; cap ~2 pages

### Micro-tasks ([core]=protect, [optional]=cut first)

#### Phase A — Capture

A1. Skeleton: RDS + S3 + tiny backend. [core] Steps: provision small Postgres RDS + one private S3 bucket (prefixes photos/, reports/, summaries/); minimal backend with /health + DB connection; secrets in env vars. DoD: /health returns 200 with a live DB ping; upload a test file to S3 and read it back.

A2. Schema. [core] Steps: migrations for tables above; seed clients, one project, one site (Shivalik), 2–3 vendors. DoD: all tables exist; you can SELECT the seeded site and its vendors.

A3. Load Shivalik schedule into schedule_tasks. [core] Steps: get current plan from Rebant (even rough week); insert with dates, vendor_team, status=pending; fill depends_on where known (stored only). DoD: querying tasks due on a given date returns the right rows.

A4. Morning log form. [core] Steps: fields = team-wise headcount, target multi-select (options from A6), photo upload (≥1 required), notes; mobile-friendly hosted form posting to backend (NOT raw Google Forms — need dynamic dropdown). DoD: engineer submits on phone; a site_logs (morning) row + log_photos appear.

A5. Evening log form. [core] Steps: fields = remaining headcount, photos of completed work, mark which morning targets achieved (pull morning selections), reason for misses. DoD: evening submission references same day's morning log; records achieved/missed with reasons.

A6. Auto-generate daily questions / target dropdown. [core] Steps: each morning query schedule_tasks where date in [planned_start, planned_end] and status != done; turn into daily_questions + morning-form dropdown; generate on form-load (no scheduler needed). DoD: opening the form on two different dates yields different, correct target options. (Kills Rebant's #1 pain, Q11.)

A7. Enforce photo metadata. [core] Steps: on upload read EXIF/browser geolocation; store taken_at, geo_lat/lng; if missing, flag metadata_missing=true (don't reject). DoD: a submitted photo shows real timestamp + coords; a stripped photo is stored but flagged.

#### Phase B — Generate

B1. Assemble report input packet. [core] Steps: function that, for (site, week), gathers both-shift logs, tasks + statuses, bills totals, Summary.md. DoD: returns one structured object with every input; verify by eye against raw DB for one week.

B2. Report prompt + Claude call. [core] Steps: prompt with B1 packet + Q17 order: (1) targets with achieved/missed + reasons; (2) vendor view = assigned vs achieved per team as RAW NUMBERS, no scoring; (3) expenses (this week, cumulative, next-week estimate stated as an assumption). Enforce Q19 tone (reassuring but flag serious issues) and Q20 (name responsible team + reason). DoD: for one real week, Claude produces a draft in correct section order; a reader learns what happened without the raw data.

B3. Persist draft + wire Summary.md. [core] Steps: save draft to reports/, create reports row status=draft; load Summary.md into prompt; append short recap after approval. DoD: draft exists in S3 + as a row; prompt visibly includes last week's summary.

B4. Bills/quotations logging. [optional — cut first] Steps: simple form (vendor, description, amount, date, bill photo, type); running total per site. DoD: three bills produce correct weekly + cumulative totals in B2's expense section.

#### Phase C — Vet & Deliver

C1. Analyst review view. [core] Steps: page listing drafts; open one → editable draft text beside source logs/photos → save edits. DoD: analyst edits, saves, edited version persists.

C2. Red-flag sign-off checklist. [core — liability firewall] Steps: render Rebant's 8–12 red-flag items (STILL OWED, Stage 2 Tier 0 Q4) as Y/N/NA + note; block Approve until all answered; on approve write report_signoffs, set status=approved, record approver + timestamp. DoD: cannot approve with an unanswered item; an approved report has a stored sign-off naming the analyst.

C3. Export WhatsApp-ready final + post. [core] Steps: on approval render clean formatted text and/or simple PDF; founder posts MANUALLY (no auto-send in v1). DoD: an approved report is exported and posted to the Manish/Lavina group in a readable form.

C4. Run one full real cycle on Shivalik. [core — the actual milestone] Steps: morning+evening logs for a real week → bills → Claude draft → analyst vet + sign-off → founder posts. DoD: Manish or Lavina receives a system-generated report and confirms it's at least as good as today's manual WhatsApp updates. (The only metric that counts.)

### Remaining pushbacks

- No auto-send to client in v1 — keep a human on the trigger; one confidently-wrong auto-sent report to a trusting client is the Stage 1 failure mode.
- Vendor scoring stays raw numbers, not an algorithm — a score invites disputes you can't defend yet; automate in v1.5 once target data is trusted.
- Don't build the two uncovered sites into v1 — prove Shivalik first; adding sites is config, not code.
- The schedule is your weakest input. Question-generation, target tracking, and delay-flagging all depend on schedule_tasks being real and maintained. If Rebant won't keep it current, the thin slice degrades to a fancy photo logger. Make schedule upkeep his explicit job.
