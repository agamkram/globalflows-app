/** Shelf — outside reads next to today’s regime. Not a voter. */

import { arsenalFromSnapshot, pullCot } from "./shelf-lib.js?v=20261241";

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

function shortDay(iso) {
  if (!iso) return "—";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function stamp(iso, cadence) {
  return iso ? `${shortDay(iso)} · ${cadence}` : cadence;
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

/** Composite on Equities. Junk demand on Credit. Rest blank — they do not name those classes. */
function cnnClass(fear, classId) {
  if (!fear) return { word: "—", state: "" };
  let rating = null;
  if (classId === "stocks") rating = fear.rating;
  else if (classId === "credit") rating = fear.subs?.junk_bond_demand?.rating;
  if (!rating) return { word: "—", state: "" };
  return { word: String(rating).toLowerCase(), state: moodState(rating) };
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

const CNN_LABEL = {
  market_momentum_sp500: "S&P momentum",
  stock_price_strength: "Strength",
  stock_price_breadth: "Breadth",
  put_call_options: "Put/call",
  market_volatility_vix: "VIX",
  junk_bond_demand: "Junk demand",
  safe_haven_demand: "Safe haven",
};

const COT_SHORT = {
  ust_5y: "5y",
  ust_10y: "10y",
  ust_ultra: "Ultra",
  es: "ES",
  nq: "NQ",
  btc: "Bitcoin",
  gold: "Gold",
  copper: "Copper",
  wti: "WTI",
  dxy: "Dollar",
};

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
      ${head("Arsenal", "CPI / GDP")}
      <p>They only use GDP and CPI, then pick one of four names. Our five sit under that name so you can see cash, rates, and fear — which it ignores.</p>
      ${empty("Arsenal file missing.")}
      <ol class="about-chain" aria-label="Today’s five">${chain}</ol>`;
    return;
  }

  const attr = arsenal.attribution || {};
  el.innerHTML = `
    ${head("Arsenal", stamp(arsenal.asOf, "CPI / GDP"))}
    <p>They only use GDP and CPI, then pick one of four names. Our five sit under that name so you can see cash, rates, and fear — which it ignores.</p>
    <div class="shelf-hero-row">
      <div class="shelf-score">${esc(arsenal.regime || "—")}</div>
      <div class="shelf-hero-meta">
        GDP ${Number.isFinite(Number(arsenal.gdpYoy)) ? Number(arsenal.gdpYoy).toFixed(2) : "—"}%
        · CPI ${Number.isFinite(Number(arsenal.cpiYoy)) ? Number(arsenal.cpiYoy).toFixed(2) : "—"}%${
          attr.url
            ? ` · <a href="${esc(attr.url)}" target="_blank" rel="noopener">source</a>`
            : ""
        }
      </div>
    </div>
    <ol class="about-chain" aria-label="Today’s five">${chain}</ol>
    <div class="shelf-likes">
      <div><span class="lbl">Usually likes</span><span class="val">${esc(arsenal.winners || "—")}</span></div>
      <div><span class="lbl">Usually doesn’t</span><span class="val">${esc(arsenal.losers || "—")}</span></div>
    </div>`;
}

/** Arsenal’s published likes/doesn’t, mapped onto our six. Null = they didn’t name it. */
const BOX_TILT = {
  Goldilocks: {
    treasuries: null,
    credit: "in",
    stocks: "in",
    crypto: null,
    gold: "out",
    cmdty: "out",
  },
  Reflation: {
    treasuries: "out",
    credit: null,
    stocks: "mixed",
    crypto: null,
    gold: null,
    cmdty: "in",
  },
  Deflation: {
    treasuries: "in",
    credit: "out",
    stocks: "out",
    crypto: null,
    gold: null,
    cmdty: "out",
  },
  Stagflation: {
    treasuries: "out",
    credit: "out",
    stocks: "out",
    crypto: null,
    gold: "in",
    cmdty: "in",
  },
};

function boxWord(arsenal, classId) {
  const tilt = BOX_TILT[arsenal?.regime]?.[classId];
  if (!tilt) return { word: "—", state: "" };
  return { word: stanceWord(tilt), state: stanceState(tilt) };
}

function crowding(contracts) {
  const pcts = (contracts || [])
    .map((c) => pctOi(netOf(c), c.openInterest))
    .filter((n) => n != null && Number.isFinite(n));
  if (!pcts.length) return { word: "—", state: "" };
  const longN = pcts.filter((p) => p > 10).length;
  const shortN = pcts.filter((p) => p < -10).length;
  if (longN && !shortN) return { word: "long", state: "easing" };
  if (shortN && !longN) return { word: "short", state: "tight" };
  return { word: "mixed", state: "neutral" };
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

function renderSix(el, regime, cot, houseRows, arsenal, fear) {
  const byId = Object.fromEntries(
    (regime?.meaning?.favor?.items || []).map((it) => [it.id, it])
  );
  const contracts = sortCot(cot?.contracts || []);
  const showHouses = houseRows.length > 0;
  const rows = SIX.map((cls) => {
    const it = byId[cls.id];
    const word = stanceWord(it?.stance);
    const st = stanceState(it?.stance);
    const box = boxWord(arsenal, cls.id);
    const cots = cls.gf
      ? contracts.filter((c) => c.gf === cls.gf && !c.missing)
      : [];
    const fut = crowding(cots);
    const cnn = cnnClass(fear, cls.id);
    const house = showHouses
      ? `<td>${houseCell(houseRows, cls.house)}</td>`
      : "";
    return `<tr>
      <th scope="row">${esc(cls.name)}</th>
      <td data-state="${esc(st)}">${esc(word)}</td>
      <td data-state="${esc(box.state)}">${esc(box.word)}</td>
      <td data-state="${esc(fut.state)}">${esc(fut.word)}</td>
      <td data-state="${esc(cnn.state)}">${esc(cnn.word)}</td>
      ${house}
    </tr>`;
  }).join("");

  el.innerHTML = `
    ${head("GlobalFlows · Arsenal · CFTC · CNN", stamp(cot?.tffAsOf, "weekly (Fri)"))}
    <table class="shelf-table">
      <thead>
        <tr>
          <th></th>
          <th>GlobalFlows</th>
          <th>Arsenal</th>
          <th>CFTC</th>
          <th>CNN</th>
          ${showHouses ? "<th>Houses</th>" : ""}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="shelf-note">A dash is blank. Long / short is futures. Fear / greed is CNN, not in / mixed / out.</p>`;
}

function renderMood(el, fear, regime) {
  const risk = regime?.lights?.risk;
  if (!fear) {
    el.innerHTML = `
      ${head("CNN", "daily")}
      <p>Stock-market fear and greed next to Risk.</p>
      ${empty("CNN file missing.")}
      ${
        risk
          ? `<p class="shelf-risk">Risk <span data-state="${esc(risk.state)}">${esc(risk.word)}</span></p>`
          : ""
      }`;
    return;
  }
  const cells = Object.entries(fear.subs || {})
    .map(([k, v]) => {
      const label = CNN_LABEL[k] || k.replaceAll("_", " ");
      return `<div class="shelf-sub">
        <span class="lbl">${esc(label)}</span>
        <span class="val" data-state="${moodState(v.rating)}">${esc(Math.round(v.score))} · ${esc(v.rating || "—")}</span>
      </div>`;
    })
    .join("");
  el.innerHTML = `
    ${head("CNN", stamp(fear.asOf, "daily"))}
    <p>Stock-market mood next to Risk. Not a desk note.</p>
    <div class="shelf-mood">
      <div class="shelf-hero-row">
        <div class="shelf-score" data-state="${moodState(fear.rating)}">${esc(Math.round(fear.score))}</div>
        <div>
          <div class="shelf-hero-meta" data-state="${moodState(fear.rating)}">${esc(fear.rating)}</div>
          <div class="shelf-hero-meta">week ${esc(Math.round(fear.previous1Week))} · month ${esc(Math.round(fear.previous1Month))}</div>
        </div>
      </div>
      <p class="shelf-risk">Risk · <span data-state="${esc(risk?.state || "")}">${esc(risk?.word || "—")}</span></p>
    </div>
    <div class="shelf-subs">${cells}</div>`;
}

function cotRow(c) {
  if (c.missing) {
    return `<tr><th scope="row">${esc(COT_SHORT[c.id] || c.label)}</th><td colspan="3" class="shelf-empty">missing</td></tr>`;
  }
  const net = netOf(c);
  const pct = pctOi(net, c.openInterest);
  const levPct =
    c.report === "tff"
      ? pctOi(c.levMoneyNet, c.openInterest)
      : pctOi(c.producerNet, c.openInterest);
  return `<tr>
    <th scope="row">${esc(COT_SHORT[c.id] || c.label)}<span class="shelf-lens">${esc(lensOf(c))}</span></th>
    <td class="num" data-state="${toneNet(pct)}">${esc(signedPct(pct))}</td>
    <td class="num" data-state="${toneNet(levPct)}">${esc(signedPct(levPct))}</td>
    <td class="num">${esc(compact(c.openInterest, false))}</td>
  </tr>`;
}

function renderCot(el, cot) {
  if (!cot) {
    el.innerHTML = `${head("CFTC", "weekly (Fri)")}${empty("CFTC file missing.")}`;
    return;
  }
  const contracts = sortCot(cot.contracts || []);
  const bodies = COT_GROUPS.map((g) => {
    const rows = contracts.filter((c) => (c.gf || null) === g.gf);
    if (!rows.length) return "";
    return `<tbody>
      <tr class="shelf-group-row"><th scope="colgroup" colspan="4">${esc(g.name)}</th></tr>
      ${rows.map(cotRow).join("")}
    </tbody>`;
  }).join("");
  el.innerHTML = `
    ${head("CFTC", stamp(cot.tffAsOf, "weekly (Fri)"))}
    <p>Who is long and short. Net is a share of open interest.</p>
    <table class="shelf-table shelf-cot">
      <thead>
        <tr>
          <th></th>
          <th class="num">Net</th>
          <th class="num">Lev</th>
          <th class="num">OI</th>
        </tr>
      </thead>
      ${bodies}
    </table>`;
}

async function loadAll() {
  const q = `?t=${Date.now()}`;
  const liveJson = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  };
  const [regimeS, snapS, cotLiveS, fearLiveS, cotFileS, fearFileS, arsenalFileS, houseS] =
    await Promise.allSettled([
      getJson(`./regime-today.json${q}`),
      getJson(`./snapshot.json${q}`),
      pullCot(liveJson),
      getJson(`./api/fear-greed${q}`),
      getJson(`data/external/cot/latest.json${q}`),
      getJson(`data/external/fear-greed/latest.json${q}`),
      getJson(`data/external/arsenal/latest.json${q}`),
      getText(`data/external/house-card.csv${q}`),
    ]);
  const ok = (s) => (s.status === "fulfilled" ? s.value : null);
  const regime = ok(regimeS);
  const arsenal =
    arsenalFromSnapshot(ok(snapS)) || ok(arsenalFileS);
  const cot = ok(cotLiveS) || ok(cotFileS);
  const fear = ok(fearLiveS)?.score != null ? ok(fearLiveS) : ok(fearFileS);
  const houseRows = houseLatest(ok(houseS) || "");
  renderMix($("mix"), arsenal, regime);
  renderSix($("six"), regime, cot, houseRows, arsenal, fear);
  renderMood($("mood"), fear, regime);
  renderCot($("cot"), cot);
}

loadAll().catch((e) => {
  $("mix").innerHTML = empty(String(e.message || e));
});
