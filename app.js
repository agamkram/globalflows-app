/** GlobalFlows UI — reads snapshot.json + regime-today.json bake */

import { buildMeaning } from "./meaning.js?v=20260904bh";

const $ = (sel, el = document) => el.querySelector(sel);

/** iOS lets the document scroll under dialogs unless body is position:fixed. */
let scrollLockY = 0;
function lockPageScroll() {
  if (document.body.classList.contains("dlg-open")) return;
  scrollLockY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.classList.add("dlg-open");
  document.body.style.top = `-${scrollLockY}px`;
}
function unlockPageScroll() {
  if ([...document.querySelectorAll("dialog.dlg-tap")].some((d) => d.open)) return;
  document.body.classList.remove("dlg-open");
  document.body.style.top = "";
  window.scrollTo(0, scrollLockY);
}

let SNAP = null;
/** Daily regime bake (spot-on lights + teach). Null if missing. */
let REGIME = null;

/** Global row view: values | charts. */
let globalView = "values";
/** Today-vs horizon (years) for table, charts, lights, and regime story. Default 2. */
let statHorizon = 2;
/** Markets sub-shelf when on Markets tab. */
let marketBucket = "all";
/** Last prints overlaid on Markets Latest (z stays daily). */
let liveQuotes = {};
let livePulledAt = null;
let liveState = "idle";
let liveInflight = null;
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
  { id: "all", label: "All" },
  { id: "equities", label: "Equities" },
  { id: "credit", label: "Credit" },
  { id: "duration", label: "Duration" },
  { id: "metals", label: "Metals" },
  { id: "energy", label: "Energy" },
  { id: "ag", label: "Ag" },
  { id: "crypto", label: "Crypto" },
];

const COMPARE_MAX = 10;

/** Series ids flipped from the global view (tap a row’s data/chart cell). */
const rowFlip = new Set();
const histCache = new Map();
const COLSPAN_DATA = 3;

function chartDuration() {
  return `${statHorizon}y`;
}

function horizonStats(s, years = statHorizon) {
  if (years === 1) return { z: s.z1y, pct: s.pct1y, label: "1y" };
  if (years === 5) return { z: s.z5y, pct: s.pct5y, label: "5y" };
  return { z: s.z2y, pct: s.pct2y, label: "2y" };
}

function median(arr) {
  if (!arr?.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function lightStateFromScore(score) {
  if (score == null || !Number.isFinite(score)) return { state: "empty", score: null };
  if (score > 0.45) return { state: "easing", score };
  if (score < -0.45) return { state: "tight", score };
  return { state: "neutral", score };
}

/**
 * Active view: SNAP with lights + disagreements recomputed for statHorizon.
 * Same-window score: mean(sign×zNy, flipped Ny %ile) → club median.
 */
function viewOf(snap) {
  if (!snap) return null;
  const lights = buildLights(snap, statHorizon);
  return {
    ...snap,
    lights,
    disagreements: buildDisagreements(snap, lights, statHorizon),
  };
}

function fmtAsOf(d) {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return d;
  return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
}

/** Search key for detail — not shown in table rows (keeps rows single-line). */
function seriesSub(s) {
  const key = s.sub || s.search || s.id;
  return s.freshness === "lagged" ? `${key} · lagged` : key;
}

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
  const onMarkets = activeLayer === "markets" && comparePhase === "off";
  if (cluster) cluster.hidden = !onMarkets;
  const age = $("#marketsAge");
  if (age) {
    age.textContent = onMarkets ? fmtLiveAge(livePulledAt) : "";
  }
  const refresh = $("#btnMarketsLive");
  if (refresh) {
    refresh.disabled = liveState === "loading";
    refresh.classList.toggle("is-loading", liveState === "loading");
  }
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
      if (SNAP) refreshViews();
      else syncMarketsLiveUi();
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

/** % change from first → last of a history slice (chosen duration). */
function windowPctChange(points) {
  if (!points || points.length < 2) return null;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  if (first === 0) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

function fmtChg(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const dig = abs >= 100 ? 0 : 1;
  return `${n >= 0 ? "+" : ""}${n.toFixed(dig)}%`;
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

const LIGHT_BLURB = {
  liquidity:
    "Cause — is cash entering or leaving the system? Tightening = draining; easing = cash returning. Tap members to see the Fed sheet pieces that voted.",
  rates:
    "Borrowing costs — policy rate, short yields, mortgages, the dollar, rate volatility. Easy = cheap to fund; tight = expensive to fund or a strong dollar fighting it.",
  growth:
    "Real activity — jobs, claims, weekly/monthly activity, spending, copper. Strong = holding up; soft = cooling. Separate from inflation.",
  inflation:
    "Underlying prices — core measures, median, sticky prices, expectations. Hot = pressure up; cold = fading. Headlines can disagree; that shows as a flag.",
  risk:
    "Market fear — vol, credit spreads, financial conditions. On = fear is cheap; off = fear is expensive. Often last to move.",
};

/** Which light dial is selected (blue border). Table shows that light’s full Street shelf. */
let focusLight = "liquidity";

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

/** Tabs that remain as doors (no light owns them). */
const STREET_TABS = new Set(["all", "fx", "markets"]);

let activeLayer = "liquidity";
/** All-view scroll spy: which street section is in view (layer id). */
let scrollStreet = null;

function bakeLight(id, years = statHorizon) {
  return REGIME?.horizons?.[String(years)]?.lights?.[id] || null;
}

function plainStory(snap) {
  const div = document.createElement("div");
  div.innerHTML = regimeStoryHtml(snap);
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function renderRegimeToday() {
  const el = $("#regimeToday");
  if (!el || !SNAP) return;
  try {
    const snap = viewOf(SNAP);
    const verified = REGIME?.verdict === "SPOT ON";
    const line = plainStory(snap);
    if (!line) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    const kicker = verified
      ? `Today · ${statHorizon}y · verified`
      : `Today · ${statHorizon}y`;
    el.innerHTML = `<span class="regime-kicker">${escapeHtml(kicker)}</span>${escapeHtml(line)}`;
  } catch (err) {
    console.warn("renderRegimeToday failed", err);
  }
}

function selectLight(id) {
  if (!SNAP || !id) return;
  const snap = viewOf(SNAP);
  if (!snap.lights?.[id]) {
    console.warn("selectLight: missing light", id);
    return;
  }
  focusLight = id;
  activeLayer = LIGHT_TO_TAB[id] || id;
  scrollStreet = null;
  if (comparePhase !== "pick") {
    comparePhase = "off";
    compareList = [];
    compareActiveSlot = null;
    clubSavedAs = null;
  }
  refreshViews();
}

function openLightSheet(id) {
  if (!SNAP || !id) return;
  const snap = viewOf(SNAP);
  const L = snap.lights?.[id];
  if (!L) {
    console.warn("openLightSheet: missing light", id, Object.keys(snap.lights || {}));
    return;
  }

  const h = `${statHorizon}y`;
  const baked = bakeLight(id);
  const word = wordFor(L);
  const titleEl = $("#lightTitle");
  const bodyEl = $("#lightBody");
  const dlg = $("#dlgLight");
  if (!titleEl || !bodyEl || !dlg) {
    console.warn("openLightSheet: dialog nodes missing");
    return;
  }
  titleEl.textContent = `${L.label || id} · ${word}`;
  const members = (L.members || [])
    .map((mid) => snap.series?.[mid])
    .filter(Boolean);
  const rows = members
    .map((s) => {
      const { z } = horizonStats(s);
      return `<tr data-mid="${s.id}">
        <td>${escapeHtml(s.name)}</td>
        <td>${fmt(s.latest)}</td>
        <td class="${zClass(z)}">${fmtZ(z)}</td>
        <td class="muted">${fmtAsOf(s.asOf)}</td>
      </tr>`;
    })
    .join("");
  const score =
    L.score != null && Number.isFinite(L.score)
      ? `${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)}`
      : "—";
  const teach = baked?.teach
    ? `<p class="light-teach">${escapeHtml(baked.teach)}</p>`
    : `<p>${escapeHtml(LIGHT_BLURB[id] || "")}</p>`;
  bodyEl.innerHTML = `
    ${teach}
    <p><strong>${escapeHtml(word)}</strong>
      · score ${score}
      · n=${L.n ?? members.length}
      ${L.z != null ? `· agg ${h} z ${fmtZ(L.z)}` : ""}
      ${L.pct != null ? `· agg ${h} percentile ${fmtPct(L.pct)}` : ""}
    </p>
    <h4>Who voted</h4>
    <div class="light-members">
      <table>
        <thead><tr><th>Name</th><th>Latest</th><th>${h} z</th><th>As-of</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">no members</td></tr>`}</tbody>
      </table>
    </div>
    <p class="muted tiny">Score = median of member scores (signed ${h} z + ${h} percentile); &gt;+0.45 / &lt;−0.45 paints the word. Full formula in About.</p>
  `;
  try {
    if (!dlg.open) dlg.showModal();
    lockPageScroll();
  } catch (err) {
    console.warn("openLightSheet: showModal failed", err);
  }
}

function lightState(snap, id) {
  return snap.lights?.[id]?.state || "empty";
}

/** Tensions that belong on the teach sheet when not already baked into the story. */
const TEACH_TENSION_ORDER = ["liquidity_vs_gold", "liquidity_vs_btc"];

function hasDisagreement(snap, kind) {
  return (snap.disagreements || []).some((d) => d.kind === kind);
}

function disagreement(snap, kind) {
  return (snap.disagreements || []).find((d) => d.kind === kind) || null;
}

/** Member score: sign × Ny z blended with flipped Ny %ile (same window as 1·2·5). */
function memberLightScore(m, lid, years = statHorizon) {
  if (!m) return null;
  const sign = m.sign ?? 0;
  const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
  const { z, pct } = horizonStats(m, years);
  const parts = [];
  if (z != null && Number.isFinite(z)) parts.push(z * s);
  if (pct != null && Number.isFinite(pct)) {
    const p = s < 0 ? 1 - pct : pct;
    parts.push((p - 0.5) * 3);
  }
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function buildLights(snap, years = statHorizon) {
  const meta = snap.lightsMeta || [];
  const baked = snap.lights || {};
  const lightIds = ["liquidity", "rates", "growth", "inflation", "risk"];
  const out = {};
  for (const lid of lightIds) {
    const memberIds =
      baked[lid]?.members ||
      Object.values(snap.series || {})
        .filter((r) => r.light === lid && r.status === "ok")
        .map((r) => r.id);
    const members = memberIds
      .map((id) => snap.series?.[id])
      .filter((m) => m && m.status === "ok");
    const scores = [];
    const signedZs = [];
    const signedPcts = [];
    for (const m of members) {
      const sc = memberLightScore(m, lid, years);
      if (sc == null || !Number.isFinite(sc)) continue;
      const w = Math.max(1, Math.round(m.weight || 1));
      for (let i = 0; i < w; i++) scores.push(sc);
      const sign = m.sign ?? 0;
      const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
      const { z, pct } = horizonStats(m, years);
      if (z != null && Number.isFinite(z)) signedZs.push(z * s);
      if (pct != null && Number.isFinite(pct)) {
        signedPcts.push(s < 0 ? 1 - pct : pct);
      }
    }
    const score = scores.length ? median(scores) : null;
    const { state } = lightStateFromScore(score);
    const m = meta.find((x) => x.id === lid) || baked[lid];
    out[lid] = {
      id: lid,
      label: m?.label || baked[lid]?.label || lid,
      state,
      score,
      z: signedZs.length ? median(signedZs) : null,
      pct: signedPcts.length ? median(signedPcts) : null,
      n: members.length,
      words: {
        easing: m?.easing || baked[lid]?.words?.easing,
        neutral: m?.neutral || baked[lid]?.words?.neutral,
        tight: m?.tight || baked[lid]?.words?.tight,
      },
      members: memberIds,
    };
  }
  return out;
}

function seriesZ(snap, id, years) {
  const s = snap.series?.[id];
  if (!s) return null;
  return horizonStats(s, years).z;
}

/** Live cross-checks for the selected horizon (not the ingest-baked list). */
function buildDisagreements(snap, lights, years = statHorizon) {
  const liq = lights.liquidity;
  const risk = lights.risk;
  const growth = lights.growth;
  const infl = lights.inflation;
  const goldZ = seriesZ(snap, "GOLD", years);
  const btcZ = seriesZ(snap, "BTC", years);
  const headZ = seriesZ(snap, "CPIAUCSL", years);
  const coreZ = seriesZ(snap, "CPILFESL", years);
  const disagreements = [];
  if (liq?.state && goldZ != null) {
    if (liq.state === "easing" && goldZ < -0.3) {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity easing, gold not confirming",
      });
    }
    if (liq.state === "tight" && goldZ > 0.3) {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity tightening, gold firm anyway",
      });
    }
  }
  if (liq?.state && btcZ != null) {
    if (liq.state === "easing" && btcZ < -0.3) {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity easing, BTC not confirming",
      });
    }
    if (liq.state === "tight" && btcZ > 0.3) {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity tightening, BTC firm anyway",
      });
    }
  }
  if (liq?.state === "tight" && risk?.state === "easing") {
    disagreements.push({
      kind: "liquidity_vs_risk",
      text: "Liquidity tightening, risk still on",
    });
  }
  if (liq?.state === "easing" && risk?.state === "tight") {
    disagreements.push({
      kind: "liquidity_vs_risk",
      text: "Liquidity easing, risk still off",
    });
  }
  if (headZ != null && coreZ != null && headZ > 0.45 && coreZ < -0.45) {
    disagreements.push({
      kind: "inflation_headline_vs_core",
      text: "Headline CPI hot, core cold",
    });
  } else if (headZ != null && coreZ != null && headZ < -0.45 && coreZ > 0.45) {
    disagreements.push({
      kind: "inflation_headline_vs_core",
      text: "Headline CPI cold, core hot",
    });
  }
  if (growth?.state === "easing" && infl?.state === "tight") {
    disagreements.push({
      kind: "growth_vs_inflation",
      text: "Growth strong, inflation cold",
    });
  }
  if (growth?.state === "tight" && infl?.state === "easing") {
    disagreements.push({
      kind: "growth_vs_inflation",
      text: "Growth soft, inflation hot",
    });
  }
  return disagreements;
}

function lightMemberScores(snap, lid) {
  const members = snap.lights?.[lid]?.members || [];
  return members
    .map((id) => {
      const m = snap.series?.[id];
      const score = memberLightScore(m, lid);
      const { z } = horizonStats(m || {});
      return m && score != null && Number.isFinite(score)
        ? { id, name: m.name, score, latest: m.latest, z }
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
    return `Borrowing is <strong data-state="neutral">split</strong>: market rates still look expensive, while policy and the dollar look easier`;
  }
  return {
    easing: `Borrowing costs look <strong data-state="easing">easy</strong>`,
    tight: `Borrowing costs look <strong data-state="tight">expensive</strong>`,
    neutral: `Borrowing costs look <strong data-state="neutral">mixed</strong>`,
    empty: "",
  }[st];
}

function horizonPhrase(years = statHorizon) {
  if (years === 1) return "Over the past year";
  if (years === 5) return "Over the past five years";
  return "Over the past two years";
}

/**
 * Regime box: short editorial from light states + tensions.
 * Relations and splits — not a rewording of the five dial labels.
 * Leads with the active clock in plain language.
 */
function regimeStoryHtml(snap) {
  const liq = lightState(snap, "liquidity");
  const gr = lightState(snap, "growth");
  const inf = lightState(snap, "inflation");
  const risk = lightState(snap, "risk");

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
    growthBit = `the real growth has looked <strong data-state="easing">firm</strong> while inflation pressure is still <strong data-state="easing">high</strong>`;
  } else if (gr === "easing" && inf === "neutral") {
    growthBit = `the real growth has still looked <strong data-state="easing">firm</strong> while inflation has looked <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "tight" && inf === "easing") {
    growthBit = headColdCoreHot
      ? `the real growth has looked <strong data-state="tight">soft</strong> while underlying inflation is still <strong data-state="easing">hot</strong> — even if the overall CPI print looks cooler`
      : `the real growth has looked <strong data-state="tight">soft</strong> while inflation is still <strong data-state="easing">hot</strong>`;
  } else if (gr === "tight" && inf === "tight") {
    growthBit = `the real growth has looked <strong data-state="tight">soft</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else if (gr === "tight" && inf === "neutral") {
    growthBit = `the real growth has looked <strong data-state="tight">soft</strong> while inflation has looked <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "neutral" && inf === "easing") {
    growthBit = `growth has looked <strong data-state="neutral">mixed</strong> while inflation is still <strong data-state="easing">hot</strong>`;
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

  return `${horizonPhrase()}, ${s1}.${s2}`;
}

function buildSentence(snap) {
  return regimeStoryHtml(snap);
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
    beats.push(`Growth: activity firm and underlying inflation still hot — both dials lean the same way.`);
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
    const headZ = horizonStats(head || {}).z;
    const coreZ = horizonStats(core || {}).z;
    const h = `${statHorizon}y`;
    if (/headline.*hot/i.test(d?.text || "")) {
      beats.push(
        `Prices split: overall CPI still looks hot${headZ != null ? ` (${h} z ${fmtZ(headZ)})` : ""}; the Inflation light votes underlying/core${coreZ != null ? ` (${h} z ${fmtZ(coreZ)})` : ""}.`
      );
    } else {
      beats.push(
        `Prices split: overall CPI looks cooler than underlying/core — the light follows the underlying.`
      );
    }
  }

  const vix = series.VIX;
  const hy = series.BAMLH0A0HYM2;
  if (risk === "easing") {
    beats.push(
      vix?.latest != null
        ? `Fear: vol and credit are quiet (VIX ${fmtLightNum(vix.latest, 1)}${hy?.latest != null ? `, HY OAS ${fmtLightNum(hy.latest, 2)}` : ""}).`
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
    const dgs2 = series.DGS2;
    const ff = series.DFEDTARU;
    const bits = [];
    if (dgs2?.latest != null) bits.push(`2y ${fmtLightNum(dgs2.latest, 2)}%`);
    if (ff?.latest != null) bits.push(`Fed funds ${fmtLightNum(ff.latest, 2)}%`);
    beats.push(
      bits.length
        ? `Borrowing split: market rates still high (${bits.join(", ")}), while policy and the dollar lean easier.`
        : `Borrowing split: some rate voters still look expensive, others (policy, dollar) look easier.`
    );
  } else {
    const st = lightState(snap, "rates");
    if (st === "easing") {
      beats.push(`Borrowing: short rates, mortgages, and the dollar look easy overall.`);
    } else if (st === "tight") {
      beats.push(`Borrowing: short rates, mortgages, or the dollar look expensive overall.`);
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
    default:
      return (d.text || "").replace(/\.$/, "").trim();
  }
}

function openSentence(snap) {
  if (!snap) return;
  const baked =
    REGIME?.verdict === "SPOT ON" ? REGIME.horizons?.[String(statHorizon)]?.lights : null;
  const meaning = buildMeaning(snap, statHorizon);

  const evidence = baked
    ? ["liquidity", "rates", "growth", "inflation", "risk"]
        .map((id) => baked[id]?.teach)
        .filter(Boolean)
        .map(
          (line) =>
            `<div class="sent-explain"><p class="sent-explain-title">${escapeHtml(line)}</p></div>`
        )
        .join("")
    : regimeEvidence(snap)
        .map(
          (line) =>
            `<div class="sent-explain"><p class="sent-explain-title">${escapeHtml(line)}</p></div>`
        )
        .join("");

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
          `<div class="sent-explain sent-explain-flag"><p class="sent-explain-title"><strong data-state="neutral">Watch</strong>
          <span class="muted sent-hint"> — ${escapeHtml(line.replace(/^Falsify if /i, "Falsify if "))}</span></p></div>`
      )
      .join("")}`;

  const verified =
    REGIME?.verdict === "SPOT ON"
      ? `<p class="muted tiny sent-foot">Verified bake · ${statHorizon}y · tap a light for who voted.</p>`
      : `<p class="muted tiny sent-foot">Tap a light for who voted.</p>`;

  $("#sentenceBody").innerHTML = `
    <p class="sent-story">${regimeStoryHtml(snap)}</p>
    ${soWhat}
    <p class="sent-kicker">Why we say that</p>
    ${evidence}
    ${watch}
    ${verified}
  `;
  const dlg = $("#dlgSentence");
  if (!dlg) return;
  try {
    if (!dlg.open) dlg.showModal();
    lockPageScroll();
  } catch (err) {
    console.warn("openSentence: showModal failed", err);
  }
  requestAnimationFrame(() => {
    dlg.scrollTop = 0;
    const body = $("#sentenceBody");
    if (body) body.scrollTop = 0;
  });
}

function renderLights(snap) {
  const root = $("#lights");
  if (!root) return;
  const order = ["liquidity", "rates", "growth", "inflation", "risk"];
  const spyLight =
    activeLayer === "all" && comparePhase === "off" && scrollStreet
      ? TAB_TO_LIGHT[scrollStreet] || null
      : null;
  root.innerHTML = order
    .map((id) => {
      const L = snap.lights?.[id] || { state: "empty", label: id };
      const score =
        L.score != null && Number.isFinite(L.score)
          ? `${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)}`
          : "—";
      const on =
        spyLight != null ? spyLight === id : focusLight === id;
      return `<button type="button" class="light" data-state="${L.state || "empty"}" data-id="${id}" data-focus="${
        on ? "true" : "false"
      }" aria-pressed="${on ? "true" : "false"}">
        <span class="dot" aria-hidden="true"></span>
        <span class="lbl">${escapeHtml(L.label || id)}</span>
        <span class="word">${escapeHtml(wordFor(L))}</span>
        <span class="score">${escapeHtml(score)}</span>
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
}



function fitTabs() {
  const tabs = $("#tabs");
  if (!tabs) return;
  const buttons = [...tabs.querySelectorAll("button")];
  if (!buttons.length) return;

  const apply = (px) => {
    for (const b of buttons) {
      b.style.fontSize = `${px}px`;
      b.style.paddingLeft = px < 10 ? "1px" : "2px";
      b.style.paddingRight = px < 10 ? "1px" : "2px";
      b.style.letterSpacing = px < 10 ? "-0.04em" : "-0.02em";
    }
  };

  const overflowing = () =>
    tabs.scrollWidth > tabs.clientWidth + 1 ||
    buttons.some((b) => b.scrollWidth > b.clientWidth + 1);

  // One row, full labels: shrink type until nothing clips.
  let size = 11.5;
  const min = 7.5;
  apply(size);
  while (size > min && overflowing()) {
    size -= 0.25;
    apply(size);
  }
}

function renderTabs(snap) {
  const tabs = $("#tabs");
  const layers = (snap.layers || []).filter((l) => STREET_TABS.has(l.id));
  const items = [{ id: "all", label: "All", blurb: "Full book" }, ...layers];
  tabs.innerHTML = items
    .map((l) => {
      const full = l.label || l.id;
      return `<button type="button" role="tab" data-layer="${l.id}" title="${escapeHtml(
        full
      )}" aria-selected="${
        !focusLight && l.id === activeLayer ? "true" : "false"
      }">${escapeHtml(full)}</button>`;
    })
    .join("");
  tabs.onclick = (e) => {
    const b = e.target.closest("button[data-layer]");
    if (!b) return;
    activeLayer = b.dataset.layer;
    focusLight = null;
    scrollStreet = null;
    // Keep picks when browsing streets to build a club; wipe only outside pick.
    if (comparePhase !== "pick") {
      exitCompareToStreets();
    }
    syncStreetSelection();
    refreshViews();
  };
  requestAnimationFrame(() => {
    fitTabs();
    requestAnimationFrame(fitTabs);
    syncMarketsLiveUi();
  });
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
      const d = order.indexOf(a.layer) - order.indexOf(b.layer);
      return d || sortSeries(a, b);
    });
  }

  if (layer === "markets") {
    all = all.filter(isMarketsSeries);
    if (marketBucket !== "all") {
      all = all.filter((s) => s.marketBucket === marketBucket);
    }
    return all.sort(sortSeries);
  }

  return all.filter((s) => s.layer === layer).sort(sortSeries);
}

function renderMarketBuckets() {
  const el = $("#marketBuckets");
  if (!el) return;
  const show =
    !focusLight &&
    activeLayer === "markets" &&
    comparePhase === "off";
  el.hidden = !show;
  if (!show) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = MARKET_BUCKETS.map(
    (b) =>
      `<button type="button" class="btn tiny-btn" data-bucket="${b.id}" aria-pressed="${
        marketBucket === b.id ? "true" : "false"
      }">${b.label}</button>`
  ).join("");
  el.onclick = (e) => {
    const b = e.target.closest("[data-bucket]");
    if (!b) return;
    marketBucket = b.dataset.bucket;
    refreshViews();
  };
  syncMarketsLiveUi();
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
  const spyTab =
    activeLayer === "all" &&
    comparePhase === "off" &&
    (scrollStreet === "fx" || scrollStreet === "markets")
      ? scrollStreet
      : null;
  [...tabs.querySelectorAll("button[data-layer]")].forEach((x) => {
    const layer = x.dataset.layer;
    const on = !focusLight && layer === activeLayer;
    x.setAttribute("aria-selected", on ? "true" : "false");
    x.dataset.scrollOn = spyTab && layer === spyTab ? "true" : "false";
  });
}

/** All only: which street block is under the read line → light / FX·Markets button. */
function syncScrollSpy() {
  if (activeLayer !== "all" || comparePhase !== "off") {
    if (scrollStreet != null) {
      scrollStreet = null;
      applyScrollSpyUi();
    }
    return;
  }
  const rows = [...document.querySelectorAll("#heatBody tr[data-street]")];
  if (!rows.length) return;

  const pin = $("#pinStack");
  const pinBottom = pin?.getBoundingClientRect().bottom ?? 0;
  // Read line just under the stuck pin (or under where the pin sits in flow).
  const probe = Math.max(pinBottom, 0) + 4;
  let current = rows[0].dataset.street || null;
  for (const tr of rows) {
    if (tr.getBoundingClientRect().top <= probe) {
      current = tr.dataset.street || current;
    } else {
      break;
    }
  }
  scrollStreet = current;
  applyScrollSpyUi();
}

function applyScrollSpyUi() {
  if (!SNAP) return;
  const onAll = activeLayer === "all" && comparePhase === "off";
  const spyLight =
    onAll && scrollStreet ? TAB_TO_LIGHT[scrollStreet] || null : null;
  document.querySelectorAll("#lights .light[data-id]").forEach((el) => {
    const on = spyLight != null ? el.dataset.id === spyLight : focusLight === el.dataset.id;
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
  renderMarketBuckets();
  syncStreetSelection();
  syncCompareBtn();
  renderRegimeToday();
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
        Number(b.dataset.horizon) === statHorizon ? "true" : "false"
      );
    });
  }
}

function valuesCells(s) {
  if (s.status !== "ok" || s.latest == null) {
    return `<td colspan="${COLSPAN_DATA}" class="empty">empty — ${escapeHtml(s.error || "no data")}</td>`;
  }
  const { z, pct } = horizonStats(s);
  const live = liveQuote(s);
  const latest = live ? live.price : s.latest;
  return `<td><span class="cell-heat"${live ? ' data-live="1"' : ""}>${fmt(latest)}</span></td>
    <td class="${zClass(z)}">${fmtZ(z)}</td>
    <td><span class="cell-heat" style="background:${heatBg(pct)}">${fmtPct(pct)}</span></td>`;
}

function chartCell(s) {
  return `<td class="chart-cell" colspan="${COLSPAN_DATA}">
    <div class="spark-wrap" data-spark="${s.id}">
      <canvas class="spark" width="600" height="36" aria-hidden="true"></canvas>
      <span class="spark-chg muted" aria-hidden="true"></span>
      <span class="spark-msg muted">…</span>
    </div>
  </td>`;
}

function renderThead(rows) {
  const thead = $("#heat thead tr");
  const colhead = $("#heatColhead");
  if (!thead) return;
  const h = `${statHorizon}y`;
  // Colhead follows global view mode — not whether a single row is flipped.
  const charts = globalView === "charts";
  if (charts) {
    thead.innerHTML = `<th>Name</th><th colspan="${COLSPAN_DATA}">Chart · ${h.toUpperCase()}</th>`;
    if (colhead) {
      colhead.innerHTML = `<span>Name</span><span class="heat-colhead-span">Chart · ${h.toUpperCase()}</span>`;
      colhead.dataset.mode = "charts";
    }
  } else {
    thead.innerHTML = `<th>Name</th>
      <th>Latest</th><th>${h} z</th>
      <th>${h} <span class="th-abbr">%ile</span><span class="th-full">percentile</span></th>`;
    if (colhead) {
      colhead.innerHTML = `<span>Name</span><span>Latest</span><span>${h} z</span><span>${h} %ile</span>`;
      colhead.dataset.mode = "values";
    }
  }
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
        ? { label: "All series" }
        : { label: activeLayer });
  }
  $("#layerTitle").textContent = layerMeta.label || activeLayer;
  const hint = $("#streetHint");
  if (hint) {
    const showHint =
      comparePhase === "off" &&
      !!focusLight &&
      streetId !== "all" &&
      streetId !== "fx" &&
      streetId !== "markets" &&
      !!TAB_TO_LIGHT[streetId];
    hint.hidden = !showHint;
    if (showHint) {
      hint.dataset.light = focusLight || TAB_TO_LIGHT[streetId];
    } else {
      delete hint.dataset.light;
    }
  }
  syncMarketsLiveUi();

  const body = $("#heatBody");
  const rows = seriesList(snap, streetId);
  renderThead(rows);

  body.innerHTML = rows
    .map((s) => {
      const view = rowView(s.id);
      const data =
        view === "charts" ? chartCell(s) : valuesCells(s);
      const voter = s.light || "";
      const picked = compareList.includes(s.id);
      const street = s.layer || s.street || "";
      return `<tr data-id="${s.id}" data-view="${view}"${
        street ? ` data-street="${escapeHtml(street)}"` : ""
      }${voter ? ` data-voter="${escapeHtml(voter)}"` : ""}${
        picked && comparePhase === "pick" ? ` data-compare="1"` : ""
      }>
        <td class="name-cell"><span class="name-stack"><span class="name">${escapeHtml(s.name)}</span><span class="sub">${escapeHtml(seriesSub(s))}</span></span></td>
        ${data}
      </tr>`;
    })
    .join("");

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
      const sliced = sliceDuration(hist.points, dur);
      if (!sliced.length) {
        if (msg) msg.textContent = `no ${dur} data`;
        if (chgEl) {
          chgEl.textContent = "";
          chgEl.removeAttribute("data-dir");
        }
        return;
      }
      drawSpark(canvas, sliced);
      const chg = windowPctChange(sliced);
      if (chgEl) {
        chgEl.textContent = fmtChg(chg);
        chgEl.title = `${dur} change`;
        if (chg == null || !Number.isFinite(chg)) chgEl.removeAttribute("data-dir");
        else if (chg > 0) chgEl.dataset.dir = "up";
        else if (chg < 0) chgEl.dataset.dir = "down";
        else chgEl.dataset.dir = "flat";
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
  const voter = s.light || null;
  const home = voter ? LIGHT_TO_TAB[voter] : null;
  const street = s.street || s.layer || "";
  const cross = voter && home && street && street !== home;
  const lightLabel = SNAP?.lights?.[voter]?.label || voter;
  const voteLine = voter
    ? `<p class="series-vote">Votes the <strong>${escapeHtml(
        lightLabel
      )}</strong> light${
        cross
          ? ` · lives on ${escapeHtml(street)}, club is usually under ${escapeHtml(
              home
            )}`
          : ""
      }</p>`
    : `<p class="series-vote muted">Does not vote a regime light — book / output line.</p>`;
  const live = liveQuote(s);
  const latest = live ? live.price : s.latest;
  $("#seriesBody").innerHTML = `
    <div class="series-sheet">
      ${s.note ? `<p class="series-blurb">${escapeHtml(s.note)}</p>` : ""}
      ${voteLine}
      <p class="series-meta"><code>${escapeHtml(code)}</code> · ${escapeHtml(street || "")} · ${escapeHtml(s.freq || "?")}</p>
      <dl class="series-stats">
        <div><dt>Latest</dt><dd>${
          latest == null ? "empty" : fmt(latest)
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
        <div><dt>z</dt><dd>1y ${fmtZ(s.z1y)} · 2y ${fmtZ(s.z2y)} · 5y ${fmtZ(s.z5y)}</dd></div>
        <div><dt>Percentile</dt><dd>1y ${fmtPct(s.pct1y)} · 2y ${fmtPct(s.pct2y)} · 5y ${fmtPct(s.pct5y)}</dd></div>
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
    if (!dlg.open) dlg.showModal();
    lockPageScroll();
  } catch (err) {
    console.warn("openSeries: showModal failed", err);
  }
}

function renderFormula(snap) {
  const el = $("#formulaBody");
  if (!el) return;
  const h = `${statHorizon}y`;
  el.innerHTML = `
    <p>Per light: median of member scores (each = mean of sign×${h} z and flipped ${h} percentile). The 1·2·5 control sets that window for lights, the table, and charts. Clubs are small complementary sets; Street table keeps the rest. Score &gt;+0.45 / &lt;−0.45 paints the word. Inflation upside = hot.</p>
    <p><strong>Net liquidity:</strong> <code>${escapeHtml(snap.formula?.netLiquidity || "WALCL(bn) − TGA − ON RRP")}</code></p>
    <p><strong>Stock–bond corr:</strong> <code>${escapeHtml(snap.formula?.stockBondCorr || "")}</code></p>
    <p class="muted">Per-series sign flips “higher” into easing vs tightening for that light. Inflation light treats upside as hot.</p>
  `;
}

function renderAboutMeta(snap) {
  const ingest = $("#aboutIngest");
  const coverage = $("#aboutCoverage");
  if (!ingest && !coverage) return;
  const d = new Date(snap.generatedAt);
  const when = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const vals = Object.values(snap.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale");
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;
  if (ingest) {
    ingest.textContent = `Last ingest ${when} — when public series were last pulled (not each row’s as-of).`;
  }
  if (coverage) {
    const staleNames = stale.map((s) => s.name || s.id).join(", ");
    coverage.textContent = stale.length
      ? `${ok} live in table · ${stale.length} stale hidden (${staleNames})${empty ? ` · ${empty} empty` : ""}`
      : `${ok} live series${empty ? ` · ${empty} empty` : ""}`;
  }
}

async function boot() {
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
  renderRegimeToday();
  pullMarketsLive();
  setInterval(syncMarketsLiveUi, 15000);

  try {
    const rr = await fetch("./regime-today.json", { cache: "no-store" });
    if (rr.ok) {
      REGIME = await rr.json();
      renderRegimeToday();
    }
  } catch (_) {
    /* bake optional until first npm run bake:regime */
  }

  document.querySelectorAll("dialog.dlg-tap").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener("close", () => {
      unlockPageScroll();
    });
  });

  syncViewControls();
  $("#btnMarketsLive")?.addEventListener("click", () => {
    pullMarketsLive(true);
  });
  $("#streetHint")?.addEventListener("click", () => {
    const id = $("#streetHint")?.dataset.light || focusLight;
    if (id) openLightSheet(id);
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
    const next = Number(b.dataset.horizon);
    if (![1, 2, 5].includes(next)) return;
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

  $("#regimeToday")?.addEventListener("click", () => {
    if (!SNAP) return;
    openSentence(viewOf(SNAP));
  });

  let tabFitTimer = 0;
  const syncPinHeight = () => {
    const pin = $("#pinStack");
    if (!pin) return;
    // Match the stuck pin's bottom edge — offsetHeight alone was short, so
    // row .sub lines peeked under the series title while scrolling.
    const top = pin.getBoundingClientRect().top;
    const bottom = pin.getBoundingClientRect().bottom;
    const pinned = Math.max(0, Math.ceil(bottom - Math.min(top, 0)));
    document.documentElement.style.setProperty("--pin-h", `${pinned}px`);
  };
  window.addEventListener("resize", () => {
    clearTimeout(tabFitTimer);
    tabFitTimer = setTimeout(() => {
      fitTabs();
      syncPinHeight();
    }, 80);
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
