# Ghost Grader

## Keep this file current

**Any change to the system's architecture, data model, package layout, API
routes, environment variables, or invariants must update this file in the same
change.** If a change makes a statement here false, fix the statement; do not
leave it stale. Treat CLAUDE.md as part of the change, not documentation to
write later. The same goes for `README.md` when the change affects setup, the
demo, or anything a user reads.

## What the system is

A grading copilot that sits **alongside** an LMS, not inside it.

1. Question/answer pairs live in Ghost Grader's own store. Today they are the
   seeded demo data; a configured LMS can supply them through a pull.
2. The teacher reads each answer in the Ghost Grader web app and enters one
   grade per (student, question), plus feedback.
3. As they grade, Ghost Grader analyzes the answer against **that question's
   rubric**, flags a grade that contradicts the rubric (rubric check), and
   flags a grade that treats the same gap differently from another student's
   grade **on the same question** (consistency alert).
4. When an LMS is configured, the teacher pushes grades back to it. No LMS is
   connected by default.

Ghost Grader never grades on its own. A suggestion only becomes a grade when
the teacher clicks Submit, and nothing is written to an LMS until the teacher
pushes.

`docs/plans/` holds the original design and implementation plan. They describe
the earlier Chrome-extension version and are kept as history, not as the
current design.

## Repo map

pnpm workspace (`apps/*`, `packages/*`), TypeScript everywhere.

| Package | Path | Owns |
|---|---|---|
| `@gg/shared` | `packages/shared` | Zod schemas and types, rubric math and rollup (`rubric.ts`), drift detection (`drift.ts`), push diffing (`sync.ts`), the deterministic mock analyzer, and the seeded dataset (`data.ts`, `fixtures/`). |
| `@gg/api` | `apps/api` | Hono server on port 8787. JSON-file store, teacher scoping, LLM provider chain, grading sessions, and LMS sync behind the `LmsAdapter` interface. |
| `@gg/web` | `apps/web` | React + Vite app on port 5173: courses, grading workspace, gradebook, rubric editor. Playwright e2e lives here. |

### Data model (`packages/shared/src/schemas.ts`)

- **Assignment** → ordered **Questions** (embedded). A question carries its own
  `rubric` (criteria, point bands, closed `concepts` vocabulary), `anchors`,
  optional `totalPoints`, and `lmsQuestionId`.
- **Student**, and **Answer** keyed by `(questionId, studentId)`, with
  `studentIndex` (roster position) and `lmsAnswerId`.
- **Decision**: one submitted grade for one answer, id `${answerId}:grade`, with
  the suggestion at the time, missing concepts, and the teacher's comment.
- **AnalysisResult** / **ScoreCheck** / **DriftAlert**: all per question.
- **PushRecord**: what was sent to an LMS, kept separate from Decision so a
  re-grade cannot erase the fact that a grade was already pushed.
- Assignment grades are **computed** by `rollUp` (`rubric.ts`), never stored.

Seed: `chem-haber-eq` has Q1 (`q-haber-1`, 6 criteria, 30 pts, 15 answers
`sub-01`..`sub-15` with ground truth) and Q2 (`q-haber-2`, 3 criteria, 15 pts, 5
answers `q2-sub-*`, no ground truth, so it exercises the heuristic analyzer).
Q1 answer ids must stay `sub-01`..`sub-15`: `ground-truth.json` and
`fixtures/analysis/*.json` are keyed by them. Q1 and Q2 deliberately share the
tag `quantitative_reference` to prove per-question scoping.

A second seeded assignment, `eng8-open-ended` (course `c-eng8`, also `t-demo`),
is a Grade 8 English exam with five short-answer questions and a separate
10-student roster (`stu-e01`..`stu-e10`). Q1 is a written comparison (1 criterion,
10/5/0), Q2 and Q3 are listening tasks (1 criterion, 5 points per correct menu
item out of 20), Q4 is a dialogue question (10/5/0), and Q5 is a paragraph with a
3-criterion analytic rubric (4 pts each). All 50 answers (`e-q<n>-<nn>`) have
ground truth. Fixtures are in `fixtures/english8/`, and `data.ts` merges its
ground truth into `groundTruth` (answer ids are unique across assignments). The
store seeds from `seededAssignments` / `seededStudents` / `seededAnswers`.

### API routes (`apps/api/src/app.ts`)

Public: `GET /health` (analyzer mode, `lms` name or null), `GET /teachers`.
Everything else requires `X-Teacher-Id`.

- Data: `GET /me`, `GET|POST /courses`, `GET|POST /assignments`,
  `GET|PUT /assignments/:id`, `GET|POST /assignments/:id/answers`
  (`?questionId=`), `GET /assignments/:id/grades` (rollup).
- Grading: `POST /analyze {assignmentId, questionId, answerId}` (the answer is
  loaded server-side), `POST /decision`, `POST /override`, `POST /aligned`,
  `POST /check-raised`, `POST /check-approved`, `GET|DELETE /session/:assignmentId`.
- Sync: `GET /sync/available`, `POST /sync/pull`, `GET /sync/status/:assignmentId`,
  `POST /sync/push`. With no LMS configured they return 400 "No LMS is
  configured" (status returns `{ linked: false, lms: null }`).

### Web app (`apps/web/src`)

Hash routes: `#/` home, `#/grade/:assignmentId/:questionId[/:answerId]`,
`#/grades/:assignmentId`, `#/rubric/:assignmentId`, `#/rubric/new/:courseId`.
Grading logic is the `useGrading` hook (`grading/useGrading.ts`); the page owns
the grade and comment as form state. Panel tabs are in `grading/tabs/`.

## Invariants: do not break these

- **Points come from the rubric, never from the model.** `finalizeAnalysis`
  (`packages/shared/src/rubric.ts`) maps the chosen band to points.
- **Missing concepts are filtered to the criterion's closed `concepts`
  vocabulary.** That is what keeps checks explainable.
- **Comparison is per question and deterministic.** `detectDrift`
  (`packages/shared/src/drift.ts`) only compares decisions with the same
  `questionId`, from other students, by offset from the suggestion. No model call.
- **Typing is a draft; only Submit records a Decision.** Grades applied by
  Use/Align/Approve are drafts too and must not be overwritten by a session
  refresh (`views/Grade.tsx` tracks this with `touched`).
- **Pushing to an LMS is always an explicit teacher action**, and idempotent:
  `pushReference(answerId, points, comment)` is the upsert key, and
  `pendingPush` compares against the **latest** push per answer.
- **Teacher scoping:** a foreign resource returns 404, never 403.
- **Store schema:** `Store` (`apps/api/src/store.ts`) reads its JSON file with a
  plain cast. Any change to `StoreData`'s shape must bump `SCHEMA_VERSION`; a
  file on another version is discarded and reseeded. Bump it as well when the
  seed gains data that existing demo files should pick up.
- **`@gg/shared` is consumed as TypeScript source.** It has no build step;
  consumers include `../../packages/shared/src` in their tsconfig.
- **Adding an LMS** means implementing `LmsAdapter` (`apps/api/src/lms/`) and
  selecting it in `lms/select.ts`. Nothing else should know which LMS it is.
  The LMS never owns rubrics.

## Commands

```bash
pnpm install
pnpm dev          # API on 8787 and web app on 5173
pnpm build
pnpm typecheck
pnpm test         # vitest in every package
pnpm e2e          # Playwright against the web app; boots API (mock analyzer) and web itself
```

`pnpm e2e` uses ports 8787/5173 by default. If dev servers already hold them,
run with `E2E_API_PORT=18787 E2E_WEB_PORT=15173`. First run needs
`pnpm --filter @gg/web e2e:install`.

On a machine without a global `pnpm`, run it through `corepack pnpm`; the root
scripts shell out to bare `pnpm`, so a shim on PATH is needed.

## Environment (`apps/api/.env`, see `.env.example`)

- LLM provider chain, first configured is primary, the rest are fallbacks:
  `OPENROUTER_API_KEY` (+`OPENROUTER_MODEL`) → `OPENAI_API_KEY` (+`OPENAI_MODEL`)
  → `ANTHROPIC_API_KEY`. No key: deterministic mock analyzer. `GG_MOCK=1`
  forces the mock (tests do this).
- `PORT` (8787), `GG_DATA_PATH` (default `apps/api/data/ghost-grader.json`, gitignored).
- `GG_LMS` (unset: no LMS; `canvas`: stub, not implemented), `GG_LMS_BASE_URL`, `GG_LMS_TOKEN`.
- Web: `VITE_API_BASE` (default `http://localhost:8787`).
