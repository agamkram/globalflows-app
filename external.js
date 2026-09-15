/** Browser viewer for data/external — not part of the bake. */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n, d = 0) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  });
}

function net(n) {
  if (n == null || !Number.isFinite(Number(n))) return { t: "—", c: "" };
  const v = Number(n);
  return {
    t: (v > 0 ? "+" : "") + fmt(v),
    c: v > 0 ? "up" : v < 0 ? "down" : "",
  };
}

function moodClass(s) {
  const r = String(s || "").toLowerCase();
  if (r.includes("greed")) return "up";
  if (r.includes("fear")) return "down";
  return "";
}

function dirClass(s) {
  const r = String(s || "").toUpperCase();
  if (r.includes("BULL")) return "up";
  if (r.includes("BEAR")) return "down";
  return "";
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const parts = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (parts[i] || "").trim();
    });
    return row;
  });
}

function renderFear(el, data) {
  if (!data) {
    el.innerHTML = `<p class="ext-err">Fear &amp; Greed missing — run <code>npm run fetch:external</code></p>`;
    return;
  }
  const cells = Object.entries(data.subs || {})
    .map(([k, v]) => {
      const label = k.replaceAll("_", " ");
      return `<div class="ext-cell"><span class="lbl">${esc(label)}</span><span class="val ${moodClass(v.rating)}">${fmt(v.score)} · ${esc(v.rating || "—")}</span></div>`;
    })
    .join("");
  el.innerHTML = `
    <header>
      <h2>Fear &amp; Greed</h2>
      <span class="ext-meta">as of ${esc(data.asOf)}</span>
    </header>
    <div class="ext-score">${esc(Math.round(data.score))}<span class="${moodClass(data.rating)}">${esc(data.rating)}</span></div>
    <div class="ext-meta">week ${fmt(data.previous1Week)} · month ${fmt(data.previous1Month)} · year ${fmt(data.previous1Year)}</div>
    <div class="ext-grid">${cells}</div>
    <p class="ext-note">${esc(data.note || "")}</p>`;
}

function renderCot(el, data) {
  if (!data) {
    el.innerHTML = `<p class="ext-err">COT missing — run <code>npm run fetch:external</code></p>`;
    return;
  }
  const rows = (data.contracts || [])
    .map((c) => {
      if (c.missing) {
        return `<tr><td>${esc(c.label)}</td><td colspan="4" class="ext-empty">missing</td></tr>`;
      }
      const smart = c.report === "tff" ? net(c.assetMgrNet) : net(c.managedMoneyNet);
      const lev = c.report === "tff" ? net(c.levMoneyNet) : { t: "—", c: "" };
      const lens = c.report === "tff" ? "asset mgr" : "managed $";
      return `<tr>
        <td>${esc(c.label)}<div class="ext-meta">${esc(c.gf || c.report)}</div></td>
        <td class="num ${smart.c}">${esc(smart.t)}</td>
        <td class="num ${lev.c}">${esc(lev.t)}</td>
        <td class="num">${fmt(c.openInterest)}</td>
        <td class="ext-meta">${esc(lens)}</td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `
    <header>
      <h2>CFTC positioning</h2>
      <span class="ext-meta">as of ${esc(data.tffAsOf)}</span>
    </header>
    <table class="ext-table">
      <thead><tr><th>Contract</th><th class="num">Smart net</th><th class="num">Lev net</th><th class="num">OI</th><th>Lens</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="ext-note">${esc(data.note || "")}</p>`;
}

function renderConvex(el, data) {
  if (!data) {
    el.innerHTML = `<p class="ext-err">Convex missing — run <code>npm run fetch:external</code></p>`;
    return;
  }
  const stale = Number(data.staleDays);
  const staleCls = Number.isFinite(stale) && stale >= 14 ? "warn" : "";
  const views = Object.entries(data.assetViews || {})
    .map(
      ([k, v]) =>
        `<div class="ext-cell"><span class="lbl">${esc(k)}</span><span class="val ${dirClass(v.direction)}">${esc(v.direction || "—")}${v.conviction ? " · " + esc(v.conviction) : ""}</span></div>`
    )
    .join("");
  const story = String(data.narrative || "").trim();
  const attr = data.attribution || {};
  el.innerHTML = `
    <header>
      <h2>Convex regime</h2>
      <span class="ext-meta">generated ${esc(data.asOf)}</span>
    </header>
    <div class="ext-pills">
      <span class="ext-pill">${esc(data.regime || "—")}</span>
      <span class="ext-pill">${esc(data.trajectory || "—")}</span>
      <span class="ext-pill ${staleCls}">${esc(Number.isFinite(stale) ? `${stale}d stale` : "age ?")}</span>
    </div>
    <div class="ext-grid">${views}</div>
    ${story ? `<p class="ext-story">${esc(story.slice(0, 900))}${story.length > 900 ? "…" : ""}</p>` : ""}
    <p class="ext-note">${esc(data.note || "")}${
      attr.url
        ? ` · <a href="${esc(attr.url)}" target="_blank" rel="noopener">${esc(attr.text || "source")}</a>`
        : ""
    }</p>`;
}

function renderHouse(el, text) {
  const rows = parseCsv(text).filter((r) =>
    ["equities", "treasuries", "credit", "gold", "commodities", "crypto"].some(
      (k) => (r[k] || "").trim()
    )
  );
  if (!rows.length) {
    el.innerHTML = `
      <header><h2>House card</h2><span class="ext-meta">manual</span></header>
      <p class="ext-empty">Empty. Fill <code>data/external/house-card.csv</code> with OW / N / UW from the template.</p>`;
    return;
  }
  const body = rows
    .map((r) => {
      const cells = ["equities", "treasuries", "credit", "gold", "commodities", "crypto"]
        .map((k) => {
          const v = (r[k] || "").toUpperCase();
          const c = v === "OW" ? "up" : v === "UW" ? "down" : "";
          return `<td class="${c}">${esc(v || "—")}</td>`;
        })
        .join("");
      return `<tr><td>${esc(r.month)} ${esc(r.house)}</td>${cells}</tr>`;
    })
    .join("");
  el.innerHTML = `
    <header><h2>House card</h2><span class="ext-meta">${rows.length} row${rows.length === 1 ? "" : "s"}</span></header>
    <table class="ext-table">
      <thead><tr><th>House</th><th>Eq</th><th>Ust</th><th>Cred</th><th>Gold</th><th>Cmdty</th><th>Crypto</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="ext-note">Hand-coded from public outlooks.</p>`;
}

async function loadAll() {
  $("status").textContent = "Loading…";
  const q = `?t=${Date.now()}`;
  const settled = await Promise.allSettled([
    getJson(`data/external/fear-greed/latest.json${q}`),
    getJson(`data/external/cot/latest.json${q}`),
    getJson(`data/external/convex/latest.json${q}`),
    getText(`data/external/house-card.csv${q}`),
  ]);
  const [fear, cot, convex, house] = settled.map((r) =>
    r.status === "fulfilled" ? r.value : null
  );
  renderFear($("cardFear"), fear);
  renderCot($("cardCot"), cot);
  renderConvex($("cardConvex"), convex);
  renderHouse($("cardHouse"), house);
  const ok = settled.filter((r) => r.status === "fulfilled").length;
  $("status").textContent = `${ok}/4 loaded · ${new Date().toLocaleString()}`;
}

$("btnReload").addEventListener("click", () => {
  loadAll().catch((e) => {
    $("status").textContent = String(e.message || e);
  });
});

loadAll().catch((e) => {
  $("status").textContent = String(e.message || e);
});
