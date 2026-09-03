/** GlobalFlows UI — reads snapshot.json */

const $ = (sel, el = document) => el.querySelector(sel);

let SNAP = null;
let activeLayer = "liquidity";

/** Global row view: values | charts. Duration applies to every sparkline. */
let globalView = "values";
let chartDuration = "2y";
/** Series ids flipped from the global view (tap a row’s data/chart cell). */
const rowFlip = new Set();
const histCache = new Map();
const COLSPAN_DATA = 6;

function fmtAsOf(d) {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return d;
  return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
}

/** Search key under the name — FRED/Yahoo id, or short derived formula */
function seriesSub(s) {
  if (s.sub) return s.sub;
  if (s.status === "stale") return `${s.search || s.id} · stale`;
  const key = s.search || s.id;
  return s.freshness === "lagged" ? `${key} · lagged` : key;
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function fmtZ(z) {
  if (z == null || !Number.isFinite(z)) return "—";
  const s = (z >= 0 ? "+" : "") + z.toFixed(2);
  return s;
}

function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  return (p * 100).toFixed(0) + "%";
}

function zClass(z) {
  if (z == null || !Number.isFinite(z)) return "empty";
  if (z > 0.45) return "z-pos";
  if (z < -0.45) return "z-neg";
  return "z-mid";
}

function heatBg(pct) {
  if (pct == null || !Number.isFinite(pct)) return "transparent";
  // 0 = cool tight-ish, 1 = hot
  const t = Math.max(0, Math.min(1, pct));
  const r = Math.round(80 + t * 120);
  const g = Math.round(90 + (1 - Math.abs(t - 0.5) * 2) * 40);
  const b = Math.round(140 - t * 80);
  return `rgba(${r},${g},${b},0.35)`;
}

function wordFor(light) {
  if (!light || light.state === "empty") return "—";
  return light.words?.[light.state] || light.state;
}

function buildSentence(snap) {
  const L = snap.lights || {};
  const parts = [
    `Liquidity is <strong>${wordFor(L.liquidity).toLowerCase()}</strong>`,
    `money is <strong>${wordFor(L.transmission).toLowerCase()}</strong>`,
    `growth <strong>${wordFor(L.growth).toLowerCase()}</strong>`,
    `inflation <strong>${wordFor(L.inflation).toLowerCase()}</strong>`,
    `tape <strong>${wordFor(L.risk).toLowerCase()}</strong>`,
  ];
  return parts.join(" · ") + ".";
}

function renderLights(snap) {
  const root = $("#lights");
  const order = ["liquidity", "transmission", "growth", "inflation", "risk"];
  root.innerHTML = order
    .map((id) => {
      const L = snap.lights?.[id] || { state: "empty", label: id };
      const score =
        L.score != null && Number.isFinite(L.score)
          ? `${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)}`
          : "—";
      return `<article class="light" data-state="${L.state || "empty"}" data-id="${id}">
        <div class="dot" aria-hidden="true"></div>
        <div class="lbl">${L.label || id}</div>
        <div class="word">${wordFor(L)}</div>
        <div class="score">${score}</div>
      </article>`;
    })
    .join("");
}

function renderConflicts(snap) {
  const el = $("#conflicts");
  const list = snap.disagreements || [];
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>Disagreement</strong><ul>${list
    .map((d) => `<li>${d.text}</li>`)
    .join("")}</ul>`;
}

function renderTabs(snap) {
  const tabs = $("#tabs");
  const layers = (snap.layers || []).filter((l) => l.id !== "assets");
  // Always show assets as tab too? Keep assets in side panel; tabs for causal layers + all
  const items = [{ id: "all", label: "All", blurb: "Full book" }, ...layers];
  tabs.innerHTML = items
    .map(
      (l) =>
        `<button type="button" role="tab" data-layer="${l.id}" aria-selected="${
          l.id === activeLayer ? "true" : "false"
        }">${l.label}</button>`
    )
    .join("");
  tabs.onclick = (e) => {
    const b = e.target.closest("button[data-layer]");
    if (!b) return;
    activeLayer = b.dataset.layer;
    [...tabs.querySelectorAll("button")].forEach((x) =>
      x.setAttribute("aria-selected", x === b ? "true" : "false")
    );
    renderTable(snap);
  };
}

function seriesList(snap, layer) {
  const all = Object.values(snap.series || {});
  if (layer === "all") {
    return all.sort((a, b) => {
      const order = [
        "liquidity",
        "rates",
        "fx",
        "economy",
        "inflation",
        "conditions",
        "markets",
      ];
      const d = order.indexOf(a.layer) - order.indexOf(b.layer);
      return d || a.name.localeCompare(b.name);
    });
  }
  return all
    .filter((s) => s.layer === layer)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function rowView(id) {
  const flipped = rowFlip.has(id);
  if (globalView === "charts") return flipped ? "values" : "charts";
  return flipped ? "charts" : "values";
}

function toggleRowView(id) {
  if (rowFlip.has(id)) rowFlip.delete(id);
  else rowFlip.add(id);
}

function setGlobalView(mode) {
  globalView = mode;
  rowFlip.clear();
  syncViewControls();
  renderTable(SNAP);
}

function syncViewControls() {
  const btn = $("#btnViewMode");
  if (btn) {
    // Button shows the action to switch TO
    btn.textContent = globalView === "values" ? "Chart" : "Values";
    btn.setAttribute("aria-pressed", globalView === "charts" ? "true" : "false");
  }
  const g = $("#durGroup");
  if (g) {
    [...g.querySelectorAll("[data-dur]")].forEach((b) => {
      b.setAttribute(
        "aria-pressed",
        b.dataset.dur === chartDuration ? "true" : "false"
      );
    });
  }
}

function valuesCells(s) {
  if (s.status === "stale") {
    return `<td>${fmt(s.latest)}</td>
      <td colspan="4" class="empty">stale · excluded</td>
      <td>${fmtAsOf(s.asOf)}</td>`;
  }
  if (s.status !== "ok" || s.latest == null) {
    return `<td colspan="5" class="empty">empty — ${escapeHtml(s.error || "no data")}</td>
      <td class="empty">—</td>`;
  }
  const z = s.z2y;
  return `<td><span class="cell-heat">${fmt(s.latest)}</span></td>
    <td class="${zClass(z)}">${fmtZ(z)}</td>
    <td><span class="cell-heat" style="background:${heatBg(s.pct5y)}">${fmtPct(s.pct5y)}</span></td>
    <td><span class="cell-heat" style="background:${heatBg(s.pct10y)}">${fmtPct(s.pct10y)}</span></td>
    <td class="${zClass(s.change1y != null ? s.change1y / 20 : null)}">${
      s.change1y == null ? "—" : fmtZ(s.change1y) + "%"
    }</td>
    <td>${fmtAsOf(s.asOf)}</td>`;
}

function chartCell(s) {
  return `<td class="chart-cell" colspan="${COLSPAN_DATA}">
    <div class="spark-wrap" data-spark="${s.id}">
      <canvas class="spark" width="600" height="36" aria-hidden="true"></canvas>
      <span class="spark-msg muted">…</span>
    </div>
  </td>`;
}

function renderThead(rows) {
  const thead = $("#heat thead tr");
  if (!thead) return;
  const anyValues = rows.some((s) => rowView(s.id) === "values");
  if (!anyValues) {
    thead.innerHTML = `<th>Series</th><th colspan="${COLSPAN_DATA}">Chart · ${chartDuration.toUpperCase()}</th>`;
  } else {
    thead.innerHTML = `<th>Series</th>
      <th>Latest</th><th>2y z</th><th>5y %ile</th><th>10y %ile</th><th>1y Δ</th><th>As-of</th>`;
  }
}

function renderTable(snap) {
  if (!snap) return;
  const layerMeta =
    (snap.layers || []).find((l) => l.id === activeLayer) ||
    (activeLayer === "all"
      ? { label: "All series", blurb: "Full public book" }
      : { label: activeLayer, blurb: "" });
  $("#layerTitle").textContent = layerMeta.label || activeLayer;
  $("#layerBlurb").textContent = layerMeta.blurb || "";

  const body = $("#heatBody");
  const rows = seriesList(snap, activeLayer);
  renderThead(rows);

  body.innerHTML = rows
    .map((s) => {
      const view = rowView(s.id);
      const data =
        view === "charts" ? chartCell(s) : valuesCells(s);
      return `<tr data-id="${s.id}" data-view="${view}">
        <td class="name-cell"><span class="name">${s.name}</span><span class="sub">${seriesSub(s)}</span></td>
        ${data}
      </tr>`;
    })
    .join("");

  body.onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    // Name column → series detail; data/chart → flip that line only
    if (e.target.closest(".name-cell")) {
      openSeries(snap.series[id]);
      return;
    }
    if (e.target.closest(".chart-cell, td:not(.name-cell)")) {
      toggleRowView(id);
      renderTable(snap);
    }
  };

  paintSparks();
}

async function loadHistory(id) {
  if (histCache.has(id)) return histCache.get(id);
  const p = fetch(`./data/history/${encodeURIComponent(id)}.json`, {
    cache: "force-cache",
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  histCache.set(id, p);
  return p;
}

function sliceDuration(points, dur) {
  if (!points?.length) return [];
  if (dur === "max") return points;
  const years = { "1y": 1, "2y": 2, "5y": 5, "10y": 10 }[dur] || 2;
  const last = points[points.length - 1].date;
  const end = Date.parse(last + "T00:00:00Z");
  const start = end - years * 365.25 * 86400000;
  const startIso = new Date(start).toISOString().slice(0, 10);
  return points.filter((p) => p.date >= startIso);
}

function drawSpark(canvas, points) {
  const wrap = canvas.parentElement;
  const msg = wrap?.querySelector(".spark-msg");
  if (!points.length) {
    if (msg) msg.textContent = "no history";
    return;
  }
  if (msg) msg.textContent = "";

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(wrap.clientWidth || canvas.clientWidth || 200, 80);
  const cssH = 32;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padY = 3;
  const n = points.length;
  const first = points[0].value;
  const last = points[n - 1].value;
  const up = last >= first;
  ctx.strokeStyle = up ? "var(--ease)" : "var(--tight)";
  // canvas can't use css vars reliably — resolve
  const styles = getComputedStyle(document.documentElement);
  ctx.strokeStyle = up
    ? styles.getPropertyValue("--ease").trim() || "#3dcea7"
    : styles.getPropertyValue("--tight").trim() || "#e86a5c";
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(n - 1, 1)) * (cssW - 1);
    const y =
      padY + (1 - (points[i].value - min) / (max - min)) * (cssH - padY * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // end dot
  const yLast =
    padY + (1 - (last - min) / (max - min)) * (cssH - padY * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(cssW - 1, yLast, 2, 0, Math.PI * 2);
  ctx.fill();
}

async function paintSparks() {
  const nodes = [...document.querySelectorAll("[data-spark]")];
  await Promise.all(
    nodes.map(async (wrap) => {
      const id = wrap.dataset.spark;
      const canvas = wrap.querySelector("canvas");
      const msg = wrap.querySelector(".spark-msg");
      const hist = await loadHistory(id);
      if (!canvas) return;
      if (!hist?.points?.length) {
        if (msg) msg.textContent = "no history";
        return;
      }
      const sliced = sliceDuration(hist.points, chartDuration);
      if (!sliced.length) {
        if (msg) msg.textContent = `no ${chartDuration} data`;
        return;
      }
      drawSpark(canvas, sliced);
    })
  );
}

function shortSource(s) {
  if (!s) return "—";
  if (s.includes("FRED")) return "FRED";
  if (s.includes("Yahoo")) return "Yahoo";
  if (s.includes("NY Fed")) return "NY Fed";
  if (s.includes("derived")) return "derived";
  return s.slice(0, 18);
}

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderAssets(snap) {
  const root = $("#assets");
  const ids = ["SPX", "NDX", "RTY", "DXY", "GOLD", "SILVER", "BTC", "WTI", "BRENT", "TLT", "EWZ"];
  root.innerHTML = ids
    .map((id) => {
      const s = snap.series?.[id];
      if (!s) return "";
      if (s.status !== "ok") {
        return `<div class="asset"><div class="n">${id}</div><div class="v empty">—</div><div class="m">empty</div></div>`;
      }
      return `<div class="asset">
        <div class="n">${s.name}</div>
        <div class="v ${zClass(s.z2y)}">${fmt(s.latest)}</div>
        <div class="m">2y z ${fmtZ(s.z2y)} · 5y %ile ${fmtPct(s.pct5y)} · ${fmtAsOf(s.asOf)}</div>
      </div>`;
    })
    .join("");
}

function openSeries(s) {
  if (!s) return;
  $("#seriesTitle").textContent = s.name;
  $("#seriesBody").innerHTML = `
    <p><code>${escapeHtml(s.search || s.sub || s.id)}</code> · ${s.layer} · ${s.freq || "?"}</p>
    <p><strong>Latest:</strong> ${s.latest == null ? "empty" : fmt(s.latest)} <span class="muted">${s.units || ""}</span></p>
    ${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ""}
    <p><strong>As-of:</strong> ${fmtAsOf(s.asOf)}</p>
    <p><strong>2y z:</strong> ${fmtZ(s.z2y)} · <strong>5y %ile:</strong> ${fmtPct(s.pct5y)} · <strong>10y %ile:</strong> ${fmtPct(s.pct10y)}</p>
    <p><strong>Sign for lights:</strong> ${s.sign} ${s.note ? "· " + s.note : ""}</p>
    <p><strong>Source:</strong> ${escapeHtml(s.source || "")}${
      s.sourceUrl
        ? ` · <a href="${s.sourceUrl}" target="_blank" rel="noopener">open</a>`
        : ""
    }</p>
    ${s.error ? `<p class="empty">Error: ${escapeHtml(s.error)}</p>` : ""}
  `;
  $("#dlgSeries").showModal();
}

function renderFormula(snap) {
  const f = snap.formula || {};
  $("#formulaBody").innerHTML = `
    <p>${escapeHtml(f.lights || "")}</p>
    <p><strong>Net liquidity:</strong> <code>${escapeHtml(f.netLiquidity || "")}</code></p>
    <p><strong>Stock–bond corr:</strong> <code>${escapeHtml(f.stockBondCorr || "")}</code></p>
    <p class="muted">Per-series sign flips “higher” into easing vs tightening for that light. Inflation light treats upside as hot.</p>
  `;
}

async function boot() {
  try {
    const res = await fetch("./snapshot.json", { cache: "no-store" });
    if (!res.ok) throw new Error("snapshot.json missing — run npm run ingest");
    SNAP = await res.json();
  } catch (e) {
    $("#sentence").innerHTML = `<span class="empty">${escapeHtml(
      e.message || String(e)
    )}</span>`;
    return;
  }

  {
    const d = new Date(SNAP.generatedAt);
    $("#genAt").textContent = `ingest ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  $("#sentence").innerHTML = buildSentence(SNAP);
  renderLights(SNAP);
  renderConflicts(SNAP);
  renderTabs(SNAP);
  renderTable(SNAP);
  renderAssets(SNAP);
  renderFormula(SNAP);

  $("#btnAbout").onclick = () => $("#dlgAbout").showModal();

  syncViewControls();
  $("#btnViewMode").onclick = () => {
    setGlobalView(globalView === "values" ? "charts" : "values");
  };
  $("#durGroup").onclick = (e) => {
    const b = e.target.closest("[data-dur]");
    if (!b) return;
    chartDuration = b.dataset.dur;
    syncViewControls();
    // Duration applies to all visible charts — redraw without resetting flips
    paintSparks();
    const thead = $("#heat thead tr");
    if (thead && !seriesList(SNAP, activeLayer).some((s) => rowView(s.id) === "values")) {
      thead.innerHTML = `<th>Series</th><th colspan="${COLSPAN_DATA}">Chart · ${chartDuration.toUpperCase()}</th>`;
    }
  };

  // click light → filter that layer
  $("#lights").onclick = (e) => {
    const card = e.target.closest(".light[data-id]");
    if (!card) return;
    // Lights are causal scores; jump to the Street tab that holds that evidence
    const map = {
      liquidity: "liquidity",
      transmission: "rates",
      growth: "economy",
      inflation: "inflation",
      risk: "conditions",
    };
    activeLayer = map[card.dataset.id] || "all";
    [...$("#tabs").querySelectorAll("button")].forEach((x) =>
      x.setAttribute(
        "aria-selected",
        x.dataset.layer === activeLayer ? "true" : "false"
      )
    );
    renderTable(SNAP);
  };
}

boot();
