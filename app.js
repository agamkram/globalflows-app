/** GlobalMacro UI — reads snapshot.json */

const $ = (sel, el = document) => el.querySelector(sel);

let SNAP = null;
let activeLayer = "liquidity";

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
          ? `score ${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)} · n=${L.n ?? 0}`
          : "no data";
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
      const order = ["liquidity", "transmission", "labels", "risk", "assets"];
      const d = order.indexOf(a.layer) - order.indexOf(b.layer);
      return d || a.name.localeCompare(b.name);
    });
  }
  return all
    .filter((s) => s.layer === layer)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderTable(snap) {
  const layerMeta =
    (snap.layers || []).find((l) => l.id === activeLayer) ||
    (activeLayer === "all"
      ? { label: "All series", blurb: "Full public book" }
      : { label: activeLayer, blurb: "" });
  $("#layerTitle").textContent = layerMeta.label || activeLayer;
  $("#layerBlurb").textContent = layerMeta.blurb || "";

  const body = $("#heatBody");
  const rows = seriesList(snap, activeLayer);
  body.innerHTML = rows
    .map((s) => {
      if (s.status === "stale") {
        return `<tr data-id="${s.id}">
          <td><span class="name">${s.name}</span><span class="sub">${s.id} · discontinued/stale</span></td>
          <td>${fmt(s.latest)}</td>
          <td colspan="4" class="empty">stale — last ${s.asOf} (${s.staleDays}d) · excluded from lights</td>
          <td>${s.asOf || "—"}</td>
          <td>${s.sourceUrl ? `<a href="${s.sourceUrl}" target="_blank" rel="noopener">source</a>` : "—"}</td>
        </tr>`;
      }
      if (s.status !== "ok" || s.latest == null) {
        return `<tr data-id="${s.id}">
          <td><span class="name">${s.name}</span><span class="sub">${s.id}${
          s.note ? " · " + s.note : ""
        }</span></td>
          <td colspan="5" class="empty">empty — ${escapeHtml(s.error || "no data")}</td>
          <td class="empty">—</td>
          <td>${s.sourceUrl ? `<a href="${s.sourceUrl}" target="_blank" rel="noopener">source</a>` : "—"}</td>
        </tr>`;
      }
      const z = s.z2y;
      return `<tr data-id="${s.id}">
        <td><span class="name">${s.name}</span><span class="sub">${s.id} · ${s.units}${
        s.freshness === "lagged" ? " · lagged" : ""
      }</span></td>
        <td><span class="cell-heat">${fmt(s.latest)}</span></td>
        <td class="${zClass(z)}">${fmtZ(z)}</td>
        <td><span class="cell-heat" style="background:${heatBg(s.pct5y)}">${fmtPct(s.pct5y)}</span></td>
        <td><span class="cell-heat" style="background:${heatBg(s.pct10y)}">${fmtPct(s.pct10y)}</span></td>
        <td class="${zClass(s.change1y != null ? s.change1y / 20 : null)}">${
          s.change1y == null ? "—" : fmtZ(s.change1y) + "%"
        }</td>
        <td>${s.asOf || "—"}</td>
        <td>${s.sourceUrl ? `<a href="${s.sourceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${shortSource(s.source)}</a>` : shortSource(s.source)}</td>
      </tr>`;
    })
    .join("");

  body.onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    openSeries(snap.series[tr.dataset.id]);
  };
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
  const ids = ["SPX", "NDX", "RTY", "DXY", "GOLD", "BTC", "WTI", "BRENT"];
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
        <div class="m">2y z ${fmtZ(s.z2y)} · 5y %ile ${fmtPct(s.pct5y)} · ${s.asOf}</div>
      </div>`;
    })
    .join("");
}

function openSeries(s) {
  if (!s) return;
  $("#seriesTitle").textContent = s.name;
  $("#seriesBody").innerHTML = `
    <p><code>${s.id}</code> · ${s.layer} · ${s.freq || "?"}</p>
    <p><strong>Latest:</strong> ${s.latest == null ? "empty" : fmt(s.latest)} <span class="muted">${s.units || ""}</span></p>
    <p><strong>As-of:</strong> ${s.asOf || "—"}</p>
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

  $("#genAt").textContent = `as of ingest ${new Date(SNAP.generatedAt).toLocaleString()}`;
  $("#sentence").innerHTML = buildSentence(SNAP);
  renderLights(SNAP);
  renderConflicts(SNAP);
  renderTabs(SNAP);
  renderTable(SNAP);
  renderAssets(SNAP);
  renderFormula(SNAP);

  const vals = Object.values(SNAP.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale").length;
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;
  $("#footStats").textContent = `${ok} live · ${stale} stale · ${empty} empty`;

  $("#btnFormula").onclick = () => $("#dlgFormula").showModal();
  $("#btnAbout").onclick = () => $("#dlgAbout").showModal();

  // click light → filter that layer
  $("#lights").onclick = (e) => {
    const card = e.target.closest(".light[data-id]");
    if (!card) return;
    const map = {
      liquidity: "liquidity",
      transmission: "transmission",
      growth: "labels",
      inflation: "labels",
      risk: "risk",
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
