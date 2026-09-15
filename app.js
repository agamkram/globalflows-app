/** GlobalFlows UI — reads snapshot.json + regime-today.json bake */

import { buildMeaning } from "./meaning.js?v=20261227";
import {
  buildLights,
  attachImpulse,
  memberAnchorScore,
  seriesFacts,
  applyRealRateAnchors,
  distanceToCliff,
  clubLight,
  tallyVotes,
  lightStateFromScore,
  VOTE_FAMILIES,
  familyIds,
  DEFAULT_IMPULSE,
  TABLE_IMPULSE,
  IMPULSE_KEYS,
  sliceLookback,
} from "./score.js?v=20261227";
import { LIGHT_IDS, chipWord, lightSheet, inflationTurn } from "./light-copy.js?v=20261227";

const $ = (sel, el = document) => el.querySelector(sel);

/**
 * iOS scrolls under dialogs unless body is position:fixed. That unsticks the
 * pin, so the sheet must be measured first and the pin translated back into
 * the clear band above the dim.
 */
let scrollLockY = 0;
/** Which row the open tap-sheet sits under: the five, or the six. */
let sheetAnchor = "lights";
/** Frozen viewport Y while a sheet is open — sticky is gone after lock. */
let sheetTopPx = 8;
let sheetFrozen = false;

function sheetAnchorEl() {
  return sheetAnchor === "favor" ? $("#favorStrip") : $("#lights");
}

function applySheetTop(top) {
  sheetTopPx = top;
  document.documentElement.style.setProperty("--sheet-top", `${top}px`);
}

function measureSheetTop(which) {
  if (which) sheetAnchor = which;
  const el = sheetAnchorEl();
  const gap = 6;
  const bottom = el && !el.hidden ? el.getBoundingClientRect().bottom : 0;
  return Math.max(8, Math.ceil(bottom + gap));
}

function placeSheetBelow(which, { force = false } = {}) {
  if (which) sheetAnchor = which;
  if (sheetFrozen && !force) {
    applySheetTop(sheetTopPx);
    return sheetTopPx;
  }
  applySheetTop(measureSheetTop(which));
  return sheetTopPx;
}

/** Keep the sticky pin visible through the clear backdrop band after lock. */
function pinChromeWhileOpen() {
  const pin = $("#pinStack");
  if (!pin) return;
  pin.style.transform = "";
  const top = pin.getBoundingClientRect().top;
  if (Math.abs(top) > 0.5) pin.style.transform = `translateY(${-top}px)`;
}

function unpinChrome() {
  const pin = $("#pinStack");
  if (pin) pin.style.transform = "";
}

function lockPageScroll() {
  if (document.body.classList.contains("dlg-open")) return;
  scrollLockY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.classList.add("dlg-open");
  document.body.style.top = `-${scrollLockY}px`;
  sheetFrozen = true;
  pinChromeWhileOpen();
}

function unlockPageScroll() {
  if ([...document.querySelectorAll("dialog.dlg-tap")].some((d) => d.open)) return;
  sheetFrozen = false;
  unpinChrome();
  document.body.classList.remove("dlg-open");
  document.body.style.top = "";
  window.scrollTo(0, scrollLockY);
}

/** Measure under the stuck pin, then open — never remasure after lock. */
function openTapDialog(dlg, anchor) {
  placeSheetBelow(anchor, { force: true });
  if (!dlg.open) dlg.showModal();
  lockPageScroll();
  applySheetTop(sheetTopPx);
  requestAnimationFrame(() => {
    pinChromeWhileOpen();
    applySheetTop(sheetTopPx);
  });
}

let SNAP = null;
/** Daily regime bake (spot-on components + teach). Null if missing. */
let REGIME = null;

/** Global row view: values | charts. */
let globalView = "values";
/** Table heat and spark length only. Default 3m. Chevrons, duration, credit, and the six classes stay on the 1m turn. */
let statHorizon = TABLE_IMPULSE;
/** Markets sub-shelf when on Markets tab — unused; shelves are titled rows. */
let marketBucket = "all";
/** Last prints overlaid on Markets Latest (z stays daily). */
let liveQuotes = {};
let livePulledAt = null;
let liveState = "idle";
let liveInflight = null;
/** id → spark points with live last bar patched in. */
const sparkLive = {};
/**
 * Compare flow:
 *   off  — normal book; saved m1–m3 sit left of Compare
 *   pick — choose up to 10, then Go
 *   view — club; tap m to save into next free slot (m becomes m# here, then stays on streets)
 */
let comparePhase = "off";
/** Ids in the working club (pick + view), in pick order. Not remembered across reload. */
let compareList = [];
/** Which saved slot is open in view (for Delete). Null if unsaved Go club. */
let compareActiveSlot = null;
/** In club after a save this visit — temp label on the m button (m1/m2/m3). */
let clubSavedAs = null;
/** Saved clubs m1/m2/m3 — only these persist. */
const COMPARE_SLOTS = ["m1", "m2", "m3"];
const COMPARE_STORE_VER = "2"; // bump to wipe leftover slots from older compare UX
const compareSaves = { m1: [], m2: [], m3: [] };
try {
  if (localStorage.getItem("gf-compare-ver") !== COMPARE_STORE_VER) {
    for (const slot of COMPARE_SLOTS) localStorage.removeItem(`gf-compare-${slot}`);
    localStorage.setItem("gf-compare-ver", COMPARE_STORE_VER);
  }
  for (const slot of COMPARE_SLOTS) {
    const raw = JSON.parse(localStorage.getItem(`gf-compare-${slot}`) || "[]");
    if (Array.isArray(raw) && raw.length) {
      compareSaves[slot] = raw.filter((id) => typeof id === "string").slice(0, 10);
    }
  }
} catch (_) {
  /* ignore */
}

const MARKET_BUCKETS = [
  { id: "duration", label: "Duration" },
  { id: "credit", label: "Credit" },
  { id: "equities", label: "Equities" },
  { id: "crypto", label: "Crypto" },
  { id: "metals", label: "Metals" },
  { id: "energy", label: "Energy" },
  { id: "ag", label: "Ag" },
];
const MARKET_BUCKET_ORDER = MARKET_BUCKETS.map((b) => b.id);
const MARKET_BUCKET_LABEL = Object.fromEntries(
  MARKET_BUCKETS.map((b) => [b.id, b.label])
);

function sectionLabel(kind, id, snap) {
  if (kind === "bucket") return MARKET_BUCKET_LABEL[id] || id;
  return (
    snap?.lights?.[id]?.label ||
    (snap?.layers || []).find((l) => l.id === id)?.label ||
    id
  );
}

function sectionRow(kind, id, snap) {
  const label = escapeHtml(sectionLabel(kind, id, snap));
  const attr =
    kind === "bucket"
      ? ` data-bucket="${escapeHtml(id)}"`
      : ` data-street="${escapeHtml(id)}"`;
  return `<tr class="heat-section"${attr} aria-hidden="true">
    <td colspan="2"><span class="heat-section-label">${label}</span></td>
  </tr>`;
}

const COMPARE_MAX = 10;

/** Series ids flipped from the global view (tap a row’s data/chart cell). */
const rowFlip = new Set();
const histCache = new Map();
const COLSPAN_DATA = 1;

function chartDuration() {
  return statHorizon;
}

function impulseOf(s, h = statHorizon) {
  return s?.impulse?.[h] || { dir: null, delta: null, score: null };
}


function viewOf(snap) {
  if (!snap) return null;
  if (snap.lightDist) {
    // score.js setLightDist via buildLights
  }
  const lights = buildLights(snap);
  attachImpulse(lights, snap, DEFAULT_IMPULSE);
  return {
    ...snap,
    lights,
    disagreements: buildDisagreements(snap, lights),
  };
}

function fmtAsOf(d) {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return d;
  return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
}

/** Search key for detail — not shown in table rows (keeps rows single-line). */
function liveQuote(s) {
  const q = s && liveQuotes[s.id];
  if (!q || !Number.isFinite(q.price)) return null;
  return q;
}

function fmtLiveAge(pulledAt) {
  if (liveState === "loading" && !pulledAt) return "…";
  if (!pulledAt) return liveState === "err" ? "—" : "";
  const sec = Math.max(0, Math.round((Date.now() - pulledAt) / 1000));
  if (sec < 45) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function syncMarketsLiveUi() {
  const cluster = $("#marketsLive");
  const show = comparePhase === "off" && (livePulledAt || liveState === "loading");
  if (cluster) cluster.hidden = !show;
  const age = $("#marketsAge");
  if (age) {
    age.textContent = show ? fmtLiveAge(livePulledAt) : "";
  }
  const refresh = $("#btnMarketsLive");
  if (refresh) {
    refresh.disabled = liveState === "loading";
    refresh.classList.toggle("is-loading", liveState === "loading");
  }
}

function specFromRow(s) {
  return {
    id: s.id,
    freq: s.freq,
    sign: s.sign ?? 0,
    light: s.light,
    weight: s.weight || 1,
    units: s.units,
  };
}

function patchSparkLast(id, price, asOf) {
  const pts = sparkLive[id];
  if (!pts?.length || price == null || !asOf) return;
  const last = pts[pts.length - 1];
  if (last.date === asOf) last.value = price;
  else if (asOf > last.date) pts.push({ date: asOf, value: price });
  histCache.delete(id);
}

async function applyLiveQuotes(quotes) {
  if (!SNAP?.series || !quotes) return;
  const all = await loadSparkBundle();
  for (const [id, q] of Object.entries(quotes)) {
    if (!q || !Number.isFinite(q.price)) continue;
    const s = SNAP.series[id];
    if (!s || s.status !== "ok") continue;
    if (!sparkLive[id] && all?.[id]) {
      sparkLive[id] = all[id].map((pt) => ({ ...pt }));
    }
    const asOf = q.asOf || s.asOf;
    s.latest = q.price;
    if (asOf) s.asOf = asOf;
    s.freshness = "live";
    patchSparkLast(id, q.price, asOf);
    const pts = sparkLive[id];
    if (pts?.length >= 2) {
      const facts = seriesFacts(pts, specFromRow(s));
      s.anchor = facts.anchor;
      s.impulse = facts.impulse;
      s.n = facts.n;
    }
  }
  applyRealRateAnchors(SNAP.series);
}

function pullMarketsLive(force = false) {
  if (liveInflight) return liveInflight;
  liveState = "loading";
  syncMarketsLiveUi();
  liveInflight = (async () => {
    try {
      const res = await fetch(
        `./api/markets-live${force ? "?fresh=1" : ""}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`live ${res.status}`);
      const data = await res.json();
      liveQuotes = data.quotes || {};
      const t = Date.parse(data.pulledAt);
      livePulledAt = Number.isFinite(t) ? t : Date.now();
      liveState = "ok";
      if (force) await applyLiveQuotes(liveQuotes);
      if (SNAP) {
        if (force) {
          refreshViews();
          if (globalView === "charts" || [...rowFlip].length) paintSparks();
        } else {
          renderTable(viewOf(SNAP));
          syncMarketsLiveUi();
        }
      } else syncMarketsLiveUi();
    } catch (_) {
      liveState = livePulledAt ? "ok" : "err";
      syncMarketsLiveUi();
    } finally {
      liveInflight = null;
    }
  })();
  return liveInflight;
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function signedScore(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : s;
}

function wordOfScore(lid, score) {
  return chipWord(lid, score);
}

/**
 * Render a stock of money already denominated in billions. FRED publishes most
 * balance-sheet series in millions, so the raw print has to be scaled by its own
 * unit before it is scaled for display — otherwise a $6.7tn balance sheet reads
 * as "6.74M".
 */
function money(bn, symbol = "$") {
  const abs = Math.abs(bn);
  const sign = bn < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}${symbol}${(abs / 1000).toFixed(2)}tn`;
  if (abs >= 1) return `${sign}${symbol}${abs.toFixed(abs >= 100 ? 0 : 1)}bn`;
  return `${sign}${symbol}${(abs * 1000).toFixed(0)}mn`;
}

/** Live or baked FX print for converting CB balance sheets to dollars. */
function fxPrint(id) {
  const live = liveQuotes[id];
  if (live && Number.isFinite(live.price) && live.price > 0) return live.price;
  const s = SNAP?.series?.[id];
  const p = s?.latest;
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** Native money print plus a dollar equivalent when the FX tape is available. */
function moneyNativeAndUsd(nativeText, usdBn) {
  if (usdBn == null || !Number.isFinite(usdBn)) return nativeText;
  return `${nativeText}  (~${money(usdBn)})`;
}

/** Format a print in the units the catalog says it is actually denominated in. */
function fmtValue(n, units) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const signed = (d) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
  switch (units) {
    case "USD mn":
      return money(n / 1000);
    case "USD bn":
      return money(n);
    case "USD tn":
      return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}tn`;
    // A 12-month change is meaningless without its sign, and "3%" reads as growth
    // when the series is actually shrinking.
    case "% chg":
      return `${signed(abs >= 10 ? 1 : 2)}%`;
    case "EUR mn": {
      const native = money(n / 1000, "€");
      const eurusd = fxPrint("EURUSD");
      return moneyNativeAndUsd(native, eurusd != null ? (n / 1000) * eurusd : null);
    }
    // Bank of Japan reports in hundred-millions of yen.
    case "¥100m": {
      const native = money(n / 10, "¥");
      const usdjpy = fxPrint("USDJPY");
      // n × ¥100m = yen; ÷ USDJPY = dollars.
      return moneyNativeAndUsd(
        native,
        usdjpy != null ? (n * 1e8) / usdjpy / 1e9 : null
      );
    }
    case "%":
    case "% YoY":
    case "% of GDP":
    case "rate":
      return `${n.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)}%`;
    case "bp":
      return `${signed(0)}bp`;
    case "pp":
      return `${signed(1)}pp`;
    case "change":
    case "k change":
      return `${signed(0)}k`;
    case "k":
      return `${fmt(n, 0)}k`;
    case "n":
    case "number":
      return fmt(n, 0);
    case "USD":
      return `$${fmt(n, abs >= 1000 ? 0 : 2)}`;
    case "USD/bbl":
    case "USD/gal":
    case "USD/lb":
    case "USD/mmBtu":
    case "USD/oz":
    case "USD/hr":
      return `$${fmt(n, 2)}`;
    case "EUR/MWh":
      return `€${fmt(n, 2)}`;
    case "¢/bu":
      return `${fmt(n, 0)}¢`;
    // FX crosses need four places when the rate is near parity and two when it is
    // quoted in the hundreds, so USDJPY does not print as 147.2500.
    case "FX":
      return n.toFixed(abs >= 50 ? 2 : 4);
    default:
      return fmt(n, 2);
  }
}

function windowDelta(points) {
  if (!points || points.length < 2) return null;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last, delta: last - first };
}

function moneyDelta(bn, symbol = "$") {
  const abs = Math.abs(bn);
  const sign = bn < 0 ? "-" : "+";
  if (abs >= 1000) return `${sign}${symbol}${(abs / 1000).toFixed(2)}tn`;
  if (abs >= 1) return `${sign}${symbol}${abs.toFixed(abs >= 100 ? 0 : 1)}bn`;
  return `${sign}${symbol}${(abs * 1000).toFixed(0)}mn`;
}

function isRateUnit(units) {
  return (
    units === "%" ||
    units === "% YoY" ||
    units === "% of GDP" ||
    units === "% chg" ||
    units === "pp" ||
    units === "rate" ||
    units === "bp"
  );
}

/** Chart-window change in units a reader can trust. Rates get points, not % of %. */
function fmtWindowChange(points, units) {
  const w = windowDelta(points);
  if (!w) return { text: "—", dir: null };
  const { first, last, delta } = w;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  if (units === "bp") {
    return { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}bp`, dir };
  }
  if (isRateUnit(units)) {
    const abs = Math.abs(delta);
    const dig = abs >= 10 ? 1 : 2;
    return { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(dig)}pp`, dir };
  }
  if (
    (units === "USD mn" ||
      units === "USD bn" ||
      units === "USD tn" ||
      units === "EUR mn" ||
      units === "¥100m") &&
    (first < 0 || last < 0 || units === "EUR mn" || units === "¥100m")
  ) {
    const bn =
      units === "USD mn" || units === "EUR mn"
        ? delta / 1000
        : units === "¥100m"
          ? delta / 10
          : units === "USD tn"
            ? delta * 1000
            : delta;
    const symbol = units === "EUR mn" ? "€" : units === "¥100m" ? "¥" : "$";
    let text = moneyDelta(bn, symbol);
    if (units === "EUR mn") {
      const eurusd = fxPrint("EURUSD");
      if (eurusd != null) text = moneyNativeAndUsd(text, (delta / 1000) * eurusd);
    } else if (units === "¥100m") {
      const usdjpy = fxPrint("USDJPY");
      if (usdjpy != null) text = moneyNativeAndUsd(text, (delta * 1e8) / usdjpy / 1e9);
    }
    return { text, dir };
  }
  if (units === "change" || units === "k change" || units === "k") {
    return { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}k`, dir };
  }
  if (first === 0) return { text: "—", dir: null };
  const pct = (delta / Math.abs(first)) * 100;
  const abs = Math.abs(pct);
  const dig = abs >= 100 ? 0 : 1;
  return {
    text: `${pct >= 0 ? "+" : ""}${pct.toFixed(dig)}%`,
    dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat",
  };
}

function fmtChg(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const dig = abs >= 100 ? 0 : 1;
  return `${n >= 0 ? "+" : ""}${n.toFixed(dig)}%`;
}



function wordFor(light) {
  if (!light || light.state === "empty") return "—";
  if (light.score != null && Number.isFinite(light.score)) return chipWord(light.id, light.score);
  return light.word || light.words?.[light.state] || light.state;
}

/** Fallback only — the tap normally shows the live story from light-copy.js. Keep
 *  the rosters here matching the catalog, or this quietly names the wrong voters. */
const LIGHT_BLURB = {
  liquidity:
    "Cause — is cash entering or leaving the system? Tightening = draining; easing = cash returning. Voters are reserves and net liquidity versus GDP, the funding spread, commercial paper, and G4 balance-sheet growth with the dollar’s 12-month change.",
  rates:
    "Borrowing costs — real yields (5y and 10y TIPS, the 2-year against core PCE), mortgages, global 10ys, and the curve. Easy = cheap to fund; tight = expensive. MOVE (bond vol) only votes when it spikes; calm does not ease Rates or the turn.",
  growth:
    "Real activity — labor (jobs, claims), output (GDP and the weekly/monthly composites), a leading sleeve (permits, starts, durable orders, openings), and regional Fed factory surveys. When the surveys are at the rail while jobs and GDP are still Mid, they slide the needle and the tap flags early — not confirmed; alone they cannot flip Strong or Soft. Strong = holding up; soft = cooling. Separate from inflation.",
  inflation:
    "Underlying prices — realized core (CPI and PCE) at double weight, persistence (sticky CPI, wages, final-demand PPI), and 5y5y expectations. Hot = pressure up; cold = fading. Headlines can disagree; that shows as a flag.",
  risk:
    "Market fear — vol, credit spreads, financial conditions. Risk-on = fear is cheap; Risk-off = fear is expensive. Often last to move.",
};

/** Which component is selected (accent border). Null = none — All scroll-spy owns the ring. */
let focusLight = null;
/** Last component named on the details chip — stays up on All / FX / Markets. */
let hintLight = null;

/** Street shelf when a light is focused — lights own these; tabs keep All / FX / Markets. */
const LIGHT_TO_TAB = {
  liquidity: "liquidity",
  rates: "rates",
  growth: "growth",
  inflation: "inflation",
  risk: "risk",
};

/** Inverse: street layer → light (for All scroll-spy). */
const TAB_TO_LIGHT = {
  liquidity: "liquidity",
  rates: "rates",
  growth: "growth",
  inflation: "inflation",
  risk: "risk",
};

/** Tabs with no matching light (All / FX / Markets). */
const STREET_TABS = new Set(["all", "fx", "markets"]);

let activeLayer = "all";
/** All-view scroll spy: which street section is in view (layer id). */
let scrollStreet = null;
/** Markets All: which bucket section is in view. */
let scrollBucket = null;
/** Freeze the spy ring while The book auto-scrolls to a shelf. */
let spyLocked = false;
let spyLockStreet = null;
let spyUnlockTimer = 0;
/** Bumps when a new jump starts so a prior scrollend cannot unlock early. */
let spyScrollGen = 0;

function bakeLight(id) {
  return REGIME?.lights?.[id] || null;
}

/** Current vote and story for a component — follows last prints, not the morning file. */
function liveSheet(id, snap = SNAP) {
  if (!snap || !id) return null;
  const c = clubLight(snap, id);
  return lightSheet(id, {
    ...c,
    cliff: distanceToCliff(c.score),
    impulse: snap.lights?.[id]?.impulse,
  });
}

function morningWord(id) {
  return bakeLight(id)?.word || null;
}

function stanceState(stance) {
  if (stance === "in") return "easing";
  if (stance === "out") return "tight";
  return "neutral";
}

function trackPct(score) {
  const n = Number(score);
  const s = Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  return Math.max(4, Math.min(96, ((s + 1) / 2) * 100));
}

function fmtLightScore(n) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

/**
 * First open: needles and scores travel from center. The word is blank until
 * they stop — blank is not Mid. Once only; later paints must not replay it.
 */
let settlePhase = "pending";
let settleDirty = false;
const SETTLE_MS = 1100;

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function settleMarksAndScores() {
  const lights = $("#lights");
  const favor = $("#favorStrip");
  const marks = [
    ...(lights?.querySelectorAll(".track-mark") || []),
    ...(favor?.querySelectorAll(".track-mark") || []),
  ];
  const scores = [...(lights?.querySelectorAll(".score[data-target]") || [])];
  return { marks, scores };
}

function parkSettleStart(root) {
  if (!root || settlePhase !== "pending") return;
  document.documentElement.classList.add("gf-open-settle");
  for (const m of root.querySelectorAll(".track-mark")) m.style.left = "50%";
  for (const s of root.querySelectorAll(".score[data-target]")) {
    s.textContent = fmtLightScore(0);
  }
}

function afterOpenSettle() {
  // Table 3m/6m and last prints only. Do not rebuild the five or the six —
  // that was the extra crypto jump after they had already stopped.
  hydrateImpulseFromSparks().then(() => {
    if (SNAP) renderTable(viewOf(SNAP));
  });
  pullMarketsLive();
}

function startOpenSettle() {
  if (settlePhase !== "pending") return;
  const { marks, scores } = settleMarksAndScores();
  if (!marks.length) {
    settlePhase = "done";
    afterOpenSettle();
    return;
  }
  settlePhase = "playing";
  document.documentElement.classList.add("gf-open-settle");

  const from = 50;
  const markTo = marks.map((m) => {
    const n = parseFloat(m.getAttribute("data-to") || m.style.left);
    return Number.isFinite(n) ? n : from;
  });
  const scoreTo = scores.map((s) => Number(s.dataset.target));
  for (const m of marks) m.style.left = `${from}%`;
  for (let i = 0; i < scores.length; i++) {
    if (Number.isFinite(scoreTo[i])) scores[i].textContent = fmtLightScore(0);
  }

  let kicked = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].isConnected) marks[i].style.left = `${markTo[i]}%`;
    }
    for (let i = 0; i < scores.length; i++) {
      if (Number.isFinite(scoreTo[i])) {
        scores[i].textContent = fmtLightScore(scoreTo[i]);
      }
    }
    document.documentElement.classList.add("gf-open-arrive");
    document.documentElement.classList.remove("gf-open-run");
    settlePhase = "arriving";
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("gf-open-settle");
      window.setTimeout(() => {
        document.documentElement.classList.remove("gf-open-arrive");
        settlePhase = "done";
        afterOpenSettle();
      }, 200);
    });
  };
  const kick = () => {
    if (kicked) return;
    kicked = true;
    document.documentElement.classList.add("gf-open-run");
    void document.documentElement.offsetHeight;
    for (let i = 0; i < marks.length; i++) {
      marks[i].style.left = `${markTo[i]}%`;
    }
    let t0 = null;
    const tick = (now) => {
      if (finished) return;
      if (t0 == null) t0 = now;
      const t = Math.min(1, (now - t0) / SETTLE_MS);
      const e = easeOutCubic(t);
      for (let i = 0; i < scores.length; i++) {
        if (!Number.isFinite(scoreTo[i])) continue;
        scores[i].textContent = fmtLightScore(scoreTo[i] * e);
      }
      if (t < 1) requestAnimationFrame(tick);
      else finish();
    };
    requestAnimationFrame(tick);
    window.setTimeout(finish, SETTLE_MS + 80);
  };
  // Hold center on screen, then travel. Timeout not rAF: iOS may withhold
  // frames until sparks/live finish, which used to skip the whole move.
  window.setTimeout(kick, 140);
}

function lightIsSplit(snap, id) {
  const kinds = (snap?.disagreements || []).map((d) => d.kind);
  if (id === "inflation" && kinds.some((k) => String(k).startsWith("inflation_"))) return true;
  const voters = liveSheet(id, snap)?.voters;
  if (!voters?.length) return false;
  return voters.some((v) => v.score > 0.45) && voters.some((v) => v.score < -0.45);
}

/**
 * Gauge rail. The five tick 0 and ±0.45 on a ±1 rail (the number can still
 * run to ±1.5). The six only mark center — in/out is the colour, not a colour line.
 */
function trackHtml(score, state, { size = "", cuts = "light" } = {}) {
  const pct = trackPct(score).toFixed(1);
  const cls = size ? `track track-${size}` : "track";
  const ticks =
    cuts === "favor"
      ? `<i class="track-mid"></i>`
      : `<i class="track-cut track-cut-lo"></i><i class="track-mid"></i><i class="track-cut track-cut-hi"></i>`;
  return `<span class="${cls}" data-state="${escapeHtml(
    state || "neutral"
  )}" aria-hidden="true"><span class="track-rail">${ticks}<i class="track-mark" style="left:${pct}%" data-to="${pct}"></i></span></span>`;
}

/** Parent-class proxies. Credit / commodities judged on their splits. */
const FAVOR_ASSET = {
  treasuries: "UST10",
  credit: null,
  stocks: "SPX",
  crypto: "BTC",
  gold: "GOLD",
  cmdty: null,
};

/** Curve / credit / equity / commodity splits — 5s/10s/30s are synthetic UST. */
const FAVOR_CHILD_ASSET = {
  5: "UST5",
  10: "UST10",
  30: "UST30",
  ig: "LQD",
  hy: "HYG",
  cyc: "XLY",
  def: "XLP",
  oil: "WTI",
  copper: "COPPER",
};

/**
 * How far hit rate “vs normally” must move before history leans.
 * Short windows are noisier — a tiny lift must not wear a star.
 */
function analogLiftBar(hz) {
  if (hz === "1w") return 15;
  if (hz === "2w") return 12;
  return 8;
}

/**
 * How far the median return “vs normally” must move (percentage points).
 * Hit rate alone can lean on a +0.1% win — size has to clear this too.
 */
function analogMedianBar(hz) {
  if (hz === "1w") return 0.3;
  if (hz === "2w") return 0.5;
  return 0.8;
}

/**
 * How the record lines up with a call. The interesting case is disagreement: it
 * says the read depends on this cycle differing from the ones behind it, which is
 * worth knowing before you act on it.
 *
 * Both how-often (hit rate vs normally) and how-much (median vs normally) must
 * point the same way. One without the other is no lean.
 */
function analogFor(assetId, stance) {
  const a = REGIME?.analogs;
  if (!a?.stats || !assetId) return null;
  const hz = DEFAULT_IMPULSE;
  const r = a.stats[hz]?.[assetId];
  if (!r) return null;

  const base = a.baseline?.[hz]?.[assetId] || null;
  const lift = base ? r.up - base.up : 0;
  const medLift =
    base && Number.isFinite(base.median) ? r.median - base.median : r.median;
  const freqLean =
    lift >= analogLiftBar(hz) ? "up" : lift <= -analogLiftBar(hz) ? "down" : "flat";
  const sizeLean =
    medLift >= analogMedianBar(hz)
      ? "up"
      : medLift <= -analogMedianBar(hz)
        ? "down"
        : "flat";
  const lean =
    freqLean !== "flat" && freqLean === sizeLean ? freqLean : "flat";
  // A mixed call has nothing to agree or disagree with, so report which way the
  // record leans instead of calling the history split when it plainly is not.
  let verdict = "leans";
  if (lean === "flat") verdict = "coinflip";
  else if (stance === "in") verdict = lean === "up" ? "agrees" : "disagrees";
  else if (stance === "out") verdict = lean === "down" ? "agrees" : "disagrees";
  // Distant or loose: context, not a verdict. Only a close match can flag the strip.
  return {
    ...r,
    hz,
    stance,
    lean,
    verdict,
    weak: a.closeness !== "close",
    baseUp: base?.up,
    baseMedian: base?.median,
    lift,
    medLift,
  };
}

function favorBaseRate(favorId, stance) {
  return analogFor(FAVOR_ASSET[favorId], stance);
}

function childAnalog(child) {
  return analogFor(FAVOR_CHILD_ASSET[child?.id], child?.stance);
}

function itemClash(it) {
  const checks = [];
  const parent = favorBaseRate(it.id, it.stance);
  if (parent) checks.push(parent);
  for (const tn of it.tenors || []) checks.push(childAnalog(tn));
  for (const sp of it.splits || []) checks.push(childAnalog(sp));
  return checks.some((br) => br?.verdict === "disagrees" && !br.weak);
}

function renderFavorStrip() {
  const el = $("#favorStrip");
  if (!el || !SNAP) return;
  if (settlePhase === "playing" || settlePhase === "arriving") {
    settleDirty = true;
    return;
  }
  try {
    const snap = viewOf(SNAP);
    const favor = buildMeaning(snap, DEFAULT_IMPULSE).favor;
    if (!favor?.items?.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    const so = String(favor.stripLine || "").trim();
    el.setAttribute(
      "aria-label",
      so
        ? `In and out of favor. ${so}. Tap a class for why.`
        : "In and out of favor. Tap a class for why."
    );
    const kicker = so
      ? `<p class="favor-so" title="${escapeHtml(so)}">${escapeHtml(so)}</p>`
      : "";
    el.innerHTML =
      kicker +
      favor.items
        .map((it) => {
        const st = stanceState(it.stance);
        const title = it.name;
        const word = it.stance === "in" ? "in" : it.stance === "out" ? "out" : "mixed";
        // Star the cell if any judged proxy disagrees — 5s/10s/30s vs synthetic
        // UST, investment grade vs LQD, high yield vs HYG — not only the parent.
        const clash = itemClash(it);
        const clashAttr = clash
          ? ` data-clash="true" title="History disagrees with this call"`
          : "";
        const aria = `aria-label="${escapeHtml(title)}, ${word}${
          clash ? ", history disagrees" : ""
        }. Tap for why."`;
        const titleHtml = escapeHtml(title);
        // Treasuries: 5 cash / 10 / 30 duration. Credit: IG / HY. No averaged parent needle.
        const kids = it.tenors?.length ? it.tenors : it.splits?.length ? it.splits : null;
        if (kids) {
          return `<button type="button" class="favor-cell favor-ust" data-favor-id="${escapeHtml(
            it.id
          )}" data-state="${st}" ${aria}${clashAttr}>
            <span class="favor-title">${titleHtml}</span>
            <span class="favor-curve">${kids
              .map(
                (kid) =>
                  `<span class="favor-tenor" data-state="${stanceState(kid.stance)}"><b>${escapeHtml(
                    kid.name
                  )}</b>${trackHtml(kid.margin, stanceState(kid.stance), {
                    size: "xs",
                    cuts: "favor",
                  })}</span>`
              )
              .join("")}</span>
          </button>`;
        }
        return `<button type="button" class="favor-cell favor-ust" data-favor-id="${escapeHtml(
          it.id
        )}" data-state="${st}" ${aria}${clashAttr}>
          <span class="favor-title">${titleHtml}</span>
          <span class="favor-curve">
            <span class="favor-tenor favor-spot-needle" data-state="${st}">${trackHtml(
              it.margin,
              st,
              { size: "xs", cuts: "favor" }
            )}</span>
          </span>
        </button>`;
      })
      .join("");
    parkSettleStart(el);
  } catch (err) {
    console.warn("renderFavorStrip failed", err);
  }
}

function lockScrollSpy(street) {
  spyLocked = true;
  spyLockStreet = street ?? null;
  scrollStreet = spyLockStreet;
  scrollBucket = null;
  clearTimeout(spyUnlockTimer);
  spyUnlockTimer = 0;
  applyScrollSpyUi();
}

function unlockScrollSpy() {
  if (!spyLocked) return;
  spyLocked = false;
  spyLockStreet = null;
  clearTimeout(spyUnlockTimer);
  spyUnlockTimer = 0;
  syncScrollSpy();
}

/** Hold the ring until smooth scroll settles (scrollend), with a timeout fallback. */
function afterProgrammaticScroll() {
  const gen = ++spyScrollGen;
  const finish = () => {
    if (gen !== spyScrollGen) return;
    window.removeEventListener("scrollend", finish);
    clearTimeout(spyUnlockTimer);
    spyUnlockTimer = 0;
    unlockScrollSpy();
  };
  window.addEventListener("scrollend", finish, { once: true });
  clearTimeout(spyUnlockTimer);
  spyUnlockTimer = setTimeout(finish, 1800);
}

function selectLight(id) {
  if (!SNAP || !id) return;
  const snap = viewOf(SNAP);
  if (!snap.lights?.[id]) {
    console.warn("selectLight: missing light", id);
    return;
  }
  const street = LIGHT_TO_TAB[id] || id;
  // Stay on The book and scroll to the shelf — do not truncate to that street alone.
  hintLight = id;
  focusLight = null;
  activeLayer = "all";
  scrollBucket = null;
  if (comparePhase !== "pick") {
    comparePhase = "off";
    compareList = [];
    compareActiveSlot = null;
    clubSavedAs = null;
  }
  lockScrollSpy(street);
  refreshViews();
  lockScrollSpy(street);
  scrollToStreetSection(street);
}

/** Chip, box, and table title follow the component only while you are on it. */
function clearLightFocus() {
  const streetWasLight = !STREET_TABS.has(activeLayer);
  if (!focusLight && !streetWasLight) {
    if (SNAP) syncComponentHint(viewOf(SNAP));
    return;
  }
  focusLight = null;
  if (streetWasLight) activeLayer = "all";
  refreshViews();
}

function scrollTableToTop() {
  lockScrollSpy(null);
  const se = document.scrollingElement || document.documentElement;
  se.scrollTop = 0;
  if (document.body) document.body.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: "smooth" });
  afterProgrammaticScroll();
  requestAnimationFrame(() => {
    if (!spyLocked) return;
    se.scrollTop = 0;
  });
}

/** Put a street’s titled row just under the pin (The book stays intact). */
function scrollToStreetSection(street) {
  if (!street) return;
  lockScrollSpy(street);
  const go = () => {
    const pin = $("#pinStack");
    const pinBottom = pin?.getBoundingClientRect().bottom ?? 0;
    const row =
      document.querySelector(
        `#heatBody tr.heat-section[data-street="${street}"]`
      ) || document.querySelector(`#heatBody tr[data-street="${street}"]`);
    if (!row) {
      unlockScrollSpy();
      return;
    }
    const y =
      window.scrollY + row.getBoundingClientRect().top - pinBottom - 2;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    lockScrollSpy(street);
    afterProgrammaticScroll();
  };
  // Two frames so the All book has laid out after refreshViews.
  requestAnimationFrame(() => requestAnimationFrame(go));
}

/** How related prints share a ballot — same names Math uses. */
const TAP_FAMILY = {
  liquidity: {
    fed: "Fed vs GDP",
    funding: "Funding cost",
    stress: "Commercial paper",
    global: "G4 and the dollar",
  },
  rates: {
    real: "Real yields",
    nominal: "Nominal yields",
    curve: "The curve",
    vol: "Bond vol",
  },
  growth: {
    coincident: "Labor and output",
    leading: "Leading prints",
    survey: "Factory surveys",
  },
  inflation: {
    realized: "Core prices",
    persistence: "Persistence",
    expected: "Expectations",
  },
  risk: {
    credit: "Credit spreads",
    vol: "Volatility",
  },
};

function familyWeightNote(w) {
  if (w === 0.5) return "half weight";
  if (w === 1.5) return "1.5× weight";
  if (w === 2) return "double weight";
  if (w && w !== 1) return `${w}× weight`;
  return "";
}

/**
 * Roster plus the two numbers: the rows together, then the score on the box.
 * The table already lists every series; this is the arithmetic, grouped the
 * way the votes actually combine.
 */
function tapMathHtml(id, snap) {
  const c = clubLight(snap, id);
  const voters = c?.voters || [];
  if (!voters.length) return "";
  const byId = Object.fromEntries(voters.map((v) => [v.id, v]));
  const { score: together, ballots } = tallyVotes(id, voters, { calibrate: false });
  const { score: onBox } = tallyVotes(id, voters, {
    calibrate: true,
    dist: snap.lightDist,
  });
  const families = VOTE_FAMILIES[id] || {};
  const used = new Set();
  const blocks = [];
  for (const [fname, spec] of Object.entries(families)) {
    const ids = familyIds(spec);
    const members = ids.map((vid) => byId[vid]).filter(Boolean);
    if (!members.length) continue;
    members.forEach((m) => used.add(m.id));
    const ballot = ballots.find((b) => b.id === `family:${fname}`);
    const wNote = familyWeightNote(ballot?.weight ?? 1);
    const famScore = ballot?.score;
    const label = TAP_FAMILY[id]?.[fname] || fname;
    blocks.push(`<div class="tap-fam">
      <div class="tap-fam-head">
        <span>${escapeHtml(label)}${wNote ? ` <span class="muted">${escapeHtml(wNote)}</span>` : ""}</span>
        <span class="tap-math-sc" data-state="${escapeHtml(lightStateFromScore(famScore).state)}">${signedScore(famScore)} ${escapeHtml(wordOfScore(id, famScore))}</span>
      </div>
      <ul>${members
        .map(
          (m) =>
            `<li><span>${escapeHtml(m.name)}</span><span class="tap-math-sc">${signedScore(m.score)}</span></li>`
        )
        .join("")}</ul>
    </div>`);
  }
  const leftovers = voters.filter((v) => !used.has(v.id));
  if (leftovers.length) {
    blocks.push(`<div class="tap-fam">
      <ul>${leftovers
        .map(
          (m) =>
            `<li><span>${escapeHtml(m.name)}</span><span class="tap-math-sc">${signedScore(m.score)}</span></li>`
        )
        .join("")}</ul>
    </div>`);
  }
  const wTogether = wordOfScore(id, together);
  const wBox = wordOfScore(id, onBox);
  const name = snap.lights?.[id]?.label || id;
  const scaleNote =
    wTogether === wBox
      ? `The rows already read ${wTogether}. We asked how unusual that is for ${name}’s own mix and matched it to the other four. The word stayed ${wTogether}.`
      : `The rows together read ${wTogether}. We asked how unusual that is for ${name}’s own mix, then matched the five so a word here means the same kind of unusual as the same word on the others. That stretch printed ${wBox}.`;
  const stress = ballots.filter(
    (b) => b.id === "family:funding" || b.id === "family:stress"
  );
  const worst = stress.reduce(
    (a, b) => (Number.isFinite(b.score) && (a == null || b.score < a) ? b.score : a),
    null
  );
  const stressNote =
    id === "liquidity" && worst != null && worst <= -0.5
      ? `<p class="muted tiny">Funding stress is holding Liquidity at least this tight — the other ballots cannot talk it back up.</p>`
      : "";
  return `<div class="tap-math">
    <p class="tap-math-kicker">How the number is made</p>
    ${blocks.join("")}
    <div class="tap-math-sum">
      <div>Rows together <span class="tap-math-sc" data-state="${escapeHtml(lightStateFromScore(together).state)}">${signedScore(together)} ${escapeHtml(wTogether)}</span></div>
      <div>On the box <span class="tap-math-sc" data-state="${escapeHtml(lightStateFromScore(onBox).state)}">${signedScore(onBox)} ${escapeHtml(wBox)}</span></div>
    </div>
    <p class="muted tiny">${escapeHtml(scaleNote)}</p>
    ${stressNote}
  </div>`;
}

function openLightSheet(id) {
  if (!SNAP || !id) return;
  $("#dlgSentence")?.close();
  const snap = viewOf(SNAP);
  const L = snap.lights?.[id];
  if (!L) {
    console.warn("openLightSheet: missing light", id, Object.keys(snap.lights || {}));
    return;
  }

  const sheet = liveSheet(id, snap);
  const word = sheet?.word || wordFor(L);
  const titleEl = $("#lightTitle");
  const bodyEl = $("#lightBody");
  const dlg = $("#dlgLight");
  if (!titleEl || !bodyEl || !dlg) {
    console.warn("openLightSheet: dialog nodes missing");
    return;
  }
  const inflTurn =
    id === "inflation" && L.state === "easing" ? inflationTurn(L.impulse?.dir) : "";
  titleEl.textContent = inflTurn
    ? `${L.label || id} · ${word}, ${inflTurn}`
    : `${L.label || id} · ${word}`;
  const teach = sheet?.teach
    ? `<p class="light-teach">${escapeHtml(sheet.teach)}</p>`
    : `<p>${escapeHtml(LIGHT_BLURB[id] || "")}</p>`;
  const morn = morningWord(id);
  const moved =
    morn && sheet?.word && morn !== sheet.word
      ? `<p class="muted tiny">Moved with the tape — this morning ${escapeHtml(morn)}.</p>`
      : "";
  bodyEl.innerHTML = `
    ${teach}
    ${moved}
    ${tapMathHtml(id, snap)}
  `;
  try {
    openTapDialog(dlg, "lights");
    if (SNAP) syncComponentHint(viewOf(SNAP));
  } catch (err) {
    console.warn("openLightSheet: showModal failed", err);
  }
}

function lightState(snap, id) {
  return snap.lights?.[id]?.state || "empty";
}

/** Tensions that belong on the teach sheet when not already baked into the story. */
const TEACH_TENSION_ORDER = ["liquidity_vs_gold", "liquidity_vs_btc", "inflation_pce_vs_5y5y"];

function hasDisagreement(snap, kind) {
  return (snap.disagreements || []).some((d) => d.kind === kind);
}

function disagreement(snap, kind) {
  return (snap.disagreements || []).find((d) => d.kind === kind) || null;
}

function buildDisagreements(snap, lights) {
  const liq = lights.liquidity;
  const risk = lights.risk;
  const growth = lights.growth;
  const infl = lights.inflation;
  const goldDir = impulseOf(snap.series?.GOLD, DEFAULT_IMPULSE).dir;
  const btcDir = impulseOf(snap.series?.BTC, DEFAULT_IMPULSE).dir;
  const headSc = snap.series?.CPIAUCSL?.anchor?.score;
  const coreSc = snap.series?.CPILFESL?.anchor?.score;
  const disagreements = [];
  if (liq?.state && goldDir) {
    if (liq.state === "easing" && goldDir === "down") {
      disagreements.push({ kind: "liquidity_vs_gold", text: "Liquidity easing, gold not confirming" });
    }
    if (liq.state === "tight" && goldDir === "up") {
      disagreements.push({ kind: "liquidity_vs_gold", text: "Liquidity tightening, gold firm anyway" });
    }
  }
  if (liq?.state && btcDir) {
    if (liq.state === "easing" && btcDir === "down") {
      disagreements.push({ kind: "liquidity_vs_btc", text: "Liquidity easing, BTC not confirming" });
    }
    if (liq.state === "tight" && btcDir === "up") {
      disagreements.push({ kind: "liquidity_vs_btc", text: "Liquidity tightening, BTC firm anyway" });
    }
  }
  if (liq?.state === "tight" && risk?.state === "easing") {
    disagreements.push({ kind: "liquidity_vs_risk", text: "Liquidity tightening, risk still on" });
  }
  if (liq?.state === "easing" && risk?.state === "tight") {
    disagreements.push({ kind: "liquidity_vs_risk", text: "Liquidity easing, risk still off" });
  }
  if (headSc != null && coreSc != null && headSc > 0.45 && coreSc < -0.45) {
    disagreements.push({ kind: "inflation_headline_vs_core", text: "Headline CPI hot, core cold" });
  } else if (headSc != null && coreSc != null && headSc < -0.45 && coreSc > 0.45) {
    disagreements.push({ kind: "inflation_headline_vs_core", text: "Headline CPI cold, core hot" });
  }
  if (growth?.state === "easing" && infl?.state === "tight") {
    disagreements.push({ kind: "growth_vs_inflation", text: "Growth strong, inflation cold" });
  }
  if (growth?.state === "tight" && infl?.state === "easing") {
    disagreements.push({ kind: "growth_vs_inflation", text: "Growth soft, inflation hot" });
  }
  const pceSc = snap.series?.PCEPILFE?.anchor?.score;
  const beiSc = snap.series?.T5YIFR?.anchor?.score;
  if (pceSc != null && beiSc != null && pceSc > 0.45 && beiSc <= 0.45 && beiSc >= -0.45) {
    disagreements.push({ kind: "inflation_pce_vs_5y5y", text: "Core PCE hot, 5y5y anchored" });
  } else if (pceSc != null && beiSc != null && pceSc > 0.45 && beiSc < -0.45) {
    disagreements.push({ kind: "inflation_pce_vs_5y5y", text: "Core PCE hot, 5y5y cold" });
  } else if (pceSc != null && beiSc != null && pceSc < -0.45 && beiSc > 0.45) {
    disagreements.push({ kind: "inflation_pce_vs_5y5y", text: "Core PCE cold, 5y5y hot" });
  }
  return disagreements;
}

function lightMemberScores(snap, lid) {
  const members = snap.lights?.[lid]?.members || [];
  return members
    .map((id) => {
      const m = snap.series?.[id];
      const score = memberAnchorScore(m);
      return m && score != null && Number.isFinite(score)
        ? { id, name: m.name, score, latest: m.latest, why: m.anchor?.why }
        : null;
    })
    .filter(Boolean);
}

/** Club is split when some voters clearly easy and some clearly tight. */
function clubSplit(snap, lid) {
  const scores = lightMemberScores(snap, lid);
  const easy = scores.filter((x) => x.score > 0.45);
  const tight = scores.filter((x) => x.score < -0.45);
  if (!easy.length || !tight.length) return null;
  return { easy, tight, scores };
}

function ratesClause(snap) {
  const st = lightState(snap, "rates");
  const split = clubSplit(snap, "rates");
  if (split) {
    const tightN = split.tight.slice(0, 2);
    const easyN = split.easy.slice(0, 2);
    const tight = tightN.map((x) => x.name).join(", ");
    const easy = easyN.map((x) => x.name).join(", ");
    const lookT = tightN.length === 1 ? "looks" : "look";
    const lookE = easyN.length === 1 ? "looks" : "look";
    return `Borrowing is <strong data-state="neutral">split</strong>: ${escapeHtml(
      tight
    )} ${lookT} expensive, while ${escapeHtml(easy)} ${lookE} easier`;
  }
  return {
    easing: `Borrowing costs look <strong data-state="easing">easy</strong>`,
    tight: `Borrowing costs look <strong data-state="tight">expensive</strong>`,
    neutral: `Borrowing costs look <strong data-state="neutral">mixed</strong>`,
    empty: "",
  }[st];
}

function horizonPhrase(h = DEFAULT_IMPULSE) {
  if (h === "1w") return "Over the past week";
  if (h === "2w") return "Over the past two weeks";
  if (h === "3m") return "Over the past three months";
  if (h === "6m") return "Over the past six months";
  return "Over the past month";
}

/**
 * Regime box: short editorial from light states + tensions.
 * Relations and splits — not a rewording of the five component words.
 * Leads with the 1m turn in plain language.
 */
function hotInflationTurn(snap) {
  return `, ${inflationTurn(snap.lights?.inflation?.impulse?.dir)}`;
}

function regimeStoryHtml(snap) {
  const liq = lightState(snap, "liquidity");
  const gr = lightState(snap, "growth");
  const inf = lightState(snap, "inflation");
  const risk = lightState(snap, "risk");
  const hotTurn = inf === "easing" ? hotInflationTurn(snap) : "";

  const cash = {
    easing: `<strong data-state="easing">cash has been flowing back</strong> into the system`,
    tight: `<strong data-state="tight">cash has been leaving</strong> the system`,
    neutral: `cash conditions have looked <strong data-state="neutral">steady</strong>`,
    empty: `cash conditions are unclear`,
  }[liq];

  const headCore = disagreement(snap, "inflation_headline_vs_core");
  const headHotCoreCold = headCore && /headline.*hot/i.test(headCore.text || "");
  const headColdCoreHot = headCore && /headline.*cold/i.test(headCore.text || "");

  let growthBit;
  if (gr === "easing" && inf === "tight") {
    growthBit = headHotCoreCold
      ? `the real growth has still looked <strong data-state="easing">firm</strong> and underlying inflation has <strong data-state="tight">cooled</strong> — even if the overall CPI print can look hotter`
      : `the real growth has still looked <strong data-state="easing">firm</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else if (gr === "easing" && inf === "easing") {
    growthBit = `the real growth has looked <strong data-state="easing">firm</strong> while inflation pressure is still <strong data-state="easing">high</strong>${hotTurn}`;
  } else if (gr === "easing" && inf === "neutral") {
    growthBit = `the real growth has still looked <strong data-state="easing">firm</strong> while inflation has looked <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "tight" && inf === "easing") {
    growthBit = headColdCoreHot
      ? `the real growth has looked <strong data-state="tight">soft</strong> while underlying inflation is still <strong data-state="easing">hot</strong>${hotTurn} — even if the overall CPI print looks cooler`
      : `the real growth has looked <strong data-state="tight">soft</strong> while inflation is still <strong data-state="easing">hot</strong>${hotTurn}`;
  } else if (gr === "tight" && inf === "tight") {
    growthBit = `the real growth has looked <strong data-state="tight">soft</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else if (gr === "tight" && inf === "neutral") {
    growthBit = `the real growth has looked <strong data-state="tight">soft</strong> while inflation has looked <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "neutral" && inf === "easing") {
    growthBit = `growth has looked <strong data-state="neutral">mixed</strong> while inflation is still <strong data-state="easing">hot</strong>${hotTurn}`;
  } else if (gr === "neutral" && inf === "tight") {
    growthBit = headHotCoreCold
      ? `growth has looked <strong data-state="neutral">mixed</strong> and underlying inflation has <strong data-state="tight">cooled</strong> — even if the overall CPI print can look hotter`
      : `growth has looked <strong data-state="neutral">mixed</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else {
    growthBit = `growth and inflation have both looked <strong data-state="neutral">mixed</strong>`;
  }

  const fear = {
    easing: `market <strong data-state="easing">fear has stayed low</strong>`,
    tight: `markets have been <strong data-state="tight">paying up for fear</strong>`,
    neutral: `market fear has looked <strong data-state="neutral">mixed</strong>`,
    empty: `market fear is unclear`,
  }[risk];

  const money = ratesClause(snap);

  const cashVsGrowth =
    (liq === "tight" && gr === "easing") || (liq === "easing" && gr === "tight");
  const cashVsFear =
    (liq === "tight" && risk === "easing") || (liq === "easing" && risk === "tight");

  let s1;
  if (cashVsGrowth && cashVsFear) {
    s1 = `${cash}, but ${growthBit} — and ${fear}`;
  } else if (cashVsGrowth) {
    s1 = `${cash}, but ${growthBit}`;
  } else if (cashVsFear) {
    s1 = `${cash}, but ${fear}`;
  } else {
    s1 = `${cash}, and ${growthBit}`;
  }

  const parts2 = [];
  if (!cashVsFear && fear) parts2.push(fear);
  if (money) parts2.push(money);
  const s2 = parts2.length
    ? ` ${parts2.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(". ")}.`
    : "";

  return `${horizonPhrase(DEFAULT_IMPULSE)}, ${s1}.${s2}`;
}


function fmtLightNum(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return fmt(n, digits);
}

/** Evidence beats for the teach sheet — why the paragraph, not a light glossary. */
function regimeEvidence(snap) {
  const beats = [];
  const liq = lightState(snap, "liquidity");
  const gr = lightState(snap, "growth");
  const inf = lightState(snap, "inflation");
  const risk = lightState(snap, "risk");
  const series = snap.series || {};

  if (liq === "tight") {
    beats.push(`Cash: net liquidity and related Fed balances are draining.`);
  } else if (liq === "easing") {
    beats.push(`Cash: net liquidity and related Fed balances are rising.`);
  } else if (liq === "neutral") {
    beats.push(`Cash: neither a clear drain nor a clear flood right now.`);
  }

  if (gr === "easing" && inf === "tight") {
    const core = series.CPILFESL;
    beats.push(
      core?.latest != null
        ? `Growth: activity still firm while underlying inflation cooled (core CPI YoY ${fmtLightNum(core.latest, 2)}%).`
        : `Growth: activity still firm while underlying inflation cooled.`
    );
  } else if (gr === "easing" && inf === "easing") {
    beats.push(`Growth: activity firm and underlying inflation still hot — both components lean the same way.`);
  } else if (gr === "tight" && inf === "easing") {
    beats.push(`Growth: activity soft while underlying inflation still hot — an ugly mix.`);
  } else if (gr === "tight" && inf === "tight") {
    beats.push(`Growth: activity soft and underlying inflation cooled.`);
  } else {
    beats.push(
      `Growth is ${wordFor(snap.lights?.growth).toLowerCase()}, inflation is ${wordFor(snap.lights?.inflation).toLowerCase()}.`
    );
  }

  if (hasDisagreement(snap, "inflation_headline_vs_core")) {
    const head = series.CPIAUCSL;
    const core = series.CPILFESL;
    const d = disagreement(snap, "inflation_headline_vs_core");
    if (/headline.*hot/i.test(d?.text || "")) {
      beats.push(
        `Prices split: overall CPI still looks hot versus ~2%; Inflation votes underlying/core.`
      );
    } else {
      beats.push(
        `Prices split: overall CPI looks cooler than underlying/core — Inflation follows the underlying.`
      );
    }
  }

  const vix = series.VIX;
  const hy = series.BAMLH0A0HYM2;
  if (risk === "easing") {
    beats.push(
      vix?.latest != null
        ? `Fear: vol and credit are quiet (VIX ${fmtLightNum(vix.latest, 1)}${hy?.latest != null ? `, high-yield OAS ${fmtLightNum(hy.latest, 2)}` : ""}).`
        : `Fear: vol and credit stress are quiet — fear is cheap.`
    );
  } else if (risk === "tight") {
    beats.push(`Fear: vol and/or credit spreads are elevated — markets are paying for protection.`);
  } else {
    beats.push(`Fear: gauges look mixed — not a clear risk-on or risk-off call.`);
  }

  if (liq === "tight" && risk === "easing") {
    beats.push(
      `Tension: cash is draining while fear stays low — don’t assume the tape agrees with the cash story.`
    );
  } else if (liq === "easing" && risk === "tight") {
    beats.push(
      `Tension: cash is easier while markets are still scared — the tape isn’t confirming.`
    );
  }

  const split = clubSplit(snap, "rates");
  if (split) {
    const tightN = split.tight.slice(0, 2);
    const easyN = split.easy.slice(0, 2);
    const tight = tightN.map((x) => x.name).join(", ");
    const easy = easyN.map((x) => x.name).join(", ");
    const lookT = tightN.length === 1 ? "looks" : "look";
    const lookE = easyN.length === 1 ? "looks" : "look";
    beats.push(`Borrowing split: ${tight} ${lookT} expensive, while ${easy} ${lookE} easier.`);
  } else {
    const st = lightState(snap, "rates");
    if (st === "easing") {
      beats.push(`Borrowing: real yields, mortgages, and global 10ys look easy overall.`);
    } else if (st === "tight") {
      beats.push(`Borrowing: real yields, mortgages, or global 10ys look expensive overall.`);
    } else if (st === "neutral") {
      beats.push(`Borrowing: no loud easy/tight call once the club is combined.`);
    }
  }

  return beats;
}

function teachOnlyTensions(snap) {
  const byKind = Object.fromEntries(
    (snap.disagreements || []).filter((d) => d?.kind).map((d) => [d.kind, d])
  );
  const out = [];
  for (const kind of TEACH_TENSION_ORDER) {
    if (byKind[kind]) out.push(byKind[kind]);
  }
  return out;
}

function tensionTeach(d) {
  switch (d.kind) {
    case "liquidity_vs_gold":
      return "Gold isn’t following the cash story — treat it as an output, not an input.";
    case "liquidity_vs_btc":
      return "Bitcoin isn’t following the cash story — treat it as an output, not an input.";
    case "inflation_pce_vs_5y5y":
      return "The Fed’s basket is still hot; the bond market is not — duration cares about both.";
    default:
      return d.text || "";
  }
}

function tensionTitle(d) {
  switch (d.kind) {
    case "liquidity_vs_gold":
      return "Gold isn’t confirming";
    case "liquidity_vs_btc":
      return "Bitcoin isn’t confirming";
    case "inflation_pce_vs_5y5y":
      return "PCE and 5y5y disagree";
    default:
      return (d.text || "").replace(/\.$/, "").trim();
  }
}

/**
 * What the market actually did after the days that most resembled today. Baked in
 * `scripts/analogs.mjs`; absent until the archive has been built, so the dialog
 * simply omits the section rather than showing an empty shell.
 */
function baseRateHtml() {
  const a = REGIME?.analogs;
  if (!a?.stats) return "";
  const hz = DEFAULT_IMPULSE;
  const table = a.stats[hz] || {};
  if (!Object.keys(table).length) {
    return `<p class="sent-kicker">What happened last time</p>
      <p class="muted tiny">No ${escapeHtml(hz)} analog yet — too few days like today have a full ${escapeHtml(hz)} of market returns after them.</p>`;
  }

  const window = {
    "1w": "the next week",
    "2w": "the next two weeks",
    "1m": "the next month",
    "3m": "the next three months",
    "6m": "the next six months",
  }[hz] || `the next ${hz}`;
  const match =
    a.closeness === "close"
      ? "a close match."
      : a.closeness === "loose"
        ? "a loose match."
        : "only a distant match, so read this as context rather than evidence.";

  const body = Object.entries(table)
    .map(([id, r]) => {
      const cls = r.median > 0 ? "z-pos" : r.median < 0 ? "z-neg" : "z-mid";
      const sign = r.median > 0 ? "+" : "";
      const baseUp = a.baseline?.[hz]?.[id]?.up;
      const vs = Number.isFinite(baseUp) ? ` vs ${baseUp}% normally` : "";
      return `<div class="base-row">
        <span class="base-name">${escapeHtml(r.name)}</span>
        <span class="base-med ${cls}">${sign}${r.median}%</span>
        <span class="base-up muted">${r.up}% up${vs}</span>
      </div>`;
    })
    .join("");

  return `<p class="sent-kicker">What happened last time</p>
    <p class="muted tiny">${a.n} days since ${a.windowStart.slice(0, 4)} sat closest to today's five components — ${match} Median move over ${window}, and how often it rose:</p>
    <div class="base-grid">${body}</div>
    <p class="muted tiny">Returns are total return — coupons and dividends included, which is most of the return on a bond. Today's model replayed over revised data, so the economic voters use numbers later than the day they describe. A base rate, not a forecast.</p>`;
}

function childFavorLine(child, parentWhy) {
  const word =
    child.stance === "in" ? "In" : child.stance === "out" ? "Out" : "Mixed";
  // Strip keeps short names (IG / HY); the tap spells them out.
  const title = child.label || child.name;
  const badge = `<span class="rubric-name">${escapeHtml(
    title
  )}</span> <strong data-state="${stanceState(child.stance)}">${escapeHtml(
    word
  )}</strong>`;
  const parent = String(parentWhy ?? "").trim();
  const why = String(child.why ?? "").trim();
  if (why && why !== parent) {
    return `<span class="rubric-split">${badge} <span class="muted sent-hint">${escapeHtml(
      child.why
    )}</span></span>`;
  }
  return `<span class="rubric-split">${badge}</span>`;
}

function analogVerdictWord(br) {
  if (br.weak) {
    if (br.verdict === "coinflip") return "Loose history, no lean";
    return `Loose history, ${
      br.verdict === "disagrees" ? "argues the other way" : `leans ${br.lean}`
    }`;
  }
  if (br.verdict === "agrees") return "History agrees";
  if (br.verdict === "disagrees") return "History disagrees";
  if (br.verdict === "coinflip") return "No lean in the record";
  return `History leans ${br.lean}`;
}

function analogRateText(br, label) {
  const name = escapeHtml(label || br.name);
  const sign = br.median > 0 ? "+" : "";
  const vs = Number.isFinite(br.baseUp)
    ? ` (normally ${br.baseUp}% up; median ${sign}${br.median}%)`
    : Number.isFinite(br.median)
      ? ` (median ${sign}${br.median}%)`
      : "";
  return `${name} rose in ${br.up}% of them over ${br.hz}${vs}`;
}

function analogHtml(br, { part = "full", label } = {}) {
  if (!br) return "";
  const verdictWord = analogVerdictWord(br);
  if (part === "verdict") {
    return `<span class="rubric-base" data-verdict="${br.verdict}">
    <strong>${escapeHtml(verdictWord)}</strong>
    <span class="muted"> — ${br.n} days over ${escapeHtml(br.hz)}.</span>
  </span>`;
  }
  if (part === "rate") {
    return `<span class="rubric-base rubric-analog-rate" data-verdict="${br.verdict}">
    <span class="muted">${analogRateText(br, label)}.</span>
  </span>`;
  }
  const sign = br.median > 0 ? "+" : "";
  let rateLine = `after days like today, ${escapeHtml(br.name)} ran ${sign}${br.median}% over ${br.hz} and rose ${br.up}% of the time`;
  if ((br.stance === "out" || br.stance === "in") && Number.isFinite(br.up)) {
    rateLine = `this has happened ${br.n} times; ${escapeHtml(br.name)} rose in ${br.up}% of them over ${br.hz}`;
  }
  const vs =
    Number.isFinite(br.baseUp) && br.stance !== "in" && br.stance !== "out"
      ? ` vs ${br.baseUp}% normally`
      : Number.isFinite(br.baseUp) && (br.stance === "in" || br.stance === "out")
        ? ` (normally ${br.baseUp}% up; median ${sign}${br.median}%)`
        : "";
  const nBit =
    br.stance === "in" || br.stance === "out" ? "" : ` (${br.n} days)`;
  return `<span class="rubric-base" data-verdict="${br.verdict}">
    <strong>${escapeHtml(verdictWord)}</strong>
    <span class="muted"> — ${rateLine}${vs}${nBit}.</span>
  </span>`;
}

function favorItemExtras(it, { withAnalog = true } = {}) {
  const extras = [];
  const kids = it.tenors?.length ? it.tenors : it.splits || [];
  if (kids.length) {
    if (withAnalog) {
      extras.push(
        analogHtml(favorBaseRate(it.id, it.stance) || childAnalog(kids[0]), {
          part: "verdict",
        })
      );
    }
    for (const kid of kids) {
      extras.push(childFavorLine(kid, it.why));
      if (withAnalog) {
        extras.push(
          analogHtml(childAnalog(kid), {
            part: "rate",
            label: kid.label || kid.name,
          })
        );
      }
    }
  }
  if (it.note) {
    extras.push(`<span class="muted sent-hint">${escapeHtml(it.note)}</span>`);
  }
  if (withAnalog && !kids.length) {
    extras.push(analogHtml(favorBaseRate(it.id, it.stance)));
  }
  return extras.filter(Boolean);
}

function showSentenceDialog({ hug = false, below = "lights" } = {}) {
  const dlg = $("#dlgSentence");
  if (!dlg) return;
  dlg.classList.toggle("dlg-hug", hug);
  try {
    openTapDialog(dlg, below);
    if (SNAP) syncComponentHint(viewOf(SNAP));
  } catch (err) {
    console.warn("showSentenceDialog: showModal failed", err);
  }
  requestAnimationFrame(() => {
    dlg.scrollTop = 0;
    const body = $("#sentenceBody");
    if (body) body.scrollTop = 0;
  });
}

function openFavorCard(id) {
  if (!SNAP || !id) return;
  $("#dlgLight")?.close();
  clearLightFocus();
  const snap = viewOf(SNAP);
  const meaning = buildMeaning(snap, DEFAULT_IMPULSE);
  const it = meaning.favor.items.find((x) => x.id === id);
  if (!it) return;

  const st = stanceState(it.stance);
  const word = it.stance === "in" ? "In" : it.stance === "out" ? "Out" : "Mixed";
  const extras = favorItemExtras(it);

  const titleEl = $("#sentenceTitle");
  if (titleEl) titleEl.textContent = it.name;

  $("#sentenceBody").innerHTML = `
    <div class="sent-explain rubric-row"><p class="sent-explain-title">
      <strong data-state="${st}">${word}</strong>
      <span class="muted sent-hint">${escapeHtml(it.why)}</span></p>
      ${extras.length ? `<div class="rubric-extra">${extras.join("")}</div>` : ""}
    </div>
  `;
  showSentenceDialog({ hug: true, below: "favor" });
}

function openSentence(snap) {
  if (!snap) return;
  $("#dlgLight")?.close();
  clearLightFocus();
  const meaning = buildMeaning(snap, DEFAULT_IMPULSE);
  const sheets = Object.fromEntries(LIGHT_IDS.map((id) => [id, liveSheet(id, snap)]));
  const evidence = LIGHT_IDS.map((id) => sheets[id]?.teach)
    .filter(Boolean)
    .map(
      (line) =>
        `<div class="sent-explain"><p class="sent-explain-title">${escapeHtml(line)}</p></div>`
    )
    .join("") || regimeEvidence(snap)
        .map(
          (line) =>
            `<div class="sent-explain"><p class="sent-explain-title">${escapeHtml(line)}</p></div>`
        )
        .join("");

  const movedBits = LIGHT_IDS.map((id) => {
    const morn = morningWord(id);
    const now = sheets[id]?.word;
    if (!morn || !now || morn === now) return null;
    const label = snap.lights?.[id]?.label || id;
    return `${label} ${morn} → ${now}`;
  }).filter(Boolean);
  const tapeNote = movedBits.length
    ? `<p class="muted tiny sent-foot">Moved with the tape: ${escapeHtml(movedBits.join("; "))}.</p>`
    : "";

  const extra = teachOnlyTensions(snap);
  const watch = extra.length
    ? `<p class="sent-kicker">Also note</p>${extra
        .map(
          (d) => `<div class="sent-explain sent-explain-flag">
        <p class="sent-explain-title"><strong data-state="neutral">${escapeHtml(tensionTitle(d))}</strong>
          <span class="muted sent-hint"> — ${escapeHtml(tensionTeach(d))}</span></p>
      </div>`
        )
        .join("")}`
    : "";

  const soWhat = `<p class="sent-kicker">So what</p>
    <div class="sent-explain"><p class="sent-explain-title"><strong data-state="${
      meaning.duration.dir === "rising"
        ? "tight"
        : meaning.duration.dir === "falling"
          ? "easing"
          : "neutral"
    }">${escapeHtml(meaning.duration.label)}</strong>
      <span class="muted sent-hint"> — ${escapeHtml(meaning.duration.line)}</span></p></div>
    <div class="sent-explain"><p class="sent-explain-title"><strong data-state="${
      meaning.credit.dir === "rising"
        ? "tight"
        : meaning.credit.dir === "falling"
          ? "easing"
          : "neutral"
    }">${escapeHtml(meaning.credit.label)}</strong>
      <span class="muted sent-hint"> — ${escapeHtml(meaning.credit.line)}</span></p></div>
    <p class="sent-kicker">In / out of favor</p>
    <div class="sent-explain"><p class="sent-explain-title"><strong data-state="neutral">${escapeHtml(
      meaning.favor.pair.line
    )}</strong>
      <span class="muted sent-hint"> — ${escapeHtml(meaning.favor.pair.why)}</span></p></div>
    ${meaning.favor.items
      .map((it) => {
        const st = stanceState(it.stance);
        const word = it.stance === "in" ? "In" : it.stance === "out" ? "Out" : "Mixed";
        const extras = favorItemExtras(it, { withAnalog: true });
        return `<div class="sent-explain rubric-row"><p class="sent-explain-title">
          <span class="rubric-name">${escapeHtml(it.name)}</span>
          <strong data-state="${st}">${word}</strong>
          <span class="muted sent-hint">${escapeHtml(it.why)}</span></p>
          ${extras.length ? `<div class="rubric-extra">${extras.join("")}</div>` : ""}
        </div>`;
      })
      .join("")}
    ${meaning.confirm
      .slice(0, 3)
      .map(
        (line) =>
          `<div class="sent-explain"><p class="sent-explain-title">${escapeHtml(line)}</p></div>`
      )
      .join("")}
    ${meaning.falsify
      .slice(0, 2)
      .map(
        (line) =>
          // The "Watch" label already says what the line is for; leading with
          // "Falsify if" again is jargon on top of a label.
          `<div class="sent-explain sent-explain-flag"><p class="sent-explain-title"><strong data-state="neutral">Watch</strong>
          <span class="muted sent-hint"> — ${escapeHtml(line.replace(/^Falsify if /i, ""))}</span></p></div>`
      )
      .join("")}`;

  const axis = `<p class="muted tiny sent-foot">Green is the reflationary end of each component, red the contractionary end — neither is good or bad on its own. Between the cuts, the word and the needle.</p>`;

  const liveFoot = movedBits.length
    ? `Live tape${REGIME?.verdict === "SPOT ON" ? " · morning check passed" : ""} · ${DEFAULT_IMPULSE} turn`
    : REGIME?.verdict === "SPOT ON"
      ? `Verified bake · ${DEFAULT_IMPULSE} turn`
      : `${DEFAULT_IMPULSE} turn`;
  const verified = `${axis}<p class="muted tiny sent-foot">${escapeHtml(liveFoot)}</p>`;

  const titleEl = $("#sentenceTitle");
  if (titleEl) titleEl.textContent = "Today’s regime";

  $("#sentenceBody").innerHTML = `
    <p class="sent-story">${regimeStoryHtml(snap)}</p>
    ${tapeNote}
    ${soWhat}
    ${baseRateHtml()}
    <p class="sent-kicker">Why we say that</p>
    ${evidence}
    ${watch}
    ${verified}
  `;
  showSentenceDialog();
}

function renderLights(snap) {
  const root = $("#lights");
  if (!root) return;
  if (settlePhase === "playing" || settlePhase === "arriving") {
    settleDirty = true;
    applyScrollSpyUi();
    return;
  }
  const order = ["liquidity", "rates", "growth", "inflation", "risk"];
  root.innerHTML = order
    .map((id) => {
      const L = snap.lights?.[id] || { state: "empty", label: id };
      const scoreNum =
        L.score != null && Number.isFinite(L.score) ? L.score : null;
      const score = scoreNum != null ? fmtLightScore(scoreNum) : "—";
      const cliff = distanceToCliff(L.score);
      const nearFlip =
        cliff != null && Number.isFinite(cliff) && cliff < 0.05
          ? Math.abs(L.score) > 0.45
            ? `${cliff.toFixed(2)} inside the word`
            : `${cliff.toFixed(2)} from flip`
          : null;
      const on = focusLight === id || streetSpyLight() === id;
      const chev = L.impulse?.dir || "flat";
      const split = lightIsSplit(snap, id);
      const word = scoreNum != null ? chipWord(id, scoreNum) : "—";
      const inflTurn =
        id === "inflation" && L.state === "easing" ? inflationTurn(L.impulse?.dir) : "";
      const spoken = inflTurn ? `${word}, ${inflTurn}` : word;
      const tip = [inflTurn ? spoken : null, nearFlip].filter(Boolean).join(" · ");
      return `<button type="button" class="light" data-state="${L.state || "empty"}" data-id="${id}" data-focus="${
        on ? "true" : "false"
      }" data-clash="${split ? "true" : "false"}" data-near-flip="${nearFlip ? "true" : "false"}" aria-pressed="${on ? "true" : "false"}"${
        tip ? ` title="${escapeHtml(tip)}"` : ""
      } aria-label="${escapeHtml(
        `${L.label || id}, ${spoken}, ${chev === "up" ? "▲1m" : chev === "down" ? "▼1m" : "–1m"}, ${score}${nearFlip ? `, ${nearFlip}` : ""}${split ? ", voters disagree" : ""}`
      )}">
        <span class="impulse-chev" data-dir="${chev}" title="1m turn" aria-hidden="true"></span>
        <span class="lbl">${escapeHtml(L.label || id)}</span>
        <span class="word">${escapeHtml(word)}</span>
        <span class="score"${
          scoreNum != null ? ` data-target="${scoreNum}"` : ""
        }>${escapeHtml(score)}</span>
        ${trackHtml(L.score, L.state || "empty")}
      </button>`;
    })
    .join("");
  // Bind once per render. Prefer click only — pinStack also delegates click;
  // pointerup+click was firing selectLight 2–3× per tap.
  root.onclick = (e) => {
    const card = e.target.closest?.(".light[data-id]");
    if (!card || !root.contains(card)) return;
    e.preventDefault();
    e.stopPropagation();
    selectLight(card.dataset.id);
  };
  root.onpointerup = null;
  parkSettleStart(root);
}



function renderTabs(snap) {
  const tabs = $("#tabs");
  const layers = (snap.layers || []).filter((l) => STREET_TABS.has(l.id));
  const items = [{ id: "all", label: "All", blurb: "Full book" }, ...layers];
  tabs.innerHTML = items
    .map((l) => {
      const full = l.label || l.id;
      return `<button type="button" class="btn tiny-btn" role="tab" data-layer="${l.id}" title="${escapeHtml(
        full
      )}">${escapeHtml(full)}</button>`;
    })
    .join("");
  tabs.onclick = (e) => {
    const b = e.target.closest("button[data-layer]");
    if (!b) return;
    const layer = b.dataset.layer;
    // All / FX / Markets stay on The book — jump to that shelf, never a second table.
    focusLight = null;
    activeLayer = "all";
    scrollBucket = null;
    // Keep picks when browsing streets to build a club; wipe only outside pick.
    if (comparePhase !== "pick") {
      exitCompareToStreets();
    }
    if (layer === "all") {
      lockScrollSpy(null);
      refreshViews();
      syncStreetSelection();
      scrollTableToTop();
    } else {
      lockScrollSpy(layer);
      refreshViews();
      syncStreetSelection();
      scrollToStreetSection(layer);
    }
    requestAnimationFrame(syncMarketsLiveUi);
  };
  requestAnimationFrame(syncMarketsLiveUi);
}

function nextFreeCompareSlot() {
  return COMPARE_SLOTS.find((slot) => !(compareSaves[slot] || []).length) || null;
}

function saveCompareSlot(slot) {
  if (!COMPARE_SLOTS.includes(slot)) return;
  if (!compareList.length) return;
  compareSaves[slot] = [...compareList].slice(0, COMPARE_MAX);
  try {
    localStorage.setItem(`gf-compare-${slot}`, JSON.stringify(compareSaves[slot]));
  } catch (_) {
    /* ignore */
  }
  syncCompareBtn();
}

function clearCompareSlot(slot) {
  if (!COMPARE_SLOTS.includes(slot)) return;
  compareSaves[slot] = [];
  try {
    localStorage.removeItem(`gf-compare-${slot}`);
  } catch (_) {
    /* ignore */
  }
}

function loadCompareSlot(slot) {
  if (!COMPARE_SLOTS.includes(slot)) return;
  const list = compareSaves[slot] || [];
  if (!list.length) return;
  compareList = [...list];
  comparePhase = "view";
  compareActiveSlot = slot;
  focusLight = null;
  refreshViews();
}

function exitCompareToStreets() {
  comparePhase = "off";
  compareList = [];
  compareActiveSlot = null;
  clubSavedAs = null;
}

function sortSeries(a, b) {
  const ao = a.order != null && Number.isFinite(a.order) ? a.order : 9999;
  const bo = b.order != null && Number.isFinite(b.order) ? b.order : 9999;
  return ao - bo || a.name.localeCompare(b.name);
}

/** Who is voting this component right now — same set as the blue mark. */
function isVotingNow(s, layer, snap) {
  const lid = layer === "all" ? s.light : layer;
  if (!lid) return false;
  return (snap?.lights?.[lid]?.members || []).includes(s.id);
}

/** Current voters first, then the rest of the street. */
function sortStreet(a, b, layer, snap) {
  const av = isVotingNow(a, layer, snap) ? 0 : 1;
  const bv = isVotingNow(b, layer, snap) ? 0 : 1;
  return av - bv || sortSeries(a, b);
}

/** Street in the All book: current voters sit with their component, even if
 * the print is filed on another shelf (5y5y votes Inflation, filed on Rates).
 * Anything with a Markets shelf tag sits under Markets — same set as the tab. */
function bookStreet(s, snap) {
  const lid = s.light;
  if (lid && (snap?.lights?.[lid]?.members || []).includes(s.id)) return lid;
  if (s.marketBucket || s.street === "markets" || s.layer === "markets") {
    return "markets";
  }
  return s.layer || s.street || "";
}

function isMarketsSeries(s) {
  return (
    s.street === "markets" ||
    s.layer === "markets" ||
    !!s.marketBucket
  );
}

function seriesList(snap, layer) {
  // Stale/excluded series stay out of the table — they only widen the layout
  let all = Object.values(snap.series || {}).filter((s) => s.status === "ok");

  // View phase only — pick phase keeps the full current shelf so you can choose.
  if (comparePhase === "view" && compareList.length) {
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    return compareList.map((id) => byId[id]).filter(Boolean);
  }

  if (layer === "all") {
    return all.sort((a, b) => {
      const order = [
        "liquidity",
        "rates",
        "growth",
        "inflation",
        "risk",
        "fx",
        "markets",
      ];
      const as = bookStreet(a, snap);
      const bs = bookStreet(b, snap);
      const d = order.indexOf(as) - order.indexOf(bs);
      if (d) return d;
      if (as === "markets") {
        const ao = MARKET_BUCKET_ORDER.indexOf(a.marketBucket);
        const bo = MARKET_BUCKET_ORDER.indexOf(b.marketBucket);
        const ai = ao < 0 ? 99 : ao;
        const bi = bo < 0 ? 99 : bo;
        return ai - bi || sortSeries(a, b);
      }
      return sortStreet(a, b, as || a.layer, snap);
    });
  }

  if (layer === "markets") {
    all = all.filter(isMarketsSeries);
    return all.sort((a, b) => {
      const ao = MARKET_BUCKET_ORDER.indexOf(a.marketBucket);
      const bo = MARKET_BUCKET_ORDER.indexOf(b.marketBucket);
      const ai = ao < 0 ? 99 : ao;
      const bi = bo < 0 ? 99 : bo;
      return ai - bi || sortSeries(a, b);
    });
  }

  return all
    .filter((s) => s.layer === layer || s.light === layer)
    .sort((a, b) => sortStreet(a, b, layer, snap));
}

function hideMarketBuckets() {
  const el = $("#marketBuckets");
  const col = $("#heatColhead");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
  if (col) col.hidden = true;
}

function syncCompareBtn() {
  const btn = $("#btnCompare");
  if (!btn) return;
  const n = compareList.length;
  btn.classList.remove("compare-go", "compare-done");
  if (comparePhase === "off") {
    btn.textContent = "Compare";
    btn.setAttribute("aria-pressed", "false");
    btn.disabled = false;
    btn.title = "Pick up to 10 series, then Go";
  } else if (comparePhase === "pick") {
    if (n < 1) {
      btn.textContent = "Cancel";
      btn.classList.add("compare-done");
      btn.title = "Leave pick";
    } else {
      btn.textContent = `Go · ${n}`;
      btn.classList.add("compare-go");
      btn.title = "Open this club";
    }
    btn.setAttribute("aria-pressed", "true");
    btn.disabled = false;
  } else {
    btn.textContent = "Done";
    btn.setAttribute("aria-pressed", "true");
    btn.classList.add("compare-done");
    btn.disabled = false;
    btn.title = "Leave compare club";
  }

  // Streets: saved m1–m3 sit left of Compare.
  const saveGroup = $("#compareSaveGroup");
  let anySave = false;
  for (const slot of COMPARE_SLOTS) {
    const b = $(`#btnCompare_${slot}`);
    if (!b) continue;
    const saved = compareSaves[slot] || [];
    const show = saved.length > 0 && comparePhase === "off";
    b.hidden = !show;
    if (show) {
      anySave = true;
      b.textContent = slot;
      b.setAttribute("aria-pressed", "false");
      b.title = `Open ${slot} (${saved.length})`;
      b.disabled = false;
    }
  }
  if (saveGroup) saveGroup.hidden = !anySave;

  // Club: same [m# · Delete] cluster whether you just saved or opened a recall.
  const clubGroup = $("#compareClubGroup");
  const saveBtn = $("#btnCompareSave");
  const del = $("#btnCompareDelete");
  const inClub = comparePhase === "view";
  const free = nextFreeCompareSlot();
  const slotLabel = clubSavedAs || compareActiveSlot;
  const showSave = inClub && (!!slotLabel || !compareActiveSlot);
  const showDel = inClub && !!compareActiveSlot;

  if (saveBtn) {
    saveBtn.hidden = !showSave;
    if (showSave) {
      if (slotLabel) {
        saveBtn.textContent = slotLabel;
        saveBtn.disabled = true;
        saveBtn.title = `Saved as ${slotLabel}`;
        saveBtn.setAttribute("aria-pressed", "true");
      } else {
        saveBtn.textContent = "m";
        saveBtn.disabled = n < 1 || !free;
        saveBtn.title = !free
          ? "All m slots full — delete one first"
          : `Save this club to ${free}`;
        saveBtn.setAttribute("aria-pressed", "false");
      }
    }
  }
  if (del) {
    del.hidden = !showDel;
    if (showDel) del.title = `Delete ${compareActiveSlot} and return to streets`;
  }
  if (clubGroup) clubGroup.hidden = !(showSave || showDel);
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
  refreshViews();
}

function syncStreetSelection() {
  const tabs = $("#tabs");
  if (!tabs) return;
  const spyLight = streetSpyLight();
  const spyTab =
    !focusLight &&
    activeLayer === "all" &&
    (scrollStreet === "fx" || scrollStreet === "markets")
      ? scrollStreet
      : null;
  [...tabs.querySelectorAll("button[data-layer]")].forEach((x) => {
    const layer = x.dataset.layer;
    const selected =
      !focusLight &&
      !spyLight &&
      !spyTab &&
      layer === activeLayer;
    x.setAttribute("aria-selected", selected ? "true" : "false");
    x.dataset.scrollOn = spyTab && layer === spyTab ? "true" : "false";
  });
}

/** All book: which of the five is under the pin. Null at the top (All) or in FX / Markets. */
function streetSpyLight() {
  if (focusLight || activeLayer !== "all" || comparePhase !== "off") return null;
  return TAB_TO_LIGHT[scrollStreet] || null;
}

/** Last bucket (Ag) is three short rows. They never reach the pin, so the spy
 * would stay on Energy. Once the page cannot scroll further, take the last bucket. */
function scrolledToEnd() {
  const root = document.scrollingElement || document.documentElement;
  const y = window.scrollY || root.scrollTop || 0;
  if (y < 8) return false;
  return y + window.innerHeight >= (root.scrollHeight || document.body.scrollHeight) - 12;
}

function streetUnderPin(rows, probe) {
  const root = document.scrollingElement || document.documentElement;
  const y = window.scrollY || root.scrollTop || 0;
  if (y < 8) return "all";
  let current = rows[0]?.dataset.street || null;
  for (const tr of rows) {
    if (tr.getBoundingClientRect().top <= probe) {
      current = tr.dataset.street || current;
    } else {
      break;
    }
  }
  return current;
}

function bucketUnderPin(rows, probe) {
  const root = document.scrollingElement || document.documentElement;
  const y = window.scrollY || root.scrollTop || 0;
  if (y < 8) return "all";
  let current = null;
  for (const tr of rows) {
    const id = tr.dataset.bucket;
    if (!id) continue;
    if (tr.getBoundingClientRect().top <= probe) current = id;
    else break;
  }
  if (!current) {
    current = rows.find((tr) => tr.dataset.bucket)?.dataset.bucket || null;
  }
  if (!scrolledToEnd()) return current;
  const last = [...rows].reverse().find((tr) => tr.dataset.bucket);
  const lastId = last?.dataset.bucket;
  if (!lastId) return current;
  const firstOfLast = rows.find((tr) => tr.dataset.bucket === lastId);
  if (firstOfLast && firstOfLast.getBoundingClientRect().top > probe) {
    return lastId;
  }
  return current;
}

/** All: street under the pin. Markets All: bucket under the pin. */
function syncScrollSpy() {
  // Keep the ring on the jump target — do not re-paint every scroll tick
  // (that retriggers the border and looks like flicker).
  if (spyLocked) {
    scrollStreet = spyLockStreet;
    scrollBucket = null;
    return;
  }
  const clear = () => {
    if (scrollStreet != null || scrollBucket != null) {
      scrollStreet = null;
      scrollBucket = null;
      applyScrollSpyUi();
    }
  };
  if (comparePhase !== "off") {
    clear();
    return;
  }

  const pin = $("#pinStack");
  const pinBottom = pin?.getBoundingClientRect().bottom ?? 0;
  const probe = Math.max(pinBottom, 0) + 4;

  if (activeLayer === "all") {
    const rows = [...document.querySelectorAll("#heatBody tr[data-street]")];
    if (!rows.length) {
      clear();
      return;
    }
    const next = streetUnderPin(rows, probe);
    if (next === scrollStreet && scrollBucket == null) return;
    scrollStreet = next;
    scrollBucket = null;
    applyScrollSpyUi();
    return;
  }

  if (activeLayer === "markets" && !focusLight) {
    const rows = [...document.querySelectorAll("#heatBody tr[data-bucket]")];
    if (!rows.length) {
      clear();
      return;
    }
    const next = bucketUnderPin(rows, probe);
    if (next === scrollBucket && scrollStreet == null) return;
    scrollStreet = null;
    scrollBucket = next;
    applyScrollSpyUi();
    return;
  }

  clear();
}

function applyScrollSpyUi() {
  if (!SNAP) return;
  document.querySelectorAll("#lights .light[data-id]").forEach((el) => {
    const on = focusLight === el.dataset.id || streetSpyLight() === el.dataset.id;
    el.dataset.focus = on ? "true" : "false";
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
  syncStreetSelection();
}

function refreshViews() {
  if (!SNAP) return;
  const snap = viewOf(SNAP);
  renderLights(snap);
  renderTable(snap);
  hideMarketBuckets();
  syncStreetSelection();
  syncCompareBtn();
  renderFavorStrip();
  syncScrollSpy();
  // After layout — first paint can have wrong row tops.
  requestAnimationFrame(() => syncScrollSpy());
}

function syncViewControls() {
  const btn = $("#btnViewMode");
  if (btn) {
    // Button shows the action to switch TO
    btn.textContent = globalView === "values" ? "Chart" : "Values";
    btn.setAttribute("aria-pressed", globalView === "charts" ? "true" : "false");
  }
  const g = $("#horizonGroup");
  if (g) {
    [...g.querySelectorAll("[data-horizon]")].forEach((b) => {
      b.setAttribute(
        "aria-pressed",
        b.dataset.horizon === statHorizon ? "true" : "false"
      );
    });
  }
}

function valuesCells(s) {
  if (s.status !== "ok" || s.latest == null) {
    return `<td colspan="${COLSPAN_DATA}" class="empty">empty — ${escapeHtml(s.error || "no data")}</td>`;
  }
  const live = liveQuote(s);
  const latest = live ? live.price : s.latest;
  const dir = impulseOf(s).dir;
  const heat =
    dir === "up" ? "z-pos" : dir === "down" ? "z-neg" : dir === "flat" ? "z-mid" : "";
  return `<td><span class="cell-heat${heat ? ` ${heat}` : ""}"${live ? ' data-live="1"' : ""}>${fmtValue(latest, s.units)}</span></td>`;
}

function chartCell(s) {
  return `<td class="chart-cell" colspan="${COLSPAN_DATA}">
    <div class="spark-wrap" data-spark="${s.id}">
      <canvas class="spark" width="600" height="20" aria-hidden="true"></canvas>
      <span class="spark-chg muted" aria-hidden="true"></span>
      <span class="spark-msg muted"></span>
    </div>
  </td>`;
}

function renderThead(rows) {
  const thead = $("#heat thead tr");
  if (!thead) return;
  const h = statHorizon;
  const charts = globalView === "charts";
  if (charts) {
    thead.innerHTML = `<th>Name</th><th colspan="${COLSPAN_DATA}">Chart · ${h}</th>`;
  } else {
    thead.innerHTML = `<th>Name</th><th>Latest</th>`;
  }
}

function syncComponentHint(snap) {
  const hint = $("#streetHint");
  const regime = $("#btnRegime");
  if (!hint) return;
  const dlg = $("#dlgSentence");
  const regimeOn = !!(dlg?.open && !dlg.classList.contains("dlg-hug"));
  const lid = focusLight || hintLight || "liquidity";
  const L = snap?.lights?.[lid];
  const label = L?.label || "Liquidity";
  const lightOn = !!$("#dlgLight")?.open;
  const hintOn = !regimeOn && !!(focusLight || lightOn);
  hint.hidden = false;
  hint.dataset.light = lid;
  hint.textContent = label;
  hint.title = "Tap for details";
  hint.setAttribute("aria-label", `${label}, tap for details`);
  hint.setAttribute("aria-pressed", hintOn ? "true" : "false");
  regime?.setAttribute("aria-pressed", regimeOn ? "true" : "false");
}

function renderTable(snap) {
  if (!snap) return;
  // All keeps the full book even if a light is visually spy-focused.
  const streetId =
    activeLayer === "all"
      ? "all"
      : focusLight
        ? LIGHT_TO_TAB[focusLight] || activeLayer
        : activeLayer;
  const focusMeta =
    activeLayer !== "all" && focusLight ? snap.lights?.[focusLight] : null;
  let layerMeta;
  if (comparePhase === "view") {
    layerMeta = { label: `Compare · ${compareList.length}` };
  } else if (comparePhase === "pick") {
    layerMeta = { label: `Pick · ${compareList.length}/${COMPARE_MAX}` };
  } else if (focusMeta) {
    layerMeta = {
      label:
        (snap.layers || []).find((l) => l.id === streetId)?.label ||
        focusMeta.label ||
        streetId,
    };
  } else if (activeLayer === "markets") {
    layerMeta = { label: "Markets" };
  } else {
    layerMeta =
      (snap.layers || []).find((l) => l.id === activeLayer) ||
      (activeLayer === "all"
        ? { label: "The book" }
        : { label: activeLayer });
  }
  $("#layerTitle").textContent = layerMeta.label || activeLayer;
  syncComponentHint(snap);
  syncMarketsLiveUi();

  const body = $("#heatBody");
  const rows = seriesList(snap, streetId);
  renderThead(rows);

  const markStreets = streetId === "all" && comparePhase === "off";
  const markBuckets = streetId === "markets" && comparePhase === "off";
  let prevStreet = "";
  let prevBucket = "";
  const parts = [];
  for (const s of rows) {
    const view = rowView(s.id);
    const data = view === "charts" ? chartCell(s) : valuesCells(s);
    const pack =
      streetId === "all"
        ? s.light
        : focusLight || TAB_TO_LIGHT[streetId] || streetId;
    const voter =
      pack &&
      s.light === pack &&
      (snap.lights?.[s.light]?.members || []).includes(s.id)
        ? s.light
        : "";
    const picked = compareList.includes(s.id);
    const street =
      streetId === "all" ? bookStreet(s, snap) : s.layer || s.street || "";
    const bucket = s.marketBucket || "";
    if (markStreets && street && street !== prevStreet) {
      parts.push(sectionRow("street", street, snap));
      prevStreet = street;
      prevBucket = "";
    }
    // Markets stretch of All: same Duration / Credit / … rows as the Markets tab.
    if (
      ((markStreets && street === "markets") || markBuckets) &&
      bucket &&
      bucket !== prevBucket
    ) {
      parts.push(sectionRow("bucket", bucket, snap));
      prevBucket = bucket;
    }
    parts.push(`<tr data-id="${s.id}" data-view="${view}"${
      street ? ` data-street="${escapeHtml(street)}"` : ""
    }${bucket ? ` data-bucket="${escapeHtml(bucket)}"` : ""}${
      voter ? ` data-voter="${escapeHtml(voter)}"` : ""
    }${picked && comparePhase === "pick" ? ` data-compare="1"` : ""}>
        <td class="name-cell"><span class="name">${escapeHtml(s.name)}</span></td>
        ${data}
      </tr>`);
  }
  body.innerHTML = parts.join("");

  body.onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    // Pick mode: any tap on the row toggles membership (Go · n tracks live).
    if (comparePhase === "pick") {
      const i = compareList.indexOf(id);
      if (i >= 0) compareList.splice(i, 1);
      else if (compareList.length < COMPARE_MAX) compareList.push(id);
      refreshViews();
      return;
    }
    if (e.target.closest(".name-cell")) {
      openSeries(snap.series[id]);
      return;
    }
    if (e.target.closest(".chart-cell, td:not(.name-cell)")) {
      toggleRowView(id);
      refreshViews();
    }
  };

  paintSparks();
}

/**
 * Sparklines never look back further than a year, so the app ships one trimmed
 * bundle rather than the full per-series history — which is ~18MB and is not in
 * the repo, so the old per-series fetch 404'd everywhere except a dev machine.
 */
let sparkBundle = null;
function loadSparkBundle() {
  if (!sparkBundle) {
    sparkBundle = fetch("./data/sparks.json", { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.series || null)
      .catch(() => null);
  }
  return sparkBundle;
}

/** Baked rows only carry 1w/2w/1m. Fill 3m/6m (and any missing window) from sparks. */
async function hydrateImpulseFromSparks() {
  if (!SNAP?.series) return;
  const all = await loadSparkBundle();
  if (!all) return;
  for (const [id, s] of Object.entries(SNAP.series)) {
    if (!s || s.status !== "ok") continue;
    if (!sparkLive[id] && all[id]) {
      sparkLive[id] = all[id].map((pt) => ({ ...pt }));
    }
    const pts = sparkLive[id];
    if (!pts?.length) continue;
    const facts = seriesFacts(pts, specFromRow(s));
    // Keep the baked 1w/2w/1m — that turn sits the six. Only fill table windows
    // (3m/6m) and any lookback the bake left empty.
    const next = { ...(s.impulse || {}) };
    for (const [k, v] of Object.entries(facts.impulse || {})) {
      const cur = next[k];
      const empty =
        !cur || (cur.dir == null && cur.score == null && cur.delta == null);
      if (k === "3m" || k === "6m" || empty) next[k] = v;
    }
    s.impulse = next;
  }
}

async function loadHistory(id) {
  if (histCache.has(id)) return histCache.get(id);
  const p = loadSparkBundle().then((all) => {
    const base = all?.[id];
    if (!base) return null;
    if (!sparkLive[id]) sparkLive[id] = base.map((pt) => ({ ...pt }));
    return { id, points: sparkLive[id] };
  });
  histCache.set(id, p);
  return p;
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
  const cssH = 20;
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
    ? styles.getPropertyValue("--ease").trim() || "#1db87a"
    : styles.getPropertyValue("--tight").trim() || "#f23645";
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
      const chgEl = wrap.querySelector(".spark-chg");
      const hist = await loadHistory(id);
      if (!canvas) return;
      if (!hist?.points?.length) {
        if (msg) msg.textContent = "no history";
        if (chgEl) {
          chgEl.textContent = "";
          chgEl.removeAttribute("data-dir");
        }
        return;
      }
      const dur = chartDuration();
      const series = SNAP?.series?.[id];
      const sliced = sliceLookback(hist.points, dur, series?.freq);
      if (!sliced.length) {
        if (msg) msg.textContent = `no ${dur} data`;
        if (chgEl) {
          chgEl.textContent = "";
          chgEl.removeAttribute("data-dir");
        }
        return;
      }
      drawSpark(canvas, sliced);
      const chg = fmtWindowChange(sliced, series?.units);
      if (chgEl) {
        chgEl.textContent = chg.text;
        chgEl.title = `${dur} change`;
        if (!chg.dir) chgEl.removeAttribute("data-dir");
        else chgEl.dataset.dir = chg.dir;
      }
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

function openSeries(s) {
  if (!s) return;
  $("#seriesTitle").textContent = s.name;
  const code = s.search || s.fred || s.yahoo || s.id;
  const voter = memberAnchorScore(s) != null ? s.light || null : null;
  const home = voter ? LIGHT_TO_TAB[voter] : null;
  const street = s.street || s.layer || "";
  const cross = voter && home && street && street !== home;
  const lightLabel = SNAP?.lights?.[voter]?.label || voter;
  const clubLabel = SNAP?.lights?.[s.light]?.label || s.light;
  const voteLine = voter
    ? `<p class="series-vote">Votes <strong>${escapeHtml(
        lightLabel
      )}</strong>${
        cross
          ? ` · lives on ${escapeHtml(street)}, club is usually under ${escapeHtml(
              home
            )}`
          : ""
      }</p>`
    : s.light && s.anchor?.kind === "move"
      ? `<p class="series-vote">On the <strong>${escapeHtml(
          clubLabel
        )}</strong> shelf — votes only when bond vol spikes; calm does not ease Rates.</p>`
      : `<p class="series-vote muted">Does not vote a regime component — book / output line.</p>`;
  const live = liveQuote(s);
  const latest = live ? live.price : s.latest;
  const blurb = s.note || s.sub || "";
  const lagLine =
    s.freshness === "lagged"
      ? `<p class="series-lag">Print lags — as-of can sit months behind the tape.</p>`
      : "";
  $("#seriesBody").innerHTML = `
    <div class="series-sheet">
      ${blurb ? `<p class="series-blurb">${escapeHtml(blurb)}</p>` : ""}
      ${lagLine}
      ${voteLine}
      <p class="series-meta"><code>${escapeHtml(code)}</code> · ${escapeHtml(street || "")} · ${escapeHtml(s.freq || "?")}</p>
      <dl class="series-stats">
        <div><dt>Latest</dt><dd>${
          latest == null ? "empty" : fmtValue(latest, s.units)
        }${s.units ? ` <span class="muted">${escapeHtml(s.units)}</span>` : ""}${
          live ? ` <span class="muted">last print</span>` : ""
        }</dd></div>
        <div><dt>As-of</dt><dd>${
          live?.t
            ? new Date(live.t * 1000).toLocaleString(undefined, {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : fmtAsOf(s.asOf)
        }</dd></div>
        <div><dt>Source</dt><dd>${escapeHtml(s.source || "—")}${
          s.sourceUrl
            ? ` · <a href="${s.sourceUrl}" target="_blank" rel="noopener">open</a>`
            : ""
        }</dd></div>
      </dl>
      ${s.error ? `<p class="empty">${escapeHtml(s.error)}</p>` : ""}
    </div>
  `;
  const dlg = $("#dlgSeries");
  if (!dlg) return;
  try {
    openTapDialog(dlg, "lights");
  } catch (err) {
    console.warn("openSeries: showModal failed", err);
  }
}



/** Block Safari / Chrome pull-down page reload. Normal scroll still works. */
function lockPullReload() {
  let y0 = 0;
  window.addEventListener(
    "touchstart",
    (e) => {
      y0 = e.touches[0] ? e.touches[0].clientY : 0;
    },
    { passive: true }
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      if (document.body.classList.contains("dlg-open")) return;
      if (!e.touches[0]) return;
      const se = document.scrollingElement || document.documentElement;
      if ((se.scrollTop || 0) <= 0 && e.touches[0].clientY > y0) {
        e.preventDefault();
      }
    },
    { passive: false }
  );
}

async function boot() {
  lockPullReload();
  try {
    const res = await fetch("./snapshot.json", { cache: "no-store" });
    if (!res.ok) throw new Error("snapshot.json missing — run npm run ingest");
    SNAP = await res.json();
  } catch (e) {
    const lights = $("#lights");
    if (lights) {
      lights.innerHTML = `<p class="empty" style="padding:10px">${escapeHtml(
        e.message || String(e)
      )}</p>`;
    }
    return;
  }

  const snap = viewOf(SNAP);
  renderLights(snap);
  renderTabs(SNAP);
  renderTable(snap);
  renderFavorStrip();
  startOpenSettle();
  setInterval(syncMarketsLiveUi, 15000);

  try {
    const rr = await fetch("./regime-today.json", { cache: "no-store" });
    if (rr.ok) {
      REGIME = await rr.json();
      renderFavorStrip();
    }
  } catch (_) {
    /* bake optional until first npm run bake:regime */
  }

  document.querySelectorAll("dialog.dlg-tap").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      const r = dlg.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        dlg.close();
      }
    });
    dlg.addEventListener("close", () => {
      unlockPageScroll();
      if (dlg.id === "dlgLight" || dlg.id === "dlgSentence") {
        clearLightFocus();
        return;
      }
      if (SNAP) syncComponentHint(viewOf(SNAP));
    });
  });
  window.addEventListener("resize", () => {
    if ([...document.querySelectorAll("dialog.dlg-tap")].some((d) => d.open)) {
      // Sticky is gone while locked — keep the frozen top and re-pin chrome.
      pinChromeWhileOpen();
      applySheetTop(sheetTopPx);
    }
  });

  syncViewControls();
  $("#btnMarketsLive")?.addEventListener("click", () => {
    pullMarketsLive(true);
  });
  $("#streetHint")?.addEventListener("click", () => {
    const id = $("#streetHint")?.dataset.light || focusLight || "liquidity";
    if (id) openLightSheet(id);
  });
  $("#btnRegime")?.addEventListener("click", () => {
    if (!SNAP) return;
    openSentence(viewOf(SNAP));
  });
  $("#btnViewMode").onclick = () => {
    setGlobalView(globalView === "values" ? "charts" : "values");
  };
  $("#btnCompare").onclick = () => {
    if (comparePhase === "off") {
      comparePhase = "pick";
      compareList = [];
      compareActiveSlot = null;
      clubSavedAs = null;
      focusLight = null;
    } else if (comparePhase === "pick") {
      if (!compareList.length) {
        exitCompareToStreets();
      } else {
        comparePhase = "view";
        compareActiveSlot = null;
        clubSavedAs = null;
      }
    } else {
      exitCompareToStreets();
    }
    refreshViews();
  };
  $("#btnCompareSave")?.addEventListener("click", () => {
    if (comparePhase !== "view" || clubSavedAs) return;
    const slot = nextFreeCompareSlot();
    if (!slot || !compareList.length) return;
    saveCompareSlot(slot);
    clubSavedAs = slot;
    compareActiveSlot = slot;
    syncCompareBtn();
  });
  $("#btnCompareDelete")?.addEventListener("click", () => {
    if (comparePhase !== "view" || !compareActiveSlot) return;
    clearCompareSlot(compareActiveSlot);
    exitCompareToStreets();
    refreshViews();
  });
  for (const slot of COMPARE_SLOTS) {
    $(`#btnCompare_${slot}`)?.addEventListener("click", () => {
      if (comparePhase === "pick") return;
      clubSavedAs = null;
      loadCompareSlot(slot);
    });
  }
  $("#horizonGroup").onclick = (e) => {
    const b = e.target.closest("[data-horizon]");
    if (!b) return;
    const next = b.dataset.horizon;
    if (!IMPULSE_KEYS.includes(next)) return;
    statHorizon = next;
    syncViewControls();
    refreshViews();
    if (globalView === "charts" || [...rowFlip].length) paintSparks();
  };

  // Lights: pin-level backup if a re-render drops root.onclick mid-gesture.
  $("#pinStack")?.addEventListener("click", (e) => {
    const card = e.target.closest(".light[data-id]");
    if (!card || !$("#lights")?.contains(card)) return;
    // Root handler already stopped propagation when it fired.
    e.preventDefault();
    selectLight(card.dataset.id);
  });

  $("#favorStrip")?.addEventListener("click", (e) => {
    const cell = e.target.closest?.("[data-favor-id]");
    if (!cell || !SNAP) return;
    openFavorCard(cell.dataset.favorId);
  });

  let pinFitTimer = 0;
  const syncPinHeight = () => {
    const pin = $("#pinStack");
    if (!pin) return;
    // Match the stuck pin's bottom edge — offsetHeight alone was short.
    const top = pin.getBoundingClientRect().top;
    const bottom = pin.getBoundingClientRect().bottom;
    const pinned = Math.max(0, Math.ceil(bottom - Math.min(top, 0)));
    document.documentElement.style.setProperty("--pin-h", `${pinned}px`);
  };
  window.addEventListener("resize", () => {
    clearTimeout(pinFitTimer);
    pinFitTimer = setTimeout(syncPinHeight, 80);
  });
  if (window.ResizeObserver) {
    const pin = $("#pinStack");
    if (pin) new ResizeObserver(syncPinHeight).observe(pin);
  }
  syncPinHeight();

  let spyRaf = 0;
  const onScrollSpy = () => {
    if (spyRaf) return;
    spyRaf = requestAnimationFrame(() => {
      spyRaf = 0;
      syncPinHeight();
      syncScrollSpy();
    });
  };
  // Document is the scroller; bind the real scrollingElement too (Safari).
  const spyOpts = { passive: true, capture: true };
  window.addEventListener("scroll", onScrollSpy, spyOpts);
  document.addEventListener("scroll", onScrollSpy, spyOpts);
  document.scrollingElement?.addEventListener("scroll", onScrollSpy, spyOpts);
  document.documentElement.addEventListener("scroll", onScrollSpy, spyOpts);
  requestAnimationFrame(() => {
    syncPinHeight();
    syncScrollSpy();
  });
}

boot();
