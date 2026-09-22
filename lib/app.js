/**
 * AI Transformation Studio — shared app core
 *
 * Blueprint pipeline:
 *   Human Strategist → Grok Bot (Orchestrator)
 *     → [Web Research | Files | Business Logic] (parallel)
 *     → ModelScope model hub → AI Transformation Brief → Human Approval
 *
 * Zero-dependency: Node built-ins only (http, fs, path, node:sqlite, fetch).
 * Used by BOTH entry points:
 *   - server.js          (local:  persistent SQLite in ./data, async pipeline)
 *   - api/[...path].js   (Vercel: transient SQLite in /tmp,  synchronous pipeline)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const ON_VERCEL = !!process.env.VERCEL;
const DATA_DIR = process.env.ATS_DATA_DIR || (ON_VERCEL ? "/tmp" : path.join(ROOT, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "studio.db"));

/* ================= schema ================= */
db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  industry      TEXT DEFAULT '',
  constraints   TEXT DEFAULT '',
  criteria      TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',   -- running|awaiting_approval|approved|rejected
  current_stage TEXT DEFAULT 'strategist',
  plan_summary  TEXT DEFAULT '',
  revision      INTEGER DEFAULT 1,
  signer        TEXT,
  approved_at   TEXT,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS findings (
  run_id  TEXT,
  track   TEXT,             -- web|files|business
  seq     INTEGER,
  content TEXT,
  source  TEXT,             -- demo|modelscope|reviewer
  PRIMARY KEY (run_id, track, seq)
);
CREATE TABLE IF NOT EXISTS model_slots (
  run_id   TEXT,
  slot_key TEXT,            -- '<track>:<idx>'
  category TEXT,
  model_id TEXT,
  role     TEXT,
  custom   INTEGER DEFAULT 0,
  PRIMARY KEY (run_id, slot_key)
);
CREATE TABLE IF NOT EXISTS briefs (
  run_id    TEXT,
  revision  INTEGER,
  markdown  TEXT,
  note      TEXT,
  created_at TEXT,
  PRIMARY KEY (run_id, revision)
);
CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  actor      TEXT,
  action     TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

/* ================= model catalog (ModelScope hub) ================= */
const CATALOG = [
  { key: "llm", label: "LLM / NLP", models: [
    { id: "Qwen/Qwen2.5-72B-Instruct",   desc: "General reasoning, drafting, summarization" },
    { id: "deepseek-ai/DeepSeek-V3",     desc: "Strong analytical reasoning, long context" },
    { id: "Qwen/Qwen2.5-14B-Instruct",   desc: "Cost-efficient workhorse for high volume" },
  ]},
  { key: "speech", label: "Speech", models: [
    { id: "iic/SenseVoiceSmall",         desc: "Multilingual ASR with emotion/event tags" },
    { id: "iic/speech_paraformer-large", desc: "High-accuracy Chinese/English transcription" },
    { id: "iic/CosyVoice2-0.5B",         desc: "Natural TTS voice generation" },
  ]},
  { key: "vision", label: "Vision", models: [
    { id: "Qwen/Qwen2-VL-7B-Instruct",   desc: "Document & chart understanding" },
    { id: "PaddlePaddle/PaddleOCR",      desc: "Production OCR for scans and receipts" },
    { id: "IDEA-Research/GroundingDINO", desc: "Open-vocabulary object detection" },
  ]},
  { key: "multimodal", label: "Multimodal", models: [
    { id: "Qwen/Qwen2-VL-72B-Instruct",  desc: "Image+text reasoning over mixed documents" },
    { id: "OpenGVLab/InternVL2-8B",      desc: "Balanced multimodal understanding" },
  ]},
  { key: "embed", label: "Embedding / Specialist", models: [
    { id: "BAAI/bge-large-zh-v1.5",      desc: "Retrieval embeddings for knowledge bases" },
    { id: "BAAI/bge-reranker-large",     desc: "Second-stage reranking for RAG" },
    { id: "iic/nlp_gte_sentence-embedding_chinese-large", desc: "Sentence embeddings, clustering" },
  ]},
];

/* 2 slots per track, pre-arbitrated by the orchestrator */
const SLOTS = {
  web: [
    { cat: "llm",       idx: 0, role: "Summarize & synthesize sources" },
    { cat: "embed",     idx: 0, role: "Retrieve & rank evidence" },
  ],
  files: [
    { cat: "multimodal", idx: 0, role: "Parse mixed-format documents" },
    { cat: "vision",     idx: 1, role: "OCR scanned pages" },
  ],
  business: [
    { cat: "llm", idx: 1, role: "Process analysis & ROI modeling" },
    { cat: "llm", idx: 2, role: "High-volume drafting at low cost" },
  ],
};
function modelId(catKey, idx) { return CATALOG.find(c => c.key === catKey).models[idx].id; }
function categoryOfModel(modelIdStr) {
  const cat = CATALOG.find(c => c.models.some(m => m.id === modelIdStr));
  return cat ? cat.key : null;
}

/* ================= settings ================= */
function getSetting(k) { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? r.value : ""; }
function setSetting(k, v) { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(k, v); }
function getProviderSettings() {
  return {
    mode: getSetting("mode") || "demo",
    grokKey: getSetting("grokKey"),
    grokModel: getSetting("grokModel") || "grok-4-fast",
    grokBase: getSetting("grokBase") || "https://api.x.ai/v1",
    msToken: getSetting("msToken"),
    msModel: getSetting("msModel") || "Qwen/Qwen2.5-72B-Instruct",
    msBase: getSetting("msBase") || "https://api-inference.modelscope.cn/v1",
  };
}
function isLive() {
  const s = getProviderSettings();
  return s.mode === "live" && !!(s.grokKey || s.msToken);
}

/* ================= helpers ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function logDecision(runId, actor, action) {
  db.prepare("INSERT INTO decisions (run_id, actor, action, created_at) VALUES (?,?,?,?)")
    .run(runId, actor, action, nowISO());
}
function updateRun(runId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(",");
  db.prepare(`UPDATE runs SET ${sets}, updated_at=? WHERE id=?`)
    .run(...keys.map(k => fields[k]), nowISO(), runId);
}
function getRun(id) { return db.prepare("SELECT * FROM runs WHERE id=?").get(id); }
function insertFinding(runId, track, seq, content, source) {
  db.prepare("INSERT OR REPLACE INTO findings (run_id,track,seq,content,source) VALUES (?,?,?,?,?)")
    .run(runId, track, seq, content, source);
}

/* ================= demo (goal-aware) simulators ================= */
function keywords(goal) {
  const stop = new Set(["the","and","for","with","that","from","into","this","must","using","our","their","have","been","will","should","without","those","these","than","then","over","such","also","more","most","when","where","which","while","about","after","before","between","during","through","under","above","each","every","both","all","any","can","are","was","were","has","had","not","but","its"]);
  return goal.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w)).slice(0, 8);
}
function simPlan(ctx) {
  const k = keywords(ctx.goal);
  const t0 = k[0] || "workflow", t1 = k[1] || "operations";
  return {
    plan_summary: `Decompose “${ctx.goal.slice(0, 70)}${ctx.goal.length > 70 ? "…" : ""}” into 3 parallel research tracks, then compile the transformation brief.`,
    web: [
      `Market scan: comparable AI deployments targeting “${t0} ${t1}” report 30–45% cycle-time reduction in published case studies (sample).`,
      "Tooling landscape: 3 viable build paths — managed platform, ModelScope-hosted open models, hybrid RAG stack (sample).",
      "Benchmark snapshot: document-centric pipelines reach >97% extraction accuracy with vision-language models + OCR fallback (sample).",
      "Adoption pattern: leaders pair automation with a human-review gate for exceptions rather than full autonomy (sample).",
    ],
    files: [
      `Indexed 12 sample artifacts (PDF/DOCX/XLSX): SOPs, ${t0} forms, spreadsheets, correspondence (demo corpus).`,
      "Extracted 3 high-value schemas: form header/line items, approval rules, step-by-step procedures (demo).",
      "Data quality: 2 fields with >15% missing values and 1 inconsistent date format flagged for cleansing (demo).",
      "Access map: documents span 4 repositories; unified ingestion layer recommended before model deployment (demo).",
    ],
    business: [
      `Process map: 7-step ${t0} flow documented; steps 2 (manual entry), 4 (validation), 6 (routing) absorb ~65% of handling time (sample).`,
      "Automation candidates: data entry + validation = highest ROI; routing benefits from rules + LLM hybrid (sample).",
      "ROI estimate (12-month): labor savings ≈2.8 FTE-equivalents, error-cost reduction ~35%, payback in 4–7 months (sample).",
      "Change risk: medium — affected roles shift toward exception handling and QA; training plan included (sample).",
    ],
  };
}
const TRACK_SYSTEM = {
  web: 'You are the "Web Research" worker. Produce exactly 4 concise market/tooling/benchmark findings as a JSON array of strings (max 160 chars each).',
  files: 'You are the "Files" worker. Produce exactly 4 concise findings about document corpus, schemas, and data quality as a JSON array of strings (max 160 chars each).',
  business: 'You are the "Business Logic" worker. Produce exactly 4 concise findings about process mapping, automation candidates, and ROI as a JSON array of strings (max 160 chars each).',
};

/* ================= live providers (OpenAI-compatible) ================= */
async function callLLM({ base, key, model, system, user, maxTokens = 1200 }) {
  const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0.4,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const txt = data.choices?.[0]?.message?.content;
  if (!txt) throw new Error("empty completion");
  return txt.trim();
}
const parseJSON = raw => JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/,"").replace(/```\s*$/, "").trim());

/* ================= pipeline executor ================= */
async function executeRun(runId) {
  const run = getRun(runId);
  if (!run) return;
  const s = getProviderSettings();
  const live = isLive();
  const ctx = { goal: run.goal, industry: run.industry, constraints: run.constraints, criteria: run.criteria };

  updateRun(runId, { status: "running", current_stage: "orchestrator" });
  logDecision(runId, "Grok Bot", `Orchestrator online (${live ? "LIVE" : "DEMO"} mode) — strategist intent received`);

  /* stage 2: plan */
  let plan = null;
  if (live && s.grokKey) {
    try {
      const raw = await callLLM({
        base: s.grokBase, key: s.grokKey, model: s.grokModel,
        system: 'You are the Grok orchestrator of an AI transformation studio. Output STRICT JSON only: {"plan_summary":"one sentence","web":["f1","f2","f3","f4"],"files":[...],"business":[...]} — each array exactly 4 concise findings.',
        user: `Goal: ${ctx.goal}\nIndustry: ${ctx.industry || "unspecified"}\nConstraints: ${ctx.constraints || "none"}\nSuccess criteria: ${ctx.criteria || "not specified"}`,
      });
      plan = parseJSON(raw);
      logDecision(runId, "Grok Bot", "Dispatch plan generated via xAI Grok API");
    } catch (e) {
      logDecision(runId, "Grok Bot", `Grok API call failed (${e.message}) — falling back to simulated plan`);
    }
  }
  if (!plan) {
    await sleep(400);
    plan = simPlan(ctx);
    logDecision(runId, "Grok Bot", "Intent decomposed into 3-track dispatch plan (simulated)");
  }
  updateRun(runId, { plan_summary: plan.plan_summary });
  logDecision(runId, "Grok Bot", "Dispatched → Track[web] · Track[files] · Track[business] (parallel)");

  /* stage 3: tracks in parallel */
  updateRun(runId, { current_stage: "tracks" });
  const trackDefs = [["web", plan.web], ["files", plan.files], ["business", plan.business]];
  await Promise.all(trackDefs.map(async ([track, fallback]) => {
    let items = fallback, source = "demo";
    if (live && s.msToken) {
      try {
        const out = await callLLM({
          base: s.msBase, key: s.msToken, model: s.msModel,
          system: TRACK_SYSTEM[track],
          user: `Goal: ${ctx.goal}\nIndustry: ${ctx.industry || "unspecified"}\nConstraints: ${ctx.constraints || "none"}`,
        });
        const arr = parseJSON(out);
        if (Array.isArray(arr) && arr.length) { items = arr.slice(0, 4).map(String); source = "modelscope"; }
      } catch (e) {
        logDecision(runId, "Grok Bot", `Track[${track}] ModelScope call failed (${e.message}) — simulated findings used`);
      }
    }
    for (let i = 0; i < items.length; i++) {
      await sleep(260 + Math.random() * 320);
      insertFinding(runId, track, i + 1, items[i], source);
    }
  }));
  logDecision(runId, "Grok Bot", "All 3 research tracks complete — findings persisted");

  /* stage 4: model arbitration */
  updateRun(runId, { current_stage: "models" });
  for (const [track, slots] of Object.entries(SLOTS)) {
    slots.forEach((sl, i) => {
      db.prepare("INSERT OR REPLACE INTO model_slots (run_id,slot_key,category,model_id,role,custom) VALUES (?,?,?,?,?,0)")
        .run(runId, `${track}:${i}`, sl.cat, modelId(sl.cat, sl.idx), sl.role);
    });
  }
  logDecision(runId, "Grok Bot", "ModelScope slots arbitrated — 6 slots across 5 categories");

  /* stage 5: brief */
  updateRun(runId, { current_stage: "brief" });
  const rev = getRun(runId).revision;
  await compileBrief(runId, rev, null);
  logDecision(runId, "Grok Bot", `AI Transformation Brief compiled (rev ${rev})`);

  /* stage 6: gate */
  updateRun(runId, { current_stage: "approval", status: "awaiting_approval" });
  logDecision(runId, "system", "Pipeline halted at Human Approval gate — awaiting strategist decision");
}

/* ================= brief compiler ================= */
function briefMarkdown(run, findings, slots, note) {
  const bl = arr => arr.map(f => `- ${f.content}`).join("\n");
  const byTrack = t => findings.filter(f => f.track === t).sort((a, b) => a.seq - b.seq);
  const stack = slots.map(s => `| ${s.slot_key.split(":")[0]} | ${s.model_id} | ${s.role} |`).join("\n");
  const kpi = (run.criteria || "Not specified").split(/\s*·\s*|\n/).filter(Boolean).map(x => `- ${x}`).join("\n");

  return `# AI Transformation Brief${run.revision > 1 ? ` (rev ${run.revision})` : ""}

**Goal:** ${run.goal}
**Industry / context:** ${run.industry || "Not specified"}
**Constraints:** ${run.constraints || "None stated"}
**Success criteria:** ${run.criteria || "Not specified"}
**Generated:** ${nowISO()} · **Orchestrator:** Grok Bot · **Model hub:** ModelScope

## 1. Executive Summary
${note ? `Revision note: ${note}. ` : ""}Based on three parallel research tracks, the recommended approach is a staged AI rollout with a human-in-the-loop approval gate: start with a bounded pilot on the highest-ROI process segment, prove accuracy against the stated success criteria, then scale. The model stack runs on ModelScope-hosted open models, orchestrated by Grok.

## 2. Current-State Assessment
- Context: ${run.industry || "not specified"}.
- Constraints acknowledged: ${run.constraints || "none stated"}.
- Baseline to capture before pilot: cycle time, error rate, cost per transaction, exception volume.

## 3. AI Opportunity Map
### Web Research
${bl(byTrack("web"))}
### Files & Data
${bl(byTrack("files"))}
### Business Logic
${bl(byTrack("business"))}

## 4. Recommended Model Stack (ModelScope)
| Track | Model | Role |
|---|---|---|
${stack}

## 5. Implementation Roadmap
| Phase | Window | Focus | Exit criteria |
|---|---|---|---|
| Pilot | 0–3 mo | Narrowest high-ROI slice; evaluation harness; human review UI | Meets success criteria on sample volume |
| Scale | 3–9 mo | Widen coverage, integrate systems of record, add monitoring | ≥70% straight-through on in-scope volume |
| Institutionalize | 9–18 mo | Model refresh cycle, governance, team enablement | Operated by business team with SLAs |

## 6. Risks & Mitigations
- Data quality gaps → cleansing pass before pilot; schema validation on ingestion.
- Accuracy drift → golden-set evaluation on every model/prompt change; alerting on thresholds.
- Compliance & privacy → in-region processing, DPA review, redaction pipeline for PII.
- Change resistance → role redefinition toward exception handling; early champion involvement.

## 7. KPIs & Success Criteria
${kpi}

## 8. Approval & Sign-off
${run.status === "approved"
    ? `**APPROVED** by ${run.signer || "Human Strategist"} at ${run.approved_at}.`
    : run.status === "rejected"
      ? "**REJECTED** — run archived; pipeline halted."
      : "⏳ Pending human approval — pipeline is halted at the sign-off gate."}
`;
}
async function compileBrief(runId, revision, note) {
  const run = getRun(runId);
  const findings = db.prepare("SELECT * FROM findings WHERE run_id=?").all(runId);
  const slots = db.prepare("SELECT * FROM model_slots WHERE run_id=? ORDER BY slot_key").all(runId);
  let md = briefMarkdown(run, findings, slots, note);
  const s = getProviderSettings();
  if (isLive() && s.grokKey) {
    try {
      md = await callLLM({
        base: s.grokBase, key: s.grokKey, model: s.grokModel, maxTokens: 2200,
        system: 'You compile an "AI Transformation Brief" in markdown with EXACTLY these sections in order: # AI Transformation Brief, ## 1. Executive Summary, ## 2. Current-State Assessment, ## 3. AI Opportunity Map (### Web Research, ### Files & Data, ### Business Logic), ## 4. Recommended Model Stack (markdown table), ## 5. Implementation Roadmap (markdown table), ## 6. Risks & Mitigations, ## 7. KPIs & Success Criteria, ## 8. Approval & Sign-off. Be concrete and quantitative. No preamble.',
        user: `Goal: ${run.goal}\nIndustry: ${run.industry}\nConstraints: ${run.constraints}\nCriteria: ${run.criteria}\nFindings: ${JSON.stringify(findings)}\nSlots: ${JSON.stringify(slots)}\n${note ? `Reviewer note: ${note}` : ""}`,
      });
    } catch (e) {
      logDecision(runId, "Grok Bot", `Brief generation via Grok failed (${e.message}) — template brief used`);
    }
  }
  db.prepare("INSERT OR REPLACE INTO briefs (run_id,revision,markdown,note,created_at) VALUES (?,?,?,?,?)")
    .run(runId, revision, md, note || "", nowISO());
}

/* ================= seed data ================= */
function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM runs").get().n;
  if (count > 0) return;
  const id = uuid();
  const t = nowISO();
  db.prepare(`INSERT INTO runs (id,goal,industry,constraints,criteria,status,current_stage,plan_summary,revision,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    "Seeded sample — automate accounts-payable invoice handling end-to-end: ingest supplier invoices in any format, extract and validate line items against POs, route exceptions to humans, and post approved entries to the ERP — cutting processing time by 60% and eliminating manual keying errors.",
    "Mid-size manufacturing company, ~800 employees, EU operations",
    "Invoice data stays in-region (GDPR); human review above €10k; SAP integration; 6-month budget",
    "Cost per invoice < €1.20 · straight-through rate > 70% · field accuracy > 99% · go-live in one quarter",
    "awaiting_approval", "approval",
    "Decompose invoice-automation intent into 3 parallel research tracks, then compile the transformation brief.",
    1, t, t);
  const plan = simPlan({
    goal: "automate accounts-payable invoice handling extraction validation exceptions ERP",
  });
  for (const [track, items] of Object.entries({ web: plan.web, files: plan.files, business: plan.business })) {
    items.forEach((c, i) => insertFinding(id, track, i + 1, c, "demo"));
  }
  for (const [track, slots] of Object.entries(SLOTS)) {
    slots.forEach((sl, i) => {
      db.prepare("INSERT OR REPLACE INTO model_slots (run_id,slot_key,category,model_id,role,custom) VALUES (?,?,?,?,?,0)")
        .run(id, `${track}:${i}`, sl.cat, modelId(sl.cat, sl.idx), sl.role);
    });
  }
  const run = getRun(id);
  const findings = db.prepare("SELECT * FROM findings WHERE run_id=?").all(id);
  const slotsDb = db.prepare("SELECT * FROM model_slots WHERE run_id=? ORDER BY slot_key").all(id);
  db.prepare("INSERT OR REPLACE INTO briefs (run_id,revision,markdown,note,created_at) VALUES (?,?,?,?,?)")
    .run(id, 1, briefMarkdown(run, findings, slotsDb, ""), "", t);
  logDecision(id, "Human Strategist", "Seeded sample run created (invoice processing automation)");
  logDecision(id, "Grok Bot", "Seeded pipeline executed — brief ready for review");
  logDecision(id, "system", "Seeded run halted at Human Approval gate");
  console.log("[seed] sample run created:", id);
}

/* ================= run recovery after restart ================= */
async function recoverInterruptedRuns() {
  const stuck = db.prepare("SELECT id FROM runs WHERE status='running'").all();
  for (const r of stuck) {
    const hasBrief = db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE run_id=?").get(r.id).n > 0;
    if (hasBrief) {
      updateRun(r.id, { status: "awaiting_approval", current_stage: "approval" });
      logDecision(r.id, "system", "Server restarted — run restored to approval gate from persisted state");
    } else {
      logDecision(r.id, "system", "Server restarted — pipeline execution resumed");
      executeRun(r.id).catch(e => console.error("[recovery]", e));
    }
  }
}

/* ================= API ================= */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let b = ""; req.on("data", c => b += c);
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

function runSummary(r) {
  const findings = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id=?").get(r.id).n;
  const brief = db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE run_id=?").get(r.id).n;
  return { ...r, finding_count: findings, brief_count: brief };
}
function runFull(id) {
  const run = getRun(id);
  if (!run) return null;
  return {
    ...run,
    findings: db.prepare("SELECT track,seq,content,source FROM findings WHERE run_id=? ORDER BY track,seq").all(id),
    model_slots: db.prepare("SELECT * FROM model_slots WHERE run_id=? ORDER BY slot_key").all(id),
    briefs: db.prepare("SELECT revision,markdown,note,created_at FROM briefs WHERE run_id=? ORDER BY revision").all(id),
    decisions: db.prepare("SELECT actor,action,created_at FROM decisions WHERE run_id=? ORDER BY id").all(id),
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* settings */
  if (p === "/api/settings" && method === "GET") {
    const s = getProviderSettings();
    const mask = k => k ? `•••${k.slice(-4)}` : "";
    return json(res, 200, {
      mode: s.mode, grokModel: s.grokModel, msModel: s.msModel,
      grokKeyConfigured: !!s.grokKey, grokKeyMasked: mask(s.grokKey),
      msTokenConfigured: !!s.msToken, msTokenMasked: mask(s.msToken),
      live: isLive(),
    });
  }
  if (p === "/api/settings" && method === "PUT") {
    const b = await readBody(req);
    if (typeof b.mode === "string") setSetting("mode", b.mode === "live" ? "live" : "demo");
    if (typeof b.grokModel === "string" && b.grokModel.trim()) setSetting("grokModel", b.grokModel.trim());
    if (typeof b.msModel === "string" && b.msModel.trim()) setSetting("msModel", b.msModel.trim());
    if (typeof b.grokKey === "string") { if (b.grokKey === "CLEAR") setSetting("grokKey", ""); else if (b.grokKey.trim()) setSetting("grokKey", b.grokKey.trim()); }
    if (typeof b.msToken === "string") { if (b.msToken === "CLEAR") setSetting("msToken", ""); else if (b.msToken.trim()) setSetting("msToken", b.msToken.trim()); }
    logDecisionSystemGlobal(`Settings updated — mode=${getSetting("mode") || "demo"}`);
    return json(res, 200, { ok: true });
  }

  /* runs list */
  if (p === "/api/runs" && method === "GET") {
    const rows = db.prepare("SELECT id,goal,status,current_stage,revision,created_at,updated_at FROM runs ORDER BY created_at DESC").all();
    return json(res, 200, { runs: rows });
  }

  /* create run */
  if (p === "/api/runs" && method === "POST") {
    const b = await readBody(req);
    const goal = String(b.goal || "").trim();
    if (!goal) return json(res, 400, { error: "A transformation goal is required." });
    const id = uuid();
    db.prepare(`INSERT INTO runs (id,goal,industry,constraints,criteria,status,current_stage,revision,created_at,updated_at)
                VALUES (?,?,?,?,?,'running','orchestrator',1,?,?)`)
      .run(id, goal, String(b.industry || "").trim(), String(b.constraints || "").trim(), String(b.criteria || "").trim(), nowISO(), nowISO());
    logDecision(id, "Human Strategist", `Run started — goal: "${goal.slice(0, 90)}${goal.length > 90 ? "…" : ""}"`);
    if (ON_VERCEL) {
      // serverless: finish the pipeline before responding (demo ~3s, well within maxDuration)
      try { await executeRun(id); }
      catch (e) { logDecision(id, "system", `Pipeline error: ${e.message}`); }
    } else {
      // local: fire-and-forget; client polls for live progress
      executeRun(id).catch(e => {
        console.error("[pipeline]", e);
        updateRun(id, { status: "awaiting_approval" });
        logDecision(id, "system", `Pipeline error: ${e.message}`);
      });
    }
    return json(res, 201, { id, run: runFull(id) });
  }

  /* single run */
  let m = p.match(/^\/api\/runs\/([0-9a-f-]+)$/i);
  if (m && method === "GET") {
    const full = runFull(m[1]);
    return full ? json(res, 200, full) : json(res, 404, { error: "Run not found" });
  }

  /* model slot override */
  m = p.match(/^\/api\/runs\/([0-9a-f-]+)\/models$/i);
  if (m && method === "PATCH") {
    const b = await readBody(req);
    const run = getRun(m[1]);
    if (!run) return json(res, 404, { error: "Run not found" });
    const slotKey = String(b.slot_key || "");
    const modelIdStr = String(b.model_id || "");
    const slot = db.prepare("SELECT * FROM model_slots WHERE run_id=? AND slot_key=?").get(m[1], slotKey);
    if (!slot) return json(res, 400, { error: `Unknown slot ${slotKey}` });
    const cat = categoryOfModel(modelIdStr);
    if (!cat) return json(res, 400, { error: "Model id not in ModelScope catalog" });
    if (cat !== slot.category) return json(res, 400, { error: `Slot ${slotKey} requires category "${slot.category}", got "${cat}"` });
    db.prepare("UPDATE model_slots SET model_id=?, custom=1 WHERE run_id=? AND slot_key=?").run(modelIdStr, m[1], slotKey);
    logDecision(m[1], "Human Strategist", `Slot ${slotKey} overridden → ${modelIdStr}`);
    return json(res, 200, { ok: true });
  }

  /* recompile */
  m = p.match(/^\/api\/runs\/([0-9a-f-]+)\/recompile$/i);
  if (m && method === "POST") {
    const run = getRun(m[1]);
    if (!run) return json(res, 404, { error: "Run not found" });
    if (run.status !== "awaiting_approval") return json(res, 409, { error: `Run is ${run.status}; recompile is only available at the approval gate` });
    const newRev = run.revision + 1;
    updateRun(m[1], { revision: newRev, current_stage: "brief" });
    await compileBrief(m[1], newRev, "Model selection changed — brief recompiled");
    updateRun(m[1], { current_stage: "approval" });
    logDecision(m[1], "Human Strategist", `Model selections applied — brief recompiled (rev ${newRev})`);
    return json(res, 200, runFull(m[1]));
  }

  /* approval decision */
  m = p.match(/^\/api\/runs\/([0-9a-f-]+)\/decision$/i);
  if (m && method === "POST") {
    const b = await readBody(req);
    const run = getRun(m[1]);
    if (!run) return json(res, 404, { error: "Run not found" });
    if (run.status !== "awaiting_approval") return json(res, 409, { error: `Run is already ${run.status}` });
    const action = String(b.action || "");
    if (action === "approve") {
      const signer = String(b.signer || "").trim();
      if (!signer) return json(res, 400, { error: "Sign-off name is required to approve." });
      updateRun(m[1], { status: "approved", signer, approved_at: nowISO() });
      logDecision(m[1], `Human Strategist (${signer})`, "Brief APPROVED — run closed");
      const rev = run.revision;
      await compileBrief(m[1], rev, null); // refresh sign-off block
      return json(res, 200, runFull(m[1]));
    }
    if (action === "reject") {
      updateRun(m[1], { status: "rejected" });
      logDecision(m[1], "Human Strategist", "Brief REJECTED — run archived");
      const rev = run.revision;
      await compileBrief(m[1], rev, null);
      return json(res, 200, runFull(m[1]));
    }
    if (action === "request_changes") {
      const fb = String(b.feedback || "").trim();
      if (!fb) return json(res, 400, { error: "Feedback text is required for a revision request." });
      const newRev = run.revision + 1;
      const maxSeq = t => db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM findings WHERE run_id=? AND track=?").get(m[1], t).m;
      insertFinding(m[1], "business", maxSeq("business") + 1, `Revision directive (rev ${newRev}): ${fb}`, "reviewer");
      insertFinding(m[1], "web", maxSeq("web") + 1, `Scope adjusted per strategist feedback (rev ${newRev}).`, "reviewer");
      updateRun(m[1], { revision: newRev, current_stage: "brief" });
      await compileBrief(m[1], newRev, fb);
      updateRun(m[1], { current_stage: "approval" });
      logDecision(m[1], "Human Strategist", `Revision requested (rev ${newRev}): "${fb.slice(0, 80)}${fb.length > 80 ? "…" : ""}"`);
      return json(res, 200, runFull(m[1]));
    }
    return json(res, 400, { error: "action must be approve | request_changes | reject" });
  }

  /* brief markdown */
  m = p.match(/^\/api\/runs\/([0-9a-f-]+)\/brief\.md$/i);
  if (m && method === "GET") {
    const run = getRun(m[1]);
    if (!run) return json(res, 404, { error: "Run not found" });
    const brief = db.prepare("SELECT markdown FROM briefs WHERE run_id=? ORDER BY revision DESC LIMIT 1").get(m[1]);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai-transformation-brief-rev${run.revision}.md"`,
    });
    return res.end(brief ? brief.markdown : "");
  }

  return json(res, 404, { error: `No API route: ${method} ${p}` });
}

/* global settings log (run-less decisions not supported by schema; noop helper) */
function logDecisionSystemGlobal(msg) { console.log("[settings]", msg); }

/* ================= static files ================= */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};
function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      // SPA-ish fallback to app shell
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, buf2) => {
        if (e2) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(buf2);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ================= shared request handler ================= */
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  seedIfEmpty();
  recoverInterruptedRuns();
}

async function handle(req, res) {
  boot();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error("[server]", e);
    return json(res, 500, { error: e.message });
  }
}

module.exports = { handle, boot, executeRun, runFull, seedIfEmpty, DATA_DIR, ON_VERCEL };
