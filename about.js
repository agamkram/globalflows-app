/** About and Math pages — live telemetry, today’s calibration, valuation centres. */

const $ = (sel, el = document) => el.querySelector(sel);

const LIGHT_ORDER = [
  ["liquidity", "Liquidity"],
  ["rates", "Rates"],
  ["growth", "Growth"],
  ["inflation", "Inflation"],
  ["risk", "Risk"],
];

const VAL_ORDER = [
  ["THREEFFTP10", "Term premium (10y)"],
  ["DFII10", "10-year real yield"],
  ["BAMLH0A0HYM2", "High-yield OAS"],
  ["BAA10Y", "Baa spread"],
  ["EQUITY_ERP", "Equity risk premium"],
  ["SPX_EY", "S&P earnings yield"],
];

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const yy = String(d.getFullYear()).slice(2);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${hh}:${mi}`;
}

function fmtNum(n, d = 4) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

function derivedCount(snap) {
  return Object.values(snap.series || {}).filter((s) =>
    String(s.source || "").startsWith("derived")
  ).length;
}

function renderAboutMeta(snap, regime) {
  const ingest = $("#aboutIngest");
  if (ingest) {
    const vals = Object.values(snap.series || {});
    const ok = vals.filter((s) => s.status === "ok").length;
    const stale = vals.filter((s) => s.status === "stale");
    const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;

    ingest.textContent = fmtWhen(snap.generatedAt);

    $("#aboutCoverage").textContent = stale.length
      ? `${ok} live · ${stale.length} stale hidden${empty ? ` · ${empty} empty` : ""}`
      : `${ok} live lines${empty ? ` · ${empty} empty` : ""}`;
    if (stale.length) {
      $("#aboutCoverage").title = stale.map((s) => s.name || s.id).join(", ");
    }

    if (regime?.verdict) {
      const when = fmtWhen(regime.generatedAt);
      $("#aboutBake").textContent = `${regime.verdict} · ${when}`;
      $("#aboutBake").classList.toggle("is-ok", regime.verdict === "SPOT ON");
      $("#aboutBake").classList.toggle("is-bad", regime.verdict !== "SPOT ON");
    } else {
      $("#aboutBake").textContent = "—";
    }

    const dist = snap.lightDist || {};
    const n = dist.n || regime?.analogs?.sampleDays;
    const from = dist.sampleFrom || regime?.analogs?.windowStart;
    const to = dist.sampleTo || regime?.analogs?.windowEnd;
    if (n && from) {
      $("#aboutArchive").textContent = `${Number(n).toLocaleString("en-US")} days · ${from}${to ? ` → ${to}` : ""}`;
    } else {
      $("#aboutArchive").textContent = "—";
    }
  }

  const nDerived = derivedCount(snap);
  const note = $("#mathLiveNote");
  if (note) {
    note.textContent = nDerived
      ? `${nDerived} derived lines this morning.`
      : "";
  }
}

function renderFormulaLive(snap) {
  const el = $("#formulaLive");
  if (!el) return;
  const f = snap.formula || {};
  const net = f.netLiquidity;
  const corr = f.stockBondCorr;
  if (!net && !corr) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <p class="muted tiny">This morning’s file:</p>
    <dl class="formula-dl">
      ${net ? `<div><dt>Net liquidity (file)</dt><dd><code>${escapeHtml(net)}</code></dd></div>` : ""}
      ${corr ? `<div><dt>Stock–bond correlation (file)</dt><dd><code>${escapeHtml(corr)}</code></dd></div>` : ""}
    </dl>
  `;
}

function renderCalib(snap) {
  const el = $("#calibBody");
  if (!el) return;
  const dist = snap.lightDist;
  if (!dist?.lights) {
    el.innerHTML = `<p class="muted">No calibration in this morning’s file.</p>`;
    return;
  }
  const rows = LIGHT_ORDER.map(([id, label]) => {
    const L = dist.lights[id] || {};
    const scale = dist.outputScale?.[id];
    return `<div>
      <dt>${escapeHtml(label)}</dt>
      <dd><code>mean ${escapeHtml(fmtNum(L.mean))} · sd ${escapeHtml(fmtNum(L.sd))} · scale ${escapeHtml(fmtNum(scale))}</code></dd>
    </div>`;
  }).join("");
  const shared = Number.isFinite(dist.refSd) ? fmtNum(dist.refSd) : "—";
  const n = dist.n ? Number(dist.n).toLocaleString("en-US") : "—";
  el.innerHTML = `
    <p>${escapeHtml(n)} days, ${escapeHtml(dist.sampleFrom || "—")} → ${escapeHtml(dist.sampleTo || "—")}. Shared spread ${escapeHtml(shared)}.</p>
    <dl class="formula-dl">${rows}</dl>
  `;
}

function renderVal(snap) {
  const el = $("#valBody");
  if (!el) return;
  const table = snap.valCenter;
  if (!table || !Object.keys(table).length) {
    el.innerHTML = `<p class="muted">No valuation centres in this morning’s file.</p>`;
    return;
  }
  const rows = VAL_ORDER.map(([id, label]) => {
    const c = table[id];
    if (!c) return "";
    const src = c.source === "band-mid" ? "pinned band mid" : "archive median";
    const sample = c.sampleFrom && c.sampleTo ? ` · ${c.sampleFrom} → ${c.sampleTo}` : "";
    return `<div>
      <dt>${escapeHtml(label)}</dt>
      <dd><code>median ${escapeHtml(fmtNum(c.median, 2))} · scale ${escapeHtml(fmtNum(c.scale, 2))} · ${escapeHtml(src)}${escapeHtml(sample)}</code></dd>
    </div>`;
  }).join("");
  el.innerHTML = rows
    ? `<dl class="formula-dl">${rows}</dl>`
    : `<p class="muted">No valuation centres in this morning’s file.</p>`;
}

async function boot() {
  try {
    const [snapRes, regRes] = await Promise.all([
      fetch("./snapshot.json", { cache: "no-store" }),
      fetch("./regime-today.json", { cache: "no-store" }),
    ]);
    if (!snapRes.ok) throw new Error("snapshot missing");
    const snap = await snapRes.json();
    let regime = null;
    if (regRes.ok) {
      try {
        regime = await regRes.json();
      } catch {
        regime = null;
      }
    }
    renderAboutMeta(snap, regime);
    renderFormulaLive(snap);
    renderCalib(snap);
    renderVal(snap);
  } catch (e) {
    const msg = e.message || String(e);
    if ($("#aboutIngest")) $("#aboutIngest").textContent = msg;
    const fail = `<p class="muted">${escapeHtml(msg)}</p>`;
    if ($("#calibBody")) $("#calibBody").innerHTML = fail;
    if ($("#valBody")) $("#valBody").innerHTML = fail;
  }
}

boot();
