/** Shelf — outside reads next to today’s regime. Not a voter. */

const $ = (id) => document.getElementById(id);

const LIGHTS = ["liquidity", "rates", "growth", "inflation", "risk"];

const SIX = [
  { id: "treasuries", name: "Treasuries", gf: "treasuries", house: "treasuries" },
  { id: "credit", name: "Credit", gf: null, house: "credit" },
  { id: "stocks", name: "Equities", gf: "equities", house: "equities" },
  { id: "crypto", name: "Crypto", gf: "crypto", house: "crypto" },
  { id: "gold", name: "Gold", gf: "gold", house: "gold" },
  { id: "cmdty", name: "Commodity", gf: "commodities", house: "commodities" },
];

const COT_ORDER = [
  "ust_5y",
  "ust_10y",
  "ust_ultra",
  "es",
  "nq",
  "btc",
  "gold",
  "copper",
  "wti",
  "dxy",
];

const COT_SHORT = {
  ust_5y: "5y",
  ust_10y: "10y",
  ust_ultra: "ultra",
  es: "ES",
  nq: "NQ",
  btc: "BTC",
  gold: "gold",
  copper: "Cu",
  wti: "WTI",
  dxy: "DXY",
};

const COT_GROUPS = [
  { gf: "treasuries", name: "Treasuries" },
  { gf: "equities", name: "Equities" },
  { gf: "crypto", name: "Crypto" },
  { gf: "gold", name: "Gold" },
  { gf: "commodities", name: "Commodity" },
  { gf: null, name: "Dollar" },
];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function head(title, asOf) {
  return `<div class="shelf-head"><h2>${esc(title)}</h2>${
    asOf ? `<span class="shelf-asof">${esc(asOf)}</span>` : ""
  }</div>`;
}

function empty(msg) {
  return `<p class="shelf-empty">${msg}</p>`;
}

function signedPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  const d = abs >= 10 ? 0 : 1;
  const body = abs.toFixed(d);
  if (v > 0) return `+${body}%`;
  if (v < 0) return `−${body}%`;
  return `${body}%`;
}

function compact(n, signed = true) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  if (abs >= 1e6) {
    const x = abs / 1e6;
    return `${sign}${x >= 10 ? x.toFixed(1) : x.toFixed(2)}M`;
  }
  if (abs >= 1e3) {
    const x = abs / 1e3;
    return `${sign}${x >= 100 ? x.toFixed(0) : x.toFixed(1)}k`;
  }
  return `${sign}${Math.round(abs)}`;
}

function netOf(c) {
  if (!c || c.missing) return null;
  return c.report === "tff" ? c.assetMgrNet : c.managedMoneyNet;
}

function pctOi(net, oi) {
  if (net == null || !oi) return null;
  return (100 * net) / oi;
}

function toneNet(n) {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return "neutral";
  return Number(n) > 0 ? "easing" : "tight";
}

function stanceWord(s) {
  if (s === "in") return "in";
  if (s === "out") return "out";
  if (s === "mixed") return "mixed";
  return "—";
}

function stanceState(s) {
  if (s === "in" || s === "OW") return "easing";
  if (s === "out" || s === "UW") return "tight";
  if (s === "mixed" || s === "N") return "neutral";
  return "";
}

function moodState(s) {
  const r = String(s || "").toLowerCase();
  if (r.includes("greed")) return "easing";
  if (r.includes("fear")) return "tight";
  return "neutral";
}

function sortCot(list) {
  return [...(list || [])].sort((a, b) => {
    const ia = COT_ORDER.indexOf(a.id);
    const ib = COT_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function lensOf(c) {
  if (!c || c.missing) return "";
  return c.report === "tff" ? "asset mgr" : "managed $";
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

function houseLatest(text) {
  const rows = parseCsv(text).filter((r) =>
    ["equities", "treasuries", "credit", "gold", "commodities", "crypto"].some(
      (k) => (r[k] || "").trim()
    )
  );
  if (!rows.length) return [];
  const month = rows.map((r) => r.month || "").sort().at(-1);
  return rows.filter((r) => r.month === month);
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

function renderMix(el, arsenal, regime) {
  const lights = regime?.lights || {};
  const chain = LIGHTS.map((id) => {
    const L = lights[id];
    const label = L?.label || id;
    const word = L?.word || "—";
    const st = L?.state || "";
    return `<li>
      <span class="chain-label">${esc(label)}</span>
      <span class="chain-sub" data-state="${esc(st)}">${esc(word)}</span>
    </li>`;
  }).join("");

  if (!arsenal) {
    el.innerHTML = `
      ${head("Simple regime")}
      <p>Someone else’s two questions — growth up or down, inflation up or down — next to our five.</p>
      ${empty("Arsenal file missing.")}
      <ol class="about-chain" aria-label="Today’s five">${chain}</ol>`;
    return;
  }

  const attr = arsenal.attribution || {};
  el.innerHTML = `
    ${head("Simple regime", `as of ${arsenal.asOf || "—"}`)}
    <p>Someone else’s two questions — growth up or down, inflation up or down — next to our five.</p>
    <div class="shelf-hero-row">
      <div class="shelf-score">${esc(arsenal.regime || "—")}</div>
      <div class="shelf-hero-meta">
        GDP ${Number.isFinite(Number(arsenal.gdpYoy)) ? Number(arsenal.gdpYoy).toFixed(2) : "—"}%
        · CPI ${Number.isFinite(Number(arsenal.cpiYoy)) ? Number(arsenal.cpiYoy).toFixed(2) : "—"}%
      </div>
    </div>
    <ol class="about-chain" aria-label="Today’s five">${chain}</ol>
    <div class="shelf-split">
      <div class="about-door">
        <h3>Winners</h3>
        <p>${esc(arsenal.winners || "—")}</p>
      </div>
      <div class="about-door">
        <h3>Losers</h3>
        <p>${esc(arsenal.losers || "—")}</p>
      </div>
    </div>
    <p class="shelf-note">Their published rule, run on our GDP and CPI.${
      attr.url
        ? ` · <a href="${esc(attr.url)}" target="_blank" rel="noopener">Arsenal</a>`
        : ""
    }</p>`;
}

function cotLine(c) {
  if (!c || c.missing) return "";
  const net = netOf(c);
  const pct = pctOi(net, c.openInterest);
  return `<span data-state="${toneNet(pct)}">${esc(COT_SHORT[c.id] || c.label)} ${esc(signedPct(pct))}</span>`;
}

function houseCell(rows, key) {
  if (!rows.length) return `<span class="shelf-empty">—</span>`;
  const bits = rows
    .map((r) => {
      const v = String(r[key] || "").toUpperCase();
      if (!v) return "";
      const name = (r.house || "").replace(/\s+/g, " ").trim();
      const short = name.replace(/\s+(FMS|BII|TAA)$/i, "");
      return `<span data-state="${stanceState(v)}">${esc(short ? `${short} ${v}` : v)}</span>`;
    })
    .filter(Boolean);
  return bits.length ? bits.join("<br>") : `<span class="shelf-empty">—</span>`;
}

function renderSix(el, regime, cot, houseRows) {
  const byId = Object.fromEntries(
    (regime?.meaning?.favor?.items || []).map((it) => [it.id, it])
  );
  const contracts = sortCot(cot?.contracts || []);
  const rows = SIX.map((cls) => {
    const it = byId[cls.id];
    const word = stanceWord(it?.stance);
    const st = stanceState(it?.stance);
    const cots = cls.gf
      ? contracts.filter((c) => c.gf === cls.gf && !c.missing)
      : [];
    const fut =
      !cls.gf
        ? `<span class="shelf-empty">—</span>`
        : cots.length
          ? cots.map(cotLine).join(" · ")
          : `<span class="shelf-empty">—</span>`;
    return `<div class="shelf-class">
      <h3>${esc(cls.name)}</h3>
      <div class="shelf-class-grid">
        <div>
          <span class="lbl">This app</span>
          <span class="val" data-state="${esc(st)}">${esc(word)}</span>
        </div>
        <div>
          <span class="lbl">Futures</span>
          <span class="val">${fut}</span>
        </div>
        <div>
          <span class="lbl">Houses</span>
          <span class="val">${houseCell(houseRows, cls.house)}</span>
        </div>
      </div>
    </div>`;
  }).join("");

  const houseNote = houseRows.length
    ? `${houseRows.length} house${houseRows.length === 1 ? "" : "s"} · ${houseRows[0].month}`
    : "No house row this month";
  el.innerHTML = `
    ${head("The six", houseNote)}
    <p>Our call, futures money, and what a house published — when there is a row.</p>
    ${rows}
    <p class="shelf-note">Futures are net as a share of open interest. Credit has no futures line here.</p>`;
}

function renderMood(el, fear, regime) {
  const risk = regime?.lights?.risk;
  if (!fear) {
    el.innerHTML = `
      ${head("Mood")}
      <p>Stock-market fear and greed next to Risk.</p>
      ${empty("Fear &amp; Greed file missing.")}
      ${
        risk
          ? `<div class="about-door"><h3>Risk</h3><p data-state="${esc(risk.state)}">${esc(risk.word)}</p></div>`
          : ""
      }`;
    return;
  }
  const cells = Object.entries(fear.subs || {})
    .map(([k, v]) => {
      const label = k.replaceAll("_", " ").replace("sp500", "S&P");
      return `<div class="about-door">
        <h3>${esc(label)}</h3>
        <p data-state="${moodState(v.rating)}">${esc(Math.round(v.score))} · ${esc(v.rating || "—")}</p>
      </div>`;
    })
    .join("");
  el.innerHTML = `
    ${head("Mood", `as of ${fear.asOf || "—"}`)}
    <p>Stock-market fear and greed next to Risk. Not a desk note.</p>
    <div class="shelf-mood">
      <div>
        <div class="shelf-score" data-state="${moodState(fear.rating)}">${esc(Math.round(fear.score))}</div>
        <div class="shelf-hero-meta" data-state="${moodState(fear.rating)}">${esc(fear.rating)}</div>
        <div class="shelf-hero-meta">week ${esc(Math.round(fear.previous1Week))} · month ${esc(Math.round(fear.previous1Month))}</div>
      </div>
      <div class="about-door">
        <h3>Risk</h3>
        <p data-state="${esc(risk?.state || "")}">${esc(risk?.word || "—")}</p>
      </div>
    </div>
    <div class="shelf-subs">${cells}</div>
    <p class="shelf-note">CNN Fear &amp; Greed. Stock-market mood.</p>`;
}

function cotCard(c) {
  if (c.missing) {
    return `<div class="about-door"><h3>${esc(c.label)}</h3><p class="shelf-empty">missing</p></div>`;
  }
  const net = netOf(c);
  const pct = pctOi(net, c.openInterest);
  const lev = c.report === "tff" ? c.levMoneyNet : null;
  const levPct = pctOi(lev, c.openInterest);
  const extra =
    c.report === "tff"
      ? `<span class="lbl">Lev</span><span class="val" data-state="${toneNet(levPct)}">${esc(signedPct(levPct))} · ${esc(compact(lev))}</span>`
      : `<span class="lbl">Producer</span><span class="val" data-state="${toneNet(c.producerNet)}">${esc(compact(c.producerNet))}</span>
         <span class="lbl">Swap</span><span class="val" data-state="${toneNet(c.swapNet)}">${esc(compact(c.swapNet))}</span>`;
  return `<div class="about-door shelf-cot-card">
    <h3>${esc(c.label)}</h3>
    <p class="shelf-asof">${esc(lensOf(c))}</p>
    <div class="shelf-cot-grid">
      <span class="lbl">Net</span>
      <span class="val" data-state="${toneNet(pct)}">${esc(signedPct(pct))} of OI · ${esc(compact(net))}</span>
      ${extra}
      <span class="lbl">OI</span>
      <span class="val">${esc(compact(c.openInterest, false))}</span>
    </div>
  </div>`;
}

function renderCot(el, cot) {
  if (!cot) {
    el.innerHTML = `${head("Futures")}${empty("CFTC file missing.")}`;
    return;
  }
  const contracts = sortCot(cot.contracts || []);
  const groups = COT_GROUPS.map((g) => {
    const rows = contracts.filter((c) => (c.gf || null) === g.gf);
    if (!rows.length) return "";
    return `<h3 class="shelf-group">${esc(g.name)}</h3>
      <div class="shelf-cot-list">${rows.map(cotCard).join("")}</div>`;
  }).join("");
  el.innerHTML = `
    ${head("Futures", `as of ${cot.tffAsOf || "—"}`)}
    <p>Who is long and short. Net is a share of open interest so a 10-year note and Bitcoin can sit on the same page.</p>
    ${groups}
    <p class="shelf-note">As-of is usually Tuesday. The report usually publishes Friday.</p>`;
}

async function loadAll() {
  const q = `?t=${Date.now()}`;
  const settled = await Promise.allSettled([
    getJson(`./regime-today.json${q}`),
    getJson(`data/external/arsenal/latest.json${q}`),
    getJson(`data/external/cot/latest.json${q}`),
    getJson(`data/external/fear-greed/latest.json${q}`),
    getText(`data/external/house-card.csv${q}`),
  ]);
  const pick = (i) => (settled[i].status === "fulfilled" ? settled[i].value : null);
  const regime = pick(0);
  const arsenal = pick(1);
  const cot = pick(2);
  const fear = pick(3);
  const houseRows = houseLatest(pick(4) || "");
  renderMix($("mix"), arsenal, regime);
  renderSix($("six"), regime, cot, houseRows);
  renderMood($("mood"), fear, regime);
  renderCot($("cot"), cot);
}

loadAll().catch((e) => {
  $("mix").innerHTML = empty(String(e.message || e));
});
