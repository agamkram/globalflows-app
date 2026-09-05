/** About page — ingest meta, bake status, light formula. */

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
  $("#formulaBody").innerHTML = `
    <p>${escapeHtml(
      f.lights ||
        "Per light: median of member scores (each = mean of sign×Ny z and flipped Ny %ile for the selected 1/2/5y window). Score >+0.45 / <−0.45 paints the word."
    )}</p>
    <dl class="formula-dl">
      <div>
        <dt>Net liquidity</dt>
        <dd><code>${escapeHtml(f.netLiquidity || "WALCL(bn) − TGA − ON RRP")}</code></dd>
      </div>
      <div>
        <dt>Stock–bond corr</dt>
        <dd><code>${escapeHtml(f.stockBondCorr || "rolling corr of daily equity vs Treasury returns")}</code></dd>
      </div>
    </dl>
    <p class="muted tiny">
      Per-line sign flips “higher” into easing vs tightening for that light.
      Inflation treats upside as hot. The book’s 1·2·5 control recomputes lights in the UI;
      the daily bake locks the 2y teach story.
    </p>
  `;
}

function renderAboutMeta(snap, regime) {
  const vals = Object.values(snap.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale");
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;

  $("#aboutIngest").textContent = fmtWhen(snap.generatedAt);

  const staleNames = stale.map((s) => s.name || s.id).join(", ");
  $("#aboutCoverage").textContent = stale.length
    ? `${ok} live · ${stale.length} stale hidden${empty ? ` · ${empty} empty` : ""}`
    : `${ok} live lines${empty ? ` · ${empty} empty` : ""}`;
  if (staleNames) {
    $("#aboutCoverage").title = staleNames;
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
