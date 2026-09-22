# Acceptance Checklist — Blueprint Coverage

Blueprint: the user-supplied pipeline diagram (2026-09-19). Feature extraction: [BLUEPRINT_PLAN.md](BLUEPRINT_PLAN.md).
Every check below was executed against the running app at http://127.0.0.1:8788 on 2026-09-19.

## A. Blueprint elements (nothing dropped)

| # | Blueprint requirement | Implementation location | Test & result |
|---|---|---|---|
| B1 | Human Strategist inputs feed the orchestrator | `POST /api/runs` → `runs` table; Stage 1 panel | T2 run created (`6fc911b6`); T11 empty goal rejected with 400 — **PASS** |
| B2 | Grok Bot orchestrator decomposes & dispatches | `executeRun()` in `server.js`; console derived from `decisions` rows | T3 plan persisted; orchestrator log lines rendered in UI (DOM check) — **PASS** |
| B3 | Web Research track | `findings(track='web')` | T3: 4/4 web findings persisted; rendered in track card — **PASS** |
| B4 | Files track | `findings(track='files')` | T3: 4/4 files findings; rendered — **PASS** |
| B5 | Business Logic track | `findings(track='business')` | T3: 4/4 business findings; rendered — **PASS** |
| B6 | ModelScope hub with LLM/NLP · Speech · Vision · Multimodal · Embedding | `CATALOG` in `server.js`; `model_slots` table; Stage 4 UI | T3: 6 slots across 5 categories; T5 override `files:1 → Qwen/Qwen2-VL-7B-Instruct` persisted (`custom=1`); wrong-category override rejected 400; rendered with 6 IN USE tags — **PASS** |
| B7 | AI Transformation Brief | `briefs` table; `briefMarkdown()` + `compileBrief()`; Stage 5 UI + `.md` download | T4: all 8 sections present; revision history (3 briefs for run `6fc911b6`); `GET …/brief.md` served as attachment — **PASS** |
| B8 | Human Approval terminal gate | `runs.status` state machine; `decisions` audit; Stage 6 UI | T7 request_changes → rev 3 with reviewer findings + revision note in brief; T8 approve w/ signer → `approved`, sign-off in brief; T9 double-decision blocked 409; T10 reject → `rejected` + REJECTED stamp — **PASS** |

## B. Goal Brief criteria

| Criterion | Evidence | Result |
|---|---|---|
| Blueprint content confirmed before build | [BLUEPRINT_PLAN.md](BLUEPRINT_PLAN.md) written before coding; ambiguities resolved in its §4 | **PASS** |
| Every feature in the blueprint works | Checks B1–B8 above; 11/11 API tests + 12/12 rendered-DOM checks | **PASS** |
| Main user journey completes without errors | Journey: open app → seed run loads → strategist form → pipeline runs → tracks parallel → hub override → brief compiled → approve signed. Verified via API walk (T2–T8) + headless-Chrome DOM checks on the deep-linked approved run | **PASS** |
| Entered data saved and retrievable after restart | Server killed & restarted; `runs`=3, `findings`=38, `model_slots`=18, `briefs`=5, `decisions`=24 rows intact; slot override & sign-off persisted; run fully reloadable via UI Runs dialog and `?run=<id>` deep link | **PASS** |
| Acceptance checklist proves coverage | This document, mapping every blueprint node to implementation + test | **PASS** |
| Project handoff-able from docs alone | [README.md](README.md): quick start (Node ≥ 22.5, `npm start`), architecture, API surface, data model, modification guide, known limitations; clean-machine re-run = clone folder + `node server.js` | **PASS** |

## C. Verification log (executed)

1. **Syntax**: `node --check server.js` ✓ · `node --check public/app.js` ✓
2. **API suite** (11 tests): seed present · run creation · pipeline to gate (12 findings, 6 slots, 1 brief, plan summary) · 8/8 brief sections · slot override + category guard · recompile rev 2 · request_changes rev 3 (+2 reviewer findings, revision note in brief) · approve w/ signer · double-decision 409 guard · reject flow · empty-goal validation — **ALL PASS**
3. **Persistence across restart**: kill → restart → all rows intact (counts above), override & audit intact — **PASS**
4. **UI wiring**: 48/48 element IDs referenced by `app.js` exist in `index.html`; 6/6 stage panels + rail nodes present; tags balanced — **PASS**
5. **Rendered UI (headless Chrome DOM)**: 12/12 checks — brief w/ overridden model, approval stamp, orchestrator console, all 3 track findings, revision directive, hub categories, 6 IN USE tags, rail states, audit entries, plan chip — **ALL PASS**
6. **Screenshots**: `ui-top.png` (1440×1000) and `ui-full.png` (1440×3400) captured; image-model review unavailable this session (vision endpoint 400), so DOM-level checks above serve as the render verification.

## D. Clean-machine test

Follow only README "Quick start": install Node ≥ 22.5 → `cd ai-transformation-studio` → `npm start` → open `http://127.0.0.1:8788`. No `npm install`, no env vars, no config. Database auto-creates and seeds. (Verified: the running instance was started exactly this way.)

## E. Deployment verification (2026-09-22)

**Refactor → re-verify (local):** post-refactor smoke suite passed — prior data intact (3 runs), create-run returns `{id, run}` envelope, pipeline completes (12 findings / 6 slots / 1 brief), approve succeeds, static assets serve with the updated client.

**Vercel-mode simulation (local, `VERCEL=1 ATS_DATA_DIR=/tmp/...`):** synchronous in-request pipeline completed in 2.4 s; `/tmp` SQLite seeded on cold start. Confirms the serverless code path before deploying.

**Live production deployment — https://ai-transformation-studio.vercel.app:**

| Check | Result |
|---|---|
| D1 index served | PASS (24,395 bytes) |
| D2 app.js served | PASS (22,340 bytes) |
| D3 GET /api/settings | PASS (demo mode, masks empty) |
| D4 GET /api/runs (seed on cold start) | PASS — seeded sample present |
| D5 POST /api/runs (full pipeline in-request) | PASS — awaiting_approval, 12 findings / 6 slots / 1 brief, 3.0 s |
| D6 GET brief.md | PASS (3,835 bytes, all sections) |
| D7 POST decision approve | PASS — HTTP 200, status approved, signer persisted, audit rows present (verified via direct call after a test-harness property-access bug produced a false negative) |

**Known deployment limitation (documented in README):** Vercel's serverless filesystem is read-only except per-instance `/tmp`, so the SQLite database is transient there — runs reset on cold starts. The persistent deployment (surviving restarts, full audit retention) is `node server.js` on a long-lived host. Git: commit `683846f` (app) + deployment-verification docs commit; project `ai-transformation-studio` under scope `arthurzwong`.
