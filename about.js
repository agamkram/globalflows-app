/** About page — fills ingest meta + light formula from snapshot. */

const $ = (sel, el = document) => el.querySelector(sel);

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderFormula(snap) {
  const f = snap.formula || {};
  $("#formulaBody").innerHTML = `
    <p>${escapeHtml(f.lights || "Per light: median of member scores (sign×z and flipped percentile for the selected 1/2/5y window).")}</p>
    <p><strong>Net liquidity:</strong> <code>${escapeHtml(f.netLiquidity || "WALCL(bn) − TGA − ON RRP")}</code></p>
    <p><strong>Stock–bond corr:</strong> <code>${escapeHtml(f.stockBondCorr || "")}</code></p>
    <p class="muted">Per-line sign flips “higher” into easing vs tightening for that light. Inflation light treats upside as hot. The book’s 1·2·5 control recomputes lights in the UI.</p>
  `;
}

function renderAboutMeta(snap) {
  const d = new Date(snap.generatedAt);
  const when = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const vals = Object.values(snap.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale");
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;
  $("#aboutIngest").textContent = `Last ingest ${when} — when public lines were last pulled (not each row’s as-of).`;
  const staleNames = stale.map((s) => s.name || s.id).join(", ");
  $("#aboutCoverage").textContent = stale.length
    ? `${ok} live in table · ${stale.length} stale hidden (${staleNames})${empty ? ` · ${empty} empty` : ""}`
    : `${ok} live lines${empty ? ` · ${empty} empty` : ""}`;
}

async function boot() {
  try {
    const res = await fetch("./snapshot.json", { cache: "no-store" });
    if (!res.ok) throw new Error("snapshot missing");
    const snap = await res.json();
    renderFormula(snap);
    renderAboutMeta(snap);
  } catch (e) {
    $("#aboutIngest").textContent = e.message || String(e);
  }
}

boot();
