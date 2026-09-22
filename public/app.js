"use strict";
/* =====================================================================
   AI Transformation Studio — client
   Talks to the orchestration server via REST; polls run state.
   Blueprint: Human Strategist → Grok → Web/Files/Business → ModelScope
              → Brief → Human Approval
   ===================================================================== */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STAGES = ["strategist","orchestrator","tracks","models","brief","approval"];
const TRACKS = ["web","files","business"];

/* ---------------- state ---------------- */
const state = {
  runId: null,
  run: null,
  catalog: null,
  slots: null,
  pollTimer: null,
  decisionsRendered: 0,
  approved: false,
  rejected: false,
};

/* ---------------- helpers ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function setStage(name) {
  const cur = STAGES.indexOf(name);
  $$(".rail .node").forEach(n => {
    const idx = STAGES.indexOf(n.dataset.stage);
    n.dataset.state = idx < cur ? "done" : idx === cur ? "active" : "locked";
    n.querySelector(".st").textContent = idx < cur ? "✓" : String(idx + 1);
  });
  STAGES.forEach((s, i) => {
    const p = $("#p-" + s);
    p.classList.toggle("locked", i > cur);
    p.classList.toggle("active", i === cur);
  });
}
function setRunChip(running, stage) {
  $("#runChip").classList.toggle("run", !!running);
  $("#runLabel").textContent = running ? "Running…" :
    (stage === "approval" ? "Awaiting decision" : stage === "strategist" ? "Idle" : "Stage: " + stage);
}

/* ---------------- presets ---------------- */
const PRESETS = {
  invoice: {
    goal: "Automate accounts-payable invoice handling end-to-end: ingest supplier invoices in any format, extract and validate line items against purchase orders, route exceptions to humans, and post approved entries to the ERP — cutting processing time by 60% and eliminating manual keying errors.",
    industry: "Mid-size manufacturing company, ~800 employees, EU operations",
    constraints: "Invoice data must stay in-region (GDPR); human review mandatory above €10k; SAP integration; 6-month budget envelope",
    criteria: "Cost per invoice < €1.20 · straight-through rate > 70% · field accuracy > 99% · go-live within one quarter",
  },
  support: {
    goal: "Deploy a customer-support copilot that drafts replies from the knowledge base and past tickets, auto-tags and prioritizes inbound requests, and escalates sensitive cases — reducing first-response time by half without degrading CSAT.",
    industry: "B2B SaaS company, ~12k monthly tickets, 3 languages (EN/DE/JP)",
    constraints: "No customer PII sent to models without DPA; brand-voice consistency; support team of 25 keeps final send authority",
    criteria: "First-response time −50% · copilot-accepted draft rate > 60% · CSAT stable or better · full audit log",
  },
  field: {
    goal: "Give field-service technicians a mobile knowledge assistant that answers repair questions from manuals and historical work orders, reads equipment nameplate photos to identify the machine, and pre-fills service reports via voice.",
    industry: "Industrial equipment service provider, 350 technicians, 5 countries",
    constraints: "Offline-first in low-connectivity sites; legacy scanned PDF manuals; bilingual terminology",
    criteria: "Mean time-to-repair −20% · report completion time −40% · ≥90% correct machine identification",
  },
};
$$(".presets button").forEach(b => {
  b.addEventListener("click", () => {
    const p = PRESETS[b.dataset.preset];
    $("#fGoal").value = p.goal;
    $("#fIndustry").value = p.industry;
    $("#fConstraints").value = p.constraints;
    $("#fCriteria").value = p.criteria;
    $("#goalErr").style.display = "none";
  });
});

/* ---------------- catalog (mirrors server; editable) ---------------- */
const CATALOG = [
  { key: "llm", label: "LLM / NLP", models: [
    { id: "Qwen/Qwen2.5-72B-Instruct", desc: "General reasoning, drafting, summarization" },
    { id: "deepseek-ai/DeepSeek-V3", desc: "Strong analytical reasoning, long context" },
    { id: "Qwen/Qwen2.5-14B-Instruct", desc: "Cost-efficient workhorse for high volume" },
  ]},
  { key: "speech", label: "Speech", models: [
    { id: "iic/SenseVoiceSmall", desc: "Multilingual ASR with emotion/event tags" },
    { id: "iic/speech_paraformer-large", desc: "High-accuracy Chinese/English transcription" },
    { id: "iic/CosyVoice2-0.5B", desc: "Natural TTS voice generation" },
  ]},
  { key: "vision", label: "Vision", models: [
    { id: "Qwen/Qwen2-VL-7B-Instruct", desc: "Document & chart understanding" },
    { id: "PaddlePaddle/PaddleOCR", desc: "Production OCR for scans and receipts" },
    { id: "IDEA-Research/GroundingDINO", desc: "Open-vocabulary object detection" },
  ]},
  { key: "multimodal", label: "Multimodal", models: [
    { id: "Qwen/Qwen2-VL-72B-Instruct", desc: "Image+text reasoning over mixed documents" },
    { id: "OpenGVLab/InternVL2-8B", desc: "Balanced multimodal understanding" },
  ]},
  { key: "embed", label: "Embedding / Specialist", models: [
    { id: "BAAI/bge-large-zh-v1.5", desc: "Retrieval embeddings for knowledge bases" },
    { id: "BAAI/bge-reranker-large", desc: "Second-stage reranking for RAG" },
    { id: "iic/nlp_gte_sentence-embedding_chinese-large", desc: "Sentence embeddings, clustering" },
  ]},
];

/* ---------------- markdown → html ---------------- */
function mdToHtml(md) {
  const lines = md.split("\n"); const out = []; let inList = false, inTable = false;
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  const closeTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; } };
  lines.forEach(ln => {
    const t = ln.trim();
    if (/^#{1,3}\s/.test(t)) {
      closeList(); closeTable();
      const lvl = t.match(/^#+/)[0].length;
      out.push(`<h${lvl + 1}>${inline(t.replace(/^#+\s*/, ""))}</h${lvl + 1}>`);
    } else if (/^- /.test(t)) {
      closeTable();
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(t.slice(2))}</li>`);
    } else if (/^\|/.test(t)) {
      closeList();
      if (/^[\s|:-]+$/.test(t)) return;
      const cells = t.split("|").slice(1, -1).map(c => c.trim());
      if (!inTable) { out.push("<table><tbody>"); inTable = true; }
      out.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`);
    } else if (t === "") {
      closeList(); closeTable();
    } else {
      closeList(); closeTable();
      out.push(`<p>${inline(t)}</p>`);
    }
  });
  closeList(); closeTable();
  return out.join("\n");
}

/* ---------------- run polling & rendering ---------------- */
async function pollRun() {
  if (!state.runId) return;
  try {
    const run = await api(`/api/runs/${state.runId}`);
    state.run = run;
    renderRun(run);
    if (run.status !== "running") stopPolling();
  } catch (e) {
    console.error("poll failed", e);
  }
}
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollRun, 700);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

function renderRun(run) {
  /* stage */
  const stageMap = { orchestrator: "orchestrator", tracks: "tracks", models: "models", brief: "brief", approval: "approval", strategist: "strategist" };
  const stage = stageMap[run.current_stage] || "strategist";
  setStage(stage);
  setRunChip(run.status === "running", run.current_stage);

  /* orchestrator console: derive lines from decisions */
  const orchDecisions = run.decisions.filter(d =>
    d.actor.startsWith("Grok") || d.actor === "system" || d.actor === "Human Strategist" && /goal:/i.test(d.action)
  );
  const c = $("#orchConsole");
  c.innerHTML = orchDecisions.map(d => {
    const cls = /fail|error|halt/i.test(d.action) ? "err" : /dispatch|online|decomposed|complete|arbitrated|compiled|approved|signed/i.test(d.action) ? "ok" : "";
    return `<span class="t">${esc(d.created_at.slice(11, 19))}</span><span class="${cls}">${esc(d.actor)}: ${esc(d.action)}</span>`;
  }).join("\n");
  c.scrollTop = c.scrollHeight;
  $("#planChips").innerHTML = run.plan_summary
    ? `<span class="pc">Plan: ${esc(run.plan_summary)}</span>` +
      TRACKS.map(t => `<span class="pc">${t === "web" ? "🌐" : t === "files" ? "📁" : "🧭"} ${t} · ${run.findings.filter(f => f.track === t).length} findings</span>`).join("")
    : "";

  /* tracks */
  TRACKS.forEach(t => {
    const card = $("#track-" + t);
    const pill = card.querySelector(".pill");
    const bar = card.querySelector(".bar i");
    const list = card.querySelector(".findings");
    const items = run.findings.filter(f => f.track === t).sort((a, b) => a.seq - b.seq);
    const expected = 4;
    const n = Math.min(items.length, expected);
    bar.style.width = Math.round((n / expected) * 100) + "%";
    if (run.status === "running" && run.current_stage === "tracks") {
      pill.className = "pill run"; pill.textContent = "running";
    } else if (items.length) {
      pill.className = "pill done"; pill.textContent = "done";
    } else {
      pill.className = "pill"; pill.textContent = "queued";
    }
    list.innerHTML = items.map(f =>
      `<li class="${f.source === "reviewer" ? "rev" : ""}">${esc(f.content)}</li>`
    ).join("") || "<li style='color:var(--faint)'>awaiting findings…</li>";
  });
  const hasLive = run.findings.some(f => f.source === "modelscope");
  const badge = $("#trackSourceBadge");
  badge.style.display = "block";
  badge.className = "badge " + (hasLive ? "live" : "demo");
  badge.textContent = hasLive ? "LIVE — findings generated via ModelScope API" : "DEMO DATA — simulated findings";

  /* models */
  if (run.model_slots.length) renderHub(run.model_slots);

  /* brief */
  const latest = run.briefs[run.briefs.length - 1];
  if (latest) $("#briefDoc").innerHTML = mdToHtml(latest.markdown);

  /* approval */
  renderApproval(run);
  state.decisionsRendered = run.decisions.length;
}

function renderHub(slots) {
  const grid = $("#hubGrid"); grid.innerHTML = "";
  const usedBySlot = {};
  slots.forEach(s => { usedBySlot[s.slot_key] = s.model_id; });
  const usedIds = new Set(Object.values(usedBySlot));
  CATALOG.forEach(cat => {
    const el = document.createElement("div"); el.className = "cat";
    el.innerHTML = `<h4>${esc(cat.label)}</h4>`;
    cat.models.forEach(m => {
      const isUsed = usedIds.has(m.id);
      const row = document.createElement("label"); row.className = "model";
      row.innerHTML =
        `<input type="radio" name="cat-${cat.key}" data-model="${esc(m.id)}" ${isUsed ? "checked" : ""}>` +
        `<span><span class="mid">${esc(m.id)}</span><br><span class="mdesc">${esc(m.desc)}</span></span>` +
        (isUsed ? `<span class="use">IN USE</span>` : "");
      row.querySelector("input").addEventListener("change", () => overrideSlot(cat.key, m.id));
      el.appendChild(row);
    });
    grid.appendChild(el);
  });
}
async function overrideSlot(catKey, modelId) {
  if (!state.runId) return;
  const slot = state.run.model_slots.find(s => s.category === catKey);
  if (!slot) return;
  try {
    await api(`/api/runs/${state.runId}/models`, { method: "PATCH", body: { slot_key: slot.slot_key, model_id: modelId } });
    toast(`Slot ${slot.slot_key} → ${modelId}`);
    await pollRun();
  } catch (e) { toast(e.message); }
}

/* ---------------- approval ---------------- */
function renderApproval(run) {
  const ul = $("#auditList");
  ul.innerHTML = run.decisions.map(d =>
    `<li><span class="at">${esc(d.created_at.slice(11, 19))}</span><span class="who">${esc(d.actor)}</span><span>${esc(d.action)}</span></li>`
  ).join("");

  const st = $("#briefStamp");
  if (run.status === "approved") {
    st.className = "stamp approved";
    $("#briefStampText").textContent = `APPROVED — signed by ${run.signer}`;
    $("#signWrap").style.display = "none";
  } else if (run.status === "rejected") {
    st.className = "stamp rejected";
    $("#briefStampText").textContent = "REJECTED — run archived";
  } else {
    st.className = "stamp";
  }
  const atGate = run.status === "awaiting_approval";
  $("#btnApprove").disabled = !atGate || run.status === "approved";
  $("#btnChanges").disabled = !atGate;
  $("#btnReject").disabled = !atGate;
  if (!atGate && run.status !== "awaiting_approval") $("#fbWrap").classList.remove("show");
}

$("#btnApprove").addEventListener("click", () => {
  $("#signWrap").style.display = "block";
  $("#fSigner").focus();
});
$("#btnSign").addEventListener("click", async () => {
  const signer = $("#fSigner").value.trim();
  if (!signer) { toast("Enter a sign-off name first"); return; }
  try {
    const run = await api(`/api/runs/${state.runId}/decision`, { method: "POST", body: { action: "approve", signer } });
    state.run = run; renderRun(run);
    toast("Run approved and closed ✓");
  } catch (e) { toast(e.message); }
});
$("#btnChanges").addEventListener("click", () => {
  $("#fbWrap").classList.add("show");
  $("#fFeedback").focus();
});
$("#btnSubmitFeedback").addEventListener("click", async () => {
  const fb = $("#fFeedback").value.trim();
  if (!fb) { toast("Add feedback text first"); return; }
  try {
    const run = await api(`/api/runs/${state.runId}/decision`, { method: "POST", body: { action: "request_changes", feedback: fb } });
    state.run = run; renderRun(run);
    $("#fbWrap").classList.remove("show");
    $("#fFeedback").value = "";
    toast(`Revision ${run.revision} compiled`);
  } catch (e) { toast(e.message); }
});
$("#btnReject").addEventListener("click", async () => {
  try {
    const run = await api(`/api/runs/${state.runId}/decision`, { method: "POST", body: { action: "reject" } });
    state.run = run; renderRun(run);
    toast("Run rejected and archived");
  } catch (e) { toast(e.message); }
});

/* ---------------- recompile ---------------- */
$("#btnRecompile").addEventListener("click", async () => {
  if (!state.runId) return;
  try {
    const run = await api(`/api/runs/${state.runId}/recompile`, { method: "POST", body: {} });
    state.run = run; renderRun(run);
    toast(`Brief recompiled (rev ${run.revision})`);
  } catch (e) { toast(e.message); }
});

/* ---------------- export ---------------- */
$("#btnCopy").addEventListener("click", async () => {
  const latest = state.run?.briefs?.[state.run.briefs.length - 1];
  if (!latest) return;
  try { await navigator.clipboard.writeText(latest.markdown); toast("Markdown copied"); }
  catch (e) { toast("Copy failed — use Download instead"); }
});
$("#btnDownload").addEventListener("click", () => {
  if (state.runId) window.open(`/api/runs/${state.runId}/brief.md`, "_blank");
});

/* ---------------- new run / strategist ---------------- */
$("#btnRun").addEventListener("click", async () => {
  const goal = $("#fGoal").value.trim();
  if (!goal) { $("#goalErr").style.display = "block"; $("#fGoal").focus(); return; }
  $("#goalErr").style.display = "none";
  try {
    resetWorkspace();
    const resp = await api("/api/runs", {
      method: "POST",
      body: { goal, industry: $("#fIndustry").value, constraints: $("#fConstraints").value, criteria: $("#fCriteria").value },
    });
    state.runId = resp.id;
    if (resp.run) { state.run = resp.run; renderRun(resp.run); }
    if (!resp.run || resp.run.status === "running") startPolling();
    toast("Pipeline started — run " + resp.id.slice(0, 8));
  } catch (e) { toast(e.message); }
});
function resetWorkspace() {
  state.run = null; state.decisionsRendered = 0;
  state.approved = false; state.rejected = false;
  $("#orchConsole").innerHTML = ""; $("#planChips").innerHTML = "";
  TRACKS.forEach(t => {
    const card = $("#track-" + t);
    card.querySelector(".pill").className = "pill"; card.querySelector(".pill").textContent = "queued";
    card.querySelector(".bar i").style.width = "0";
    card.querySelector(".findings").innerHTML = "";
  });
  $("#briefDoc").innerHTML = "<p style='color:var(--faint)'>The brief will appear here once the pipeline reaches stage 5.</p>";
  $("#briefStamp").className = "stamp";
  $("#signWrap").style.display = "none";
  $("#fbWrap").classList.remove("show");
  ["#btnApprove", "#btnChanges", "#btnReject"].forEach(s => $(s).disabled = false);
}
$("#btnNewRun").addEventListener("click", () => {
  stopPolling();
  state.runId = null;
  setStage("strategist");
  setRunChip(false, "strategist");
  resetWorkspace();
  renderApprovalEmpty();
  $("#fGoal").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
function renderApprovalEmpty() {
  $("#auditList").innerHTML = "<li><span class='who'>system</span><span>Audit trail initializes when a run starts.</span></li>";
}

/* ---------------- history ---------------- */
$("#btnHistory").addEventListener("click", async () => {
  $("#historyOverlay").classList.add("show");
  const list = $("#historyList");
  list.innerHTML = "<p style='color:var(--faint);font-size:13px'>Loading…</p>";
  try {
    const { runs } = await api("/api/runs");
    if (!runs.length) { list.innerHTML = "<p style='color:var(--faint);font-size:13px'>No runs yet.</p>"; return; }
    list.innerHTML = runs.map(r => `
      <div class="history-item" data-id="${esc(r.id)}">
        <span class="status-tag ${esc(r.status)}">${esc(r.status.replace("_", " "))}</span>
        <span class="hgoal" title="${esc(r.goal)}">${esc(r.goal.slice(0, 90))}${r.goal.length > 90 ? "…" : ""}</span>
        <span class="hmeta">rev ${r.revision} · ${esc((r.created_at || "").slice(0, 16).replace("T", " "))}</span>
      </div>`).join("");
    list.querySelectorAll(".history-item").forEach(el => {
      el.addEventListener("click", async () => {
        stopPolling();
        state.runId = el.dataset.id;
        $("#historyOverlay").classList.remove("show");
        await pollRun();
        toast("Run loaded");
      });
    });
  } catch (e) {
    list.innerHTML = `<p style="color:var(--err);font-size:13px">${esc(e.message)}</p>`;
  }
});
$("#btnHistoryClose").addEventListener("click", () => $("#historyOverlay").classList.remove("show"));
$("#historyOverlay").addEventListener("click", e => { if (e.target === $("#historyOverlay")) $("#historyOverlay").classList.remove("show"); });

/* ---------------- settings ---------------- */
async function openSettings() {
  try {
    const s = await api("/api/settings");
    document.querySelector(`input[name=mode][value="${s.mode === "live" ? "live" : "demo"}"]`).checked = true;
    $("#sGrokModel").value = s.grokModel || "";
    $("#sMsModel").value = s.msModel || "";
    $("#grokKeyMasked").textContent = s.grokKeyConfigured ? `Stored key: ${s.grokKeyMasked}` : "No key stored";
    $("#msTokenMasked").textContent = s.msTokenConfigured ? `Stored token: ${s.msTokenMasked}` : "No token stored";
    $("#settingsOverlay").classList.add("show");
  } catch (e) { toast(e.message); }
}
$("#btnSettings").addEventListener("click", openSettings);
$("#btnSettingsCancel").addEventListener("click", () => $("#settingsOverlay").classList.remove("show"));
$("#settingsOverlay").addEventListener("click", e => { if (e.target === $("#settingsOverlay")) $("#settingsOverlay").classList.remove("show"); });
$("#btnClearGrokKey").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", body: { grokKey: "CLEAR" } });
  $("#grokKeyMasked").textContent = "No key stored";
  toast("Grok key cleared");
});
$("#btnClearMsToken").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", body: { msToken: "CLEAR" } });
  $("#msTokenMasked").textContent = "No token stored";
  toast("ModelScope token cleared");
});
$("#btnSettingsSave").addEventListener("click", async () => {
  const body = { mode: document.querySelector("input[name=mode]:checked").value };
  if ($("#sGrokKey").value.trim()) body.grokKey = $("#sGrokKey").value.trim();
  if ($("#sGrokModel").value.trim()) body.grokModel = $("#sGrokModel").value.trim();
  if ($("#sMsToken").value.trim()) body.msToken = $("#sMsToken").value.trim();
  if ($("#sMsModel").value.trim()) body.msModel = $("#sMsModel").value.trim();
  try {
    await api("/api/settings", { method: "PUT", body });
    $("#settingsOverlay").classList.remove("show");
    $("#sGrokKey").value = ""; $("#sMsToken").value = "";
    applyModeChip();
    toast("Settings saved");
  } catch (e) { toast(e.message); }
});
async function applyModeChip() {
  try {
    const s = await api("/api/settings");
    const live = s.mode === "live" && (s.grokKeyConfigured || s.msTokenConfigured);
    $("#modeChip").classList.toggle("live", live);
    $("#modeChip").classList.toggle("demo", !live);
    $("#modeLabel").textContent = live ? "Live mode" : "Demo mode";
  } catch (e) { /* server unreachable */ }
}

/* ---------------- rail click scroll ---------------- */
$$(".rail .node").forEach(n => {
  n.addEventListener("click", () => $("#p-" + n.dataset.stage)?.scrollIntoView({ behavior: "smooth", block: "start" }));
});

/* ---------------- init ---------------- */
setStage("strategist");
setRunChip(false, "strategist");
renderApprovalEmpty();
applyModeChip();

/* deep link: /?run=<id> loads a persisted run directly */
(async () => {
  const rid = new URLSearchParams(location.search).get("run");
  if (!rid) return;
  try {
    state.runId = rid;
    await pollRun();
    toast("Run loaded from deep link");
  } catch (e) {
    toast("Could not load run: " + e.message);
  }
})();
