/** About page — data status + how a light gets its color. */

const $ = (sel, el = document) => el.querySelector(sel);

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

function renderFormula(snap) {
  const f = snap.formula || {};
  const lights =
    f.lights ||
    "Each light averages a small set of related indicators for the window you pick (1, 2, or 5 years). A clearly high score paints green; a clearly low score paints red; in between stays amber.";
  $("#formulaBody").innerHTML = `
    <p>${escapeHtml(lights)}</p>
    <dl class="formula-dl">
      <div>
        <dt>Net liquidity</dt>
        <dd><code>${escapeHtml(f.netLiquidity || "Fed assets − TGA − ON RRP")}</code></dd>
      </div>
      <div>
        <dt>Stock–bond correlation</dt>
        <dd><code>${escapeHtml(f.stockBondCorr || "how stock and Treasury returns have been moving together lately")}</code></dd>
      </div>
    </dl>
    <p class="muted tiny">
      For most lights, “higher” can mean easier or tighter depending on the indicator
      (a rising yield is not the same story as rising bank reserves). Inflation treats
      upside as hot. Changing 1 · 2 · 5 recalculates the lights on screen; the morning
      update locks the written So what for the two-year read.
    </p>
  `;
}

function renderAboutMeta(snap, regime) {
  const vals = Object.values(snap.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale");
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;

  $("#aboutIngest").textContent = fmtWhen(snap.generatedAt);

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
    renderFormula(snap);
    renderAboutMeta(snap, regime);
  } catch (e) {
    $("#aboutIngest").textContent = e.message || String(e);
    $("#formulaBody").innerHTML = `<p class="muted">${escapeHtml(e.message || String(e))}</p>`;
  }
}

boot();
