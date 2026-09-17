/** Annex — reads next to today’s regime, plus our morning stamps. */

import { arsenalFromSnapshot, pullCot } from "./shelf-lib.js?v=20261341";
import { chipWord, CHIP_WORD } from "./light-copy.js?v=20261341";
import { chipBandFromScore } from "./score.js?v=20261341";

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
  return `<div class="annex-head"><h2>${esc(title)}</h2>${
    asOf ? `<span class="annex-asof">${esc(asOf)}</span>` : ""
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
  return `<p class="annex-note">${msg}</p>`;
}

function note(msg) {
  return `<p class="annex-note">${msg}</p>`;
}

function bandState(score) {
  const b = chipBandFromScore(score);
  if (b === "easing" || b === "leaningEasing") return "easing";
  if (b === "tight" || b === "leaningTight") return "tight";
  return "neutral";
}

function classHead(name, short) {
  return `<span class="annex-full">${esc(name)}</span><span class="annex-abbr">${esc(short)}</span>`;
}

function meter(score, state, label) {
  const n = Math.max(0, Math.min(100, Number(score)));
  const w = Number.isFinite(n) ? n : 0;
  return `<div class="annex-meter" data-state="${esc(state)}" role="img" aria-label="${esc(label)}">
    <span class="annex-meter-track"><i style="width:${w}%"></i></span>
    <span class="annex-meter-n">${Number.isFinite(n) ? Math.round(n) : "—"}</span>
  </div>`;
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
      <p>GDP and CPI only, then one of four names. Our five sit under it so cash, rates, and fear — which it ignores — stay in view.</p>
      ${empty("Arsenal file missing.")}
      <ol class="about-chain annex-chain" aria-label="Today’s five">${chain}</ol>`;
    return;
  }

  const attr = arsenal.attribution || {};
  el.innerHTML = `
    ${head("Arsenal", stamp(arsenal.asOf, "CPI / GDP"))}
    <p>GDP and CPI only, then one of four names. Our five sit under it so cash, rates, and fear — which it ignores — stay in view.</p>
    <div class="annex-call">
      <div class="annex-call-name">${esc(arsenal.regime || "—")}</div>
      <div class="annex-call-meta">
        GDP ${Number.isFinite(Number(arsenal.gdpYoy)) ? Number(arsenal.gdpYoy).toFixed(1) : "—"}%
        · CPI ${Number.isFinite(Number(arsenal.cpiYoy)) ? Number(arsenal.cpiYoy).toFixed(1) : "—"}%${
          attr.url
            ? ` · <a href="${esc(attr.url)}" target="_blank" rel="noopener">source</a>`
            : ""
        }
      </div>
    </div>
    <ol class="about-chain annex-chain" aria-label="Today’s five">${chain}</ol>
    <div class="annex-likes">
      <div><span class="annex-lbl">Usually likes</span><span class="annex-val">${esc(arsenal.winners || "—")}</span></div>
      <div><span class="annex-lbl">Usually doesn’t</span><span class="annex-val">${esc(arsenal.losers || "—")}</span></div>
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
  if (!rows.length) return `<span class="annex-blank">—</span>`;
  const bits = rows
    .map((r) => {
      const v = String(r[key] || "").toUpperCase();
      if (!v) return "";
      const name = (r.house || "").replace(/\s+/g, " ").trim();
      const short = name.replace(/\s+(FMS|BII|TAA)$/i, "");
      return `<span data-state="${stanceState(v)}">${esc(short ? `${short} ${v}` : v)}</span>`;
    })
    .filter(Boolean);
  return bits.length
    ? `<span class="annex-house">${bits.join("")}</span>`
    : `<span class="annex-blank">—</span>`;
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
    ${head("Compare", stamp(cot?.tffAsOf, "weekly futures"))}
    <p>G Flow, then three other desks. A blank cell means they did not name that class. Fear and greed are CNN’s words, not in / mixed / out.</p>
    <div class="annex-scroll">
    <table class="annex-table">
      <thead>
        <tr>
          <th></th>
          <th>G Flow</th>
          <th>Arsenal</th>
          <th>Futures</th>
          <th>CNN</th>
          ${showHouses ? "<th>Houses</th>" : ""}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

function renderMood(el, fear, regime) {
  const risk = regime?.lights?.risk;
  const riskWord = risk?.word || "—";
  const riskSt = risk?.state || "";
  if (!fear) {
    el.innerHTML = `
      ${head("CNN", "daily")}
      <p>CNN’s stock-market fear and greed, set next to our Risk light. Equity-centric, unofficial, not a vote.</p>
      ${empty("CNN file missing.")}
      ${
        risk
          ? `<p class="annex-pair">Our Risk is <span data-state="${esc(riskSt)}">${esc(riskWord)}</span>.</p>`
          : ""
      }`;
    return;
  }
  const st = moodState(fear.rating);
  const week = Number.isFinite(Number(fear.previous1Week))
    ? Math.round(fear.previous1Week)
    : "—";
  const month = Number.isFinite(Number(fear.previous1Month))
    ? Math.round(fear.previous1Month)
    : "—";
  const cells = Object.entries(fear.subs || {})
    .map(([k, v]) => {
      const label = CNN_LABEL[k] || k.replaceAll("_", " ");
      const subSt = moodState(v.rating);
      const word = String(v.rating || "").toLowerCase();
      return `<div class="annex-sub">
        <span class="annex-sub-label">${esc(label)}</span>
        ${meter(v.score, subSt, `${label} ${Math.round(v.score)}, ${word}`)}
        <span class="annex-sub-word" data-state="${esc(subSt)}">${esc(word)}</span>
      </div>`;
    })
    .join("");
  el.innerHTML = `
    ${head("CNN", stamp(fear.asOf, "daily"))}
    <p>CNN’s stock-market fear and greed, set next to our Risk light. Equity-centric, unofficial, not a vote.</p>
    <div class="annex-mood">
      <div class="annex-mood-us">
        <span class="annex-lbl">CNN</span>
        <div class="annex-mood-word" data-state="${esc(st)}">${esc(fear.rating)}</div>
        ${meter(fear.score, st, `Fear and greed ${Math.round(fear.score)}, ${fear.rating}`)}
        <span class="annex-call-meta">Week ${esc(week)} · month ${esc(month)}</span>
      </div>
      <div class="annex-mood-them">
        <span class="annex-lbl">Our Risk</span>
        <div class="annex-mood-word" data-state="${esc(riskSt)}">${esc(riskWord)}</div>
        <span class="annex-call-meta">The five, not their gauge.</span>
      </div>
    </div>
    <div class="annex-subs">${cells}</div>`;
}

function cotRow(c) {
  if (c.missing) {
    return `<tr><th scope="row">${esc(COT_SHORT[c.id] || c.label)}</th><td colspan="3" class="annex-blank">missing</td></tr>`;
  }
  const net = netOf(c);
  const pct = pctOi(net, c.openInterest);
  const levPct =
    c.report === "tff"
      ? pctOi(c.levMoneyNet, c.openInterest)
      : pctOi(c.producerNet, c.openInterest);
  return `<tr>
    <th scope="row">${esc(COT_SHORT[c.id] || c.label)}<span class="annex-lens">${esc(lensOf(c))}</span></th>
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
      <tr class="annex-group"><th scope="colgroup" colspan="4">${esc(g.name)}</th></tr>
      ${rows.map(cotRow).join("")}
    </tbody>`;
  }).join("");
  el.innerHTML = `
    ${head("CFTC", stamp(cot.tffAsOf, "weekly (Fri)"))}
    <p>CFTC: who is long and short. Net is a share of open interest. Lev is levered money, or producers on the commodity contracts.</p>
    <div class="annex-scroll">
    <table class="annex-table annex-cot">
      <thead>
        <tr>
          <th></th>
          <th class="num">Net</th>
          <th class="num">Lev</th>
          <th class="num">OI</th>
        </tr>
      </thead>
      ${bodies}
    </table>
    </div>`;
}

const LOG_CLASS = [
  { id: "treasuries", name: "Treasuries", short: "Tsy" },
  { id: "credit", name: "Credit", short: "Crd" },
  { id: "stocks", name: "Equities", short: "Eq" },
  { id: "crypto", name: "Crypto", short: "Cry" },
  { id: "gold", name: "Gold", short: "Au" },
  { id: "cmdty", name: "Commodity", short: "Cmd" },
];

const LOG_LIGHT = [
  { id: "liquidity", name: "Liquidity" },
  { id: "rates", name: "Rates" },
  { id: "growth", name: "Growth" },
  { id: "inflation", name: "Inflation" },
  { id: "risk", name: "Risk" },
];

function daysWithCalls(log) {
  return (log?.days || []).filter((d) => d?.date && d.calls && Object.keys(d.calls).length);
}

function streakOf(id, callDays) {
  const newestFirst = [...callDays].reverse();
  const stance = newestFirst[0]?.calls?.[id]?.stance;
  if (!stance) return { stance: null, n: 0 };
  let n = 0;
  for (const d of newestFirst) {
    if (d.calls?.[id]?.stance !== stance) break;
    n += 1;
  }
  return { stance, n };
}

function stampMatrix(callDays) {
  if (!callDays.length) return empty("No calls stamped yet.");
  const heads = LOG_CLASS.map(
    (c) => `<th scope="col">${classHead(c.name, c.short)}</th>`
  ).join("");
  const nowCells = LOG_CLASS.map((c) => {
    const { stance, n } = streakOf(c.id, callDays);
    if (!stance) return `<td class="annex-blank">—</td>`;
    const days = n === 1 ? "1 day" : `${n}d`;
    return `<td data-state="${esc(stanceState(stance))}"><b>${esc(stanceWord(stance))}</b><span class="annex-days">${esc(days)}</span></td>`;
  }).join("");
  const past = callDays
    .slice(0, -1)
    .slice(-6)
    .reverse()
    .map((d) => {
      const cells = LOG_CLASS.map((c) => {
        const st = d.calls?.[c.id]?.stance;
        return `<td data-state="${esc(stanceState(st))}">${esc(stanceWord(st))}</td>`;
      }).join("");
      return `<tr><th scope="row">${esc(shortDay(d.date))}</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="annex-scroll">
    <table class="annex-table annex-stamps">
      <thead>
        <tr><th></th>${heads}</tr>
      </thead>
      <tbody>
        <tr class="annex-now"><th scope="row">Now</th>${nowCells}</tr>
        ${past}
      </tbody>
    </table>
  </div>`;
}

function flipList(callDays) {
  if (callDays.length < 2) {
    return note("Need two mornings with calls before a flip can show.");
  }
  const cur = callDays[callDays.length - 1];
  const prev = callDays[callDays.length - 2];
  const rows = [];
  for (const c of LOG_CLASS) {
    const a = prev.calls?.[c.id]?.stance;
    const b = cur.calls?.[c.id]?.stance;
    if (!a || !b || a === b) continue;
    rows.push(`<li>
      <span class="annex-flip-name">${esc(c.name)}</span>
      <span data-state="${esc(stanceState(a))}">${esc(stanceWord(a))}</span>
      <span class="annex-arrow" aria-hidden="true">→</span>
      <span data-state="${esc(stanceState(b))}">${esc(stanceWord(b))}</span>
    </li>`);
  }
  for (const L of LOG_LIGHT) {
    const a = chipWord(L.id, prev.lights?.[L.id]?.score);
    const b = chipWord(L.id, cur.lights?.[L.id]?.score);
    if (!a || !b || a === b) continue;
    rows.push(`<li>
      <span class="annex-flip-name">${esc(L.name)}</span>
      <span data-state="${esc(bandState(prev.lights?.[L.id]?.score))}">${esc(a)}</span>
      <span class="annex-arrow" aria-hidden="true">→</span>
      <span data-state="${esc(bandState(cur.lights?.[L.id]?.score))}">${esc(b)}</span>
    </li>`);
  }
  const when = `${shortDay(prev.date)} → ${shortDay(cur.date)}`;
  if (!rows.length) return `<p class="annex-kicker">${esc(when)}</p>${note("Nothing flipped.")}`;
  return `<p class="annex-kicker">${esc(when)}</p>
    <ul class="annex-flips">${rows.join("")}</ul>`;
}

function anecdoteTable(shelf) {
  const rows = shelf?.anecdotes || [];
  if (!rows.length) {
    return note("A week after a call, the one-week move will show here. Anecdotes, not a record.");
  }
  const body = rows
    .slice(0, 8)
    .map((a) => {
      const tone = a.ret > 0 ? "easing" : a.ret < 0 ? "tight" : "neutral";
      return `<tr>
        <th scope="row">${esc(shortDay(a.date))}</th>
        <td>${esc(a.label || a.class)}</td>
        <td data-state="${esc(stanceState(a.stance))}">${esc(stanceWord(a.stance))}</td>
        <td class="num" data-state="${tone}">${esc(signedPct(a.ret))}</td>
      </tr>`;
    })
    .join("");
  return `<div class="annex-scroll">
    <table class="annex-table">
      <thead>
        <tr><th></th><th>Class</th><th>Call</th><th class="num">1w</th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  ${note("Anecdotes only. Not a track record.")}`;
}

function renderLog(el, log, shelf) {
  if (!el) return;
  if (!log?.days?.length) {
    el.innerHTML = `${head("Stamps", "our mornings")}
      <p>What this app called each morning, written down and never recomputed.</p>
      ${empty("Log file missing.")}`;
    return;
  }
  const callDays = daysWithCalls(log);
  const last = log.days[log.days.length - 1];
  const asOf = stamp(
    last?.date,
    `${callDays.length} morning${callDays.length === 1 ? "" : "s"} with calls`
  );
  el.innerHTML = `
    ${head("Stamps", asOf)}
    <p>Our mornings — written down and never recomputed. The replay archive is a different file.</p>
    ${stampMatrix(callDays)}
    <h3 class="annex-h">Since last time</h3>
    ${flipList(callDays)}
    <h3 class="annex-h">A week later</h3>
    ${anecdoteTable(shelf)}`;
}

const PEER_AXES = [
  { id: "liquidity", name: "Liquidity", short: "L" },
  { id: "rates", name: "Rates", short: "R" },
  { id: "growth", name: "Growth", short: "G" },
  { id: "inflation", name: "Inflation", short: "I" },
  { id: "risk", name: "Risk", short: "Risk" },
];

const PEER_SHORT = {
  ubs: "UBS",
  blackrock: "BLK",
  gsam: "GS",
  citi: "Citi",
  twentytwov: "22V",
  apollo: "Sløk",
  barclays: "Barclays",
  pimco: "PIMCO",
  jpm: "JPM",
};

/** Same five readings as the regime boxes. Vs us is wording, not a third paint job. */
function wordState(word, lid) {
  const raw = String(word || "").trim();
  if (!raw || raw === "—" || raw === "null") return "";
  const want = raw.toLowerCase();
  const tables = lid && CHIP_WORD[lid] ? [CHIP_WORD[lid]] : Object.values(CHIP_WORD);
  for (const table of tables) {
    for (const [band, label] of Object.entries(table)) {
      if (String(label).toLowerCase() === want) return band;
    }
  }
  return "neutral";
}

function peerAxis(h, id) {
  const v = h?.[id];
  if (v == null || v === "") return { word: "—", state: "" };
  return { word: String(v), state: wordState(v, id) };
}

function peerShort(h) {
  return PEER_SHORT[h?.id] || String(h?.name || "—").split(/\s+/)[0];
}

function slashDay(iso) {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const PEER_MARK = {
  easing: "++",
  leaningEasing: "+",
  neutral: "·",
  leaningTight: "−",
  tight: "−−",
};

function peerMark(state, word) {
  if (!state || !word || word === "—") {
    return "";
  }
  const mark = PEER_MARK[state] || "·";
  return `<span class="annex-peer-mark" data-state="${esc(state)}" title="${esc(word)}" aria-label="${esc(word)}">${mark}</span>`;
}

function peerKey() {
  const bands = ["easing", "leaningEasing", "neutral", "leaningTight", "tight"];
  const rows = bands.map((st) => {
    if (st === "neutral") {
      return `<tr class="annex-peer-mid">
      <th scope="row"><span class="annex-peer-mark" data-state="neutral">${PEER_MARK.neutral}</span></th>
      <td colspan="5">Mid · Neutral</td>
    </tr>`;
    }
    const cells = PEER_AXES.map((a) => {
      const raw = CHIP_WORD[a.id]?.[st] || "";
      const word = st === "leaningEasing" || st === "leaningTight" ? "Leaning" : raw;
      return `<td>${esc(word)}</td>`;
    }).join("");
    return `<tr>
      <th scope="row"><span class="annex-peer-mark" data-state="${esc(st)}">${PEER_MARK[st]}</span></th>
      ${cells}
    </tr>`;
  });
  return `<div class="annex-peer annex-peer-legend">
    <table class="annex-table annex-peer-grid annex-peer-key">
    <tbody>${rows.join("")}</tbody>
  </table>
  </div>`;
}

function peerGrid(houses, regime) {
  const lights = regime?.lights || {};
  const heads = [
    "<th></th>",
    ...PEER_AXES.map((a) => `<th>${esc(a.name)}</th>`),
  ].join("");
  const usCells = PEER_AXES.map((a) => {
    const ours = lights[a.id];
    const word = ours?.word || "—";
    const st = Number.isFinite(ours?.score)
      ? chipBandFromScore(ours.score)
      : wordState(word, a.id);
    return `<td>${peerMark(st, word)}</td>`;
  }).join("");
  const usRow = `<tr class="annex-now">
    <th scope="row">G Flow</th>
    ${usCells}
  </tr>`;
  const houseRows = houses
    .map((h) => {
      const cells = PEER_AXES.map((a) => {
        const { word, state } = peerAxis(h, a.id);
        return `<td>${peerMark(state, word)}</td>`;
      }).join("");
      const date = slashDay(h.date);
      const when = date
        ? ` <span class="annex-peer-when">${esc(date)}</span>`
        : "";
      return `<tr>
        <th scope="row">${esc(peerShort(h))}${when}</th>
        ${cells}
      </tr>`;
    })
    .join("");
  return `${peerKey()}
    <table class="annex-table annex-peer-grid">
      <thead><tr>${heads}</tr></thead>
      <tbody>
        ${usRow}
        ${houseRows}
      </tbody>
    </table>`;
}

function peerSnippets(h) {
  const bits = Array.isArray(h?.quotes)
    ? h.quotes
    : h?.quote
      ? [h.quote]
      : [];
  return bits
    .filter(Boolean)
    .map((q) => `<p class="annex-peer-quote">“${esc(q)}”</p>`)
    .join("");
}

function peerNotes(houses) {
  return houses
    .map((h) => {
      const when = slashDay(h.date);
      const who = `${esc(peerShort(h))}${
        when ? ` <span class="annex-peer-when">${esc(when)}</span>` : ""
      }`;
      const title = h.title
        ? h.url
          ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>`
          : esc(h.title)
        : "";
      return `<article class="annex-peer">
        <div class="annex-peer-name">${who}</div>
        ${title ? `<div class="annex-peer-title">${title}</div>` : ""}
        ${peerSnippets(h)}
      </article>`;
    })
    .join("");
}

function renderPeers(el, peers, regime) {
  if (!el) return;
  const houses = peers?.houses || [];
  if (!houses.length) {
    el.innerHTML = `
      ${head("Peers", "hand-placed")}
      <p>G Flow, then the houses. No mark means that page was silent. Nothing here changes the scores.</p>
      ${empty("Peer file missing.")}`;
    return;
  }
  const dates = houses.map((h) => h.date).filter(Boolean).sort();
  const newest = dates[dates.length - 1];
  const oldest = dates[0];
  const range =
    newest && oldest && newest !== oldest
      ? `${slashDay(oldest)}–${slashDay(newest)}`
      : newest
        ? slashDay(newest)
        : "hand-placed";
  el.innerHTML = `
    ${head("Peers", range)}
    <p>G Flow, then the nine houses. A blank cell means they did not speak to that. Dates are theirs. Nothing here changes the scores.</p>
    ${peerGrid(houses, regime)}
    <div class="annex-peers">${peerNotes(houses)}</div>`;
}

async function loadAll() {
  const q = `?t=${Date.now()}`;
  const liveJson = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  };
  const [regimeS, snapS, cotLiveS, fearLiveS, cotFileS, fearFileS, arsenalFileS, houseS, logS, shelfS, peersS] =
    await Promise.allSettled([
      getJson(`./regime-today.json${q}`),
      getJson(`./snapshot.json${q}`),
      pullCot(liveJson),
      getJson(`./api/fear-greed${q}`),
      getJson(`data/external/cot/latest.json${q}`),
      getJson(`data/external/fear-greed/latest.json${q}`),
      getJson(`data/external/arsenal/latest.json${q}`),
      getText(`data/external/house-card.csv${q}`),
      getJson(`data/regime-log.json${q}`),
      getJson(`data/forward-shelf.json${q}`),
      getJson(`data/external/peers/latest.json${q}`),
    ]);
  const ok = (s) => (s.status === "fulfilled" ? s.value : null);
  const regime = ok(regimeS);
  const arsenal =
    arsenalFromSnapshot(ok(snapS)) || ok(arsenalFileS);
  const cot = ok(cotLiveS) || ok(cotFileS);
  const fear = ok(fearLiveS)?.score != null ? ok(fearLiveS) : ok(fearFileS);
  const houseRows = houseLatest(ok(houseS) || "");
  renderLog($("log"), ok(logS), ok(shelfS));
  renderMix($("mix"), arsenal, regime);
  renderSix($("six"), regime, cot, houseRows, arsenal, fear);
  renderPeers($("peers"), ok(peersS), regime);
  renderMood($("mood"), fear, regime);
  renderCot($("cot"), cot);
}

loadAll().catch((e) => {
  const mix = $("mix");
  if (mix) mix.innerHTML = empty(String(e.message || e));
});
