# AI Transformation Studio

**Live demo:** <https://ai-transformation-studio.vercel.app> · **Source:** <https://github.com/ArthurzWong/ai-transformation-studio>

A working client–server web app implementing this blueprint pipeline, stage for stage:

```
Human Strategist
      │
      ▼
  Grok Bot (Orchestrator)
      │
 ─────┼──────────────┐
 ▼    ▼              ▼
Web   Files      Business Logic     ← three parallel research tracks
 └────┼──────────────┘
      ▼
  ModelScope (LLM · Speech · Vision · Multimodal · Embedding)
      │
      ▼
  AI Transformation Brief
      │
      ▼
  Human Approval        ← pipeline halts here without sign-off
```

## Quick start

Requirements: **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no npm install, no build step).

```bash
cd ai-transformation-studio
npm start          # or: node server.js
# → http://127.0.0.1:8788
```

A seeded sample run (invoice-processing automation, status `awaiting_approval`) is created on first start so the app is explorable immediately. Open **🕘 Runs** in the header to load it, or start a new run from Stage 1.

## Deployment

### Vercel (demo deployment)

```bash
npm i -g vercel   # once
vercel            # preview deploy (links the project, zero config)
vercel --prod     # production alias (optional)
```

How it works on Vercel:

- `public/` is served as static assets (zero-config routing).
- `api/[...path].js` is the catch-all serverless function for every `/api/*` route (`vercel.json` sets `maxDuration: 30`).
- The pipeline executes synchronously inside the create-run request (demo mode ≈ 3 s); the client renders the returned state directly.
- **Ephemeral data**: serverless functions get a read-only filesystem except per-instance `/tmp`, so the SQLite database lives in `/tmp` and resets on cold starts; runs created on the shared deployment are transient. This is the documented demo mode — for the **persistent** deployment (data survives restarts, audit trail retained), run `node server.js` locally or on any long-lived host.
- `ATS_DATA_DIR` env var overrides the database directory in both modes.

### Any long-lived host (persistent deployment)

```bash
node server.js     # binds 127.0.0.1:8788; put a reverse proxy (nginx/caddy) in front for TLS
```

Data lives in `data/studio.db` (SQLite, WAL mode). Back up that file to back up everything.

## What each stage does

| Stage | Blueprint element | Implementation |
|---|---|---|
| 1 | **Human Strategist** | Goal (required, validated), industry/context, constraints, success criteria + 3 one-click example briefs. Creates a persisted run. |
| 2 | **Grok Bot (Orchestrator)** | Server decomposes the intent into a dispatch plan; timestamped console shows every orchestrator action. Live mode uses the xAI Grok chat API for planning + brief generation. |
| 3 | **Web / Files / Business Logic** | Three workers run **in parallel** (`Promise.all`) on the server; each produces 4 findings; every finding is persisted with track + seq + source (`demo` / `modelscope` / `reviewer`). |
| 4 | **ModelScope hub** | Five categories (LLM/NLP, Speech, Vision, Multimodal, Embedding/Specialist) with real ModelScope model IDs. Orchestrator pre-selects 6 slots (2 per track, marked IN USE). Override any slot — validated against category, persisted — then recompile the brief. |
| 5 | **AI Transformation Brief** | 8-section markdown dossier (Exec Summary → Current State → Opportunity Map → Model Stack → Roadmap → Risks → KPIs → Sign-off). Copy or download as `.md`. Every generation stored as a numbered revision. |
| 6 | **Human Approval** | Pipeline halts at `awaiting_approval`. Approve (named sign-off closes the run) · Request changes (feedback becomes a new revision) · Reject (archived). Full timestamped audit trail. |

## Modes

| Mode | Behavior | Needs |
|---|---|---|
| **Demo** (default) | Full pipeline with goal-aware simulated findings | Nothing |
| **Live** | Grok (xAI) plans & compiles the brief; ModelScope generates track findings | Keys via ⚙ Settings |

Live-mode keys are stored **server-side** in the SQLite `settings` table and are never returned in full by the API (masked to last 4 chars). Provider calls are made by the server, so there are **no browser CORS issues** — no relay needed.

Defaults: Grok model `grok-4-fast` at `https://api.x.ai/v1`; ModelScope model `Qwen/Qwen2.5-72B-Instruct` at `https://api-inference.modelscope.cn/v1`. Both model IDs configurable in Settings.

## Architecture

```
ai-transformation-studio/
├── server.js          ← local entry: persistent SQLite in ./data, live-progress pipeline
├── lib/app.js         ← shared app core (routes, pipeline, persistence)
├── api/[...path].js   ← Vercel serverless entry: catch-all /api/*, /tmp SQLite, sync pipeline
├── public/            ← static frontend (Takram-styled UI + client logic)
├── docs/screenshots/  ← verification captures
├── data/              ← SQLite database (runtime, gitignored; auto-created + seeded)
├── BLUEPRINT_PLAN.md  ← blueprint → feature plan mapping (source-of-truth extraction)
├── ACCEPTANCE.md      ← point-by-point acceptance checklist with test results
├── index.html         ← legacy single-file prototype from iteration 1 (superseded; kept for reference)
├── proxy.py           ← legacy CORS relay from iteration 1 (obsolete — provider calls are server-side now)
├── vercel.json        ← serverless function config (maxDuration)
└── package.json
```

**Stack:** Node built-in `http` server + `node:sqlite` persistence; vanilla-JS SPA frontend with run-state polling. No frameworks, no build step, no external dependencies. The same `lib/app.js` core powers both the local server and the Vercel function.

**State machine:** `running → awaiting_approval → approved | rejected`, with `request_changes` looping back through a new brief revision. If the server restarts mid-run, `recoverInterruptedRuns()` restores runs from persisted state (runs with a compiled brief return to the approval gate; unfinished ones resume execution).

**API surface** (all JSON):

```
GET    /api/runs                          list runs
POST   /api/runs                          create run {goal, industry?, constraints?, criteria?}
GET    /api/runs/:id                      full run (findings, slots, briefs, decisions)
PATCH  /api/runs/:id/models               override slot {slot_key, model_id}
POST   /api/runs/:id/recompile            new brief revision from current selections
POST   /api/runs/:id/decision             {action: approve|request_changes|reject, signer?, feedback?}
GET    /api/runs/:id/brief.md             download latest brief as markdown
GET    /api/settings                      masked provider settings
PUT    /api/settings                      update mode/keys/models ("CLEAR" removes a key)
```

**Data model:** `runs`, `findings(run_id, track, seq, content, source)`, `model_slots(run_id, slot_key, category, model_id, role, custom)`, `briefs(run_id, revision, markdown, note)`, `decisions(run_id, actor, action, created_at)`, `settings(key, value)`.

## Modifying it

| Change | Where |
|---|---|
| Model catalog / default slots | `CATALOG` / `SLOTS` in `server.js` (frontend copy in `public/app.js`) |
| Example briefs | `PRESETS` in `public/app.js` |
| Brief section structure | `briefMarkdown()` + the live system prompt in `compileBrief()` in `server.js` |
| Simulated findings | `simPlan()` in `server.js` |
| Provider endpoints/models | ⚙ Settings, or `getProviderSettings()` defaults in `server.js` |
| Theme / colors | CSS variables in `public/index.html` (`:root`) |

## Known limitations

- **Prototype-grade security**: no authentication (per goal-brief default); bind to `127.0.0.1` only; do not expose to the public internet as-is.
- **Simulated research**: demo findings are illustrative samples generated from the goal text — not real market data. Real research requires plugging real search/file sources into the track workers.
- **Single-operator gate**: approval decisions are attributed by typed name, not authenticated identity.
- **Track inputs**: Files track reads a simulated corpus; wiring a real document store is the first recommended extension.
- **SQLite concurrency**: fine for single-user/staging use; switch to Postgres for multi-user production.
