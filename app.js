/** GlobalFlows UI — reads snapshot.json */

const $ = (sel, el = document) => el.querySelector(sel);

let SNAP = null;
let activeLayer = "liquidity";

/** Global row view: values | charts. */
let globalView = "values";
/** Today-vs horizon (years) for table, charts, lights, and regime story. Default 2. */
let statHorizon = 2;
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

const LIGHT_BLURB = {
  liquidity:
    "Cause — is cash entering or leaving the system? Tightening = draining; easing = cash returning. Tap members to see the Fed sheet pieces that voted.",
  transmission:
    "Borrowing costs — policy rate, short yields, mortgages, the dollar, rate volatility. Easy = cheap to fund; tight = expensive to fund or a strong dollar fighting it.",
  growth:
    "Real activity — jobs, claims, weekly/monthly activity, spending, copper. Strong = holding up; soft = cooling. Separate from inflation.",
  inflation:
    "Underlying prices — core measures, median, sticky prices, expectations. Hot = pressure up; cold = fading. Headlines can disagree; that shows as a flag.",
  risk:
    "Market fear — vol, credit spreads, financial conditions. On = fear is cheap; off = fear is expensive. Often last to move.",
};

const LIGHT_TO_TAB = {
  liquidity: "liquidity",
  transmission: "rates",
  growth: "economy",
  inflation: "inflation",
  risk: "conditions",
};

let pendingLightTab = null;

function jumpToStreetTab(tabId) {
  activeLayer = tabId || "all";
  const tabs = $("#tabs");
  if (tabs) {
    [...tabs.querySelectorAll("button")].forEach((x) =>
      x.setAttribute(
        "aria-selected",
        x.dataset.layer === activeLayer ? "true" : "false"
      )
    );
  }
  refreshViews();
  // Tab change only — keep viewport where it is / at top of series list
  const scroll = document.querySelector(".table-scroll");
  if (scroll) scroll.scrollTop = 0;
}

function openLight(id) {
  if (!SNAP) return;
  const snap = viewOf(SNAP);
  const L = snap.lights?.[id];
  if (!L) return;
  const h = `${statHorizon}y`;
  pendingLightTab = LIGHT_TO_TAB[id] || "all";
  const word = wordFor(L);
  $("#lightTitle").textContent = `${L.label || id} · ${word}`;
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
  $("#lightBody").innerHTML = `
    <p>${escapeHtml(LIGHT_BLURB[id] || "")}</p>
    <p><strong>${escapeHtml(word)}</strong>
      · score ${score}
      · n=${L.n ?? members.length}
      ${L.z != null ? `· agg ${h} z ${fmtZ(L.z)}` : ""}
      ${L.pct != null ? `· agg ${h} %ile ${fmtPct(L.pct)}` : ""}
    </p>
    <h4>Who voted</h4>
    <div class="light-members">
      <table>
        <thead><tr><th>Series</th><th>Latest</th><th>${h} z</th><th>As-of</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">no members</td></tr>`}</tbody>
      </table>
    </div>
    <p class="muted tiny">Score = median of member scores (signed ${h} z + ${h} %ile); &gt;+0.45 / &lt;−0.45 paints the word. Full formula in About.</p>
  `;
  $("#dlgLight").showModal();
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
  const lightIds = ["liquidity", "transmission", "growth", "inflation", "risk"];
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

function transmissionClause(snap) {
  const st = lightState(snap, "transmission");
  const split = clubSplit(snap, "transmission");
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

/**
 * Regime box: short editorial from light states + tensions.
 * Relations and splits — not a rewording of the five dial labels.
 */
function regimeStoryHtml(snap) {
  const liq = lightState(snap, "liquidity");
  const gr = lightState(snap, "growth");
  const inf = lightState(snap, "inflation");
  const risk = lightState(snap, "risk");

  const cash = {
    easing: `<strong data-state="easing">Cash is flowing back</strong> into the system`,
    tight: `<strong data-state="tight">Cash is leaving</strong> the system`,
    neutral: `Cash conditions look <strong data-state="neutral">steady</strong>`,
    empty: `Cash conditions are unclear`,
  }[liq];

  const headCore = disagreement(snap, "inflation_headline_vs_core");
  const headHotCoreCold = headCore && /headline.*hot/i.test(headCore.text || "");
  const headColdCoreHot = headCore && /headline.*cold/i.test(headCore.text || "");

  let economy;
  if (gr === "easing" && inf === "tight") {
    economy = headHotCoreCold
      ? `the real economy still looks <strong data-state="easing">firm</strong> and underlying inflation has <strong data-state="tight">cooled</strong> — even if the overall CPI print can look hotter`
      : `the real economy still looks <strong data-state="easing">firm</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else if (gr === "easing" && inf === "easing") {
    economy = `the real economy looks <strong data-state="easing">firm</strong> while inflation pressure is still <strong data-state="easing">high</strong>`;
  } else if (gr === "easing" && inf === "neutral") {
    economy = `the real economy still looks <strong data-state="easing">firm</strong> while inflation looks <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "tight" && inf === "easing") {
    economy = headColdCoreHot
      ? `the real economy looks <strong data-state="tight">soft</strong> while underlying inflation is still <strong data-state="easing">hot</strong> — even if the overall CPI print looks cooler`
      : `the real economy looks <strong data-state="tight">soft</strong> while inflation is still <strong data-state="easing">hot</strong>`;
  } else if (gr === "tight" && inf === "tight") {
    economy = `the real economy looks <strong data-state="tight">soft</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else if (gr === "tight" && inf === "neutral") {
    economy = `the real economy looks <strong data-state="tight">soft</strong> while inflation looks <strong data-state="neutral">mixed</strong>`;
  } else if (gr === "neutral" && inf === "easing") {
    economy = `growth looks <strong data-state="neutral">mixed</strong> while inflation is still <strong data-state="easing">hot</strong>`;
  } else if (gr === "neutral" && inf === "tight") {
    economy = headHotCoreCold
      ? `growth looks <strong data-state="neutral">mixed</strong> and underlying inflation has <strong data-state="tight">cooled</strong> — even if the overall CPI print can look hotter`
      : `growth looks <strong data-state="neutral">mixed</strong> and underlying inflation has <strong data-state="tight">cooled</strong>`;
  } else {
    economy = `growth and inflation both look <strong data-state="neutral">mixed</strong>`;
  }

  const fear = {
    easing: `market <strong data-state="easing">fear is low</strong>`,
    tight: `markets are <strong data-state="tight">paying up for fear</strong>`,
    neutral: `market fear looks <strong data-state="neutral">mixed</strong>`,
    empty: `market fear is unclear`,
  }[risk];

  const money = transmissionClause(snap);

  // Sentence 1: cash ↔ economy (and fear when it contrasts with cash)
  const cashVsGrowth =
    (liq === "tight" && gr === "easing") || (liq === "easing" && gr === "tight");
  const cashVsFear =
    (liq === "tight" && risk === "easing") || (liq === "easing" && risk === "tight");

  let s1;
  if (cashVsGrowth && cashVsFear) {
    s1 = `${cash}, but ${economy} — and ${fear}`;
  } else if (cashVsGrowth) {
    s1 = `${cash}, but ${economy}`;
  } else if (cashVsFear) {
    s1 = `${cash}, but ${fear}`;
  } else {
    s1 = `${cash}, and ${economy}`;
  }

  // Sentence 2: fear if not already in s1, then borrowing
  const parts2 = [];
  if (!cashVsFear && fear) parts2.push(fear.charAt(0).toUpperCase() + fear.slice(1));
  if (money) parts2.push(money);
  const s2 = parts2.length ? ` ${parts2.join(". ")}.` : "";

  return `${s1}.${s2}`;
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
        ? `Economy: activity still firm while underlying inflation cooled (core CPI YoY ${fmtLightNum(core.latest, 2)}%).`
        : `Economy: activity still firm while underlying inflation cooled.`
    );
  } else if (gr === "easing" && inf === "easing") {
    beats.push(`Economy: activity firm and underlying inflation still hot — both dials lean the same way.`);
  } else if (gr === "tight" && inf === "easing") {
    beats.push(`Economy: activity soft while underlying inflation still hot — an ugly mix.`);
  } else if (gr === "tight" && inf === "tight") {
    beats.push(`Economy: activity soft and underlying inflation cooled.`);
  } else {
    beats.push(
      `Economy: growth is ${wordFor(snap.lights?.growth).toLowerCase()}, inflation is ${wordFor(snap.lights?.inflation).toLowerCase()}.`
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

  const split = clubSplit(snap, "transmission");
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
    const st = lightState(snap, "transmission");
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
  const evidence = regimeEvidence(snap)
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

  $("#sentenceBody").innerHTML = `
    <p class="sent-story">${regimeStoryHtml(snap)}</p>
    <p class="sent-kicker">Why we say that</p>
    ${evidence}
    ${watch}
    <p class="muted tiny sent-foot">Tap a light for who voted.</p>
  `;
  const dlg = $("#dlgSentence");
  dlg.showModal();
  requestAnimationFrame(() => {
    dlg.scrollTop = 0;
    const body = $("#sentenceBody");
    if (body) body.scrollTop = 0;
  });
}

function renderLights(snap) {
  const root = $("#lights");
  const order = ["liquidity", "transmission", "growth", "inflation", "risk"];
  root.innerHTML = order
    .map((id) => {
      const L = snap.lights?.[id] || { state: "empty", label: id };
      const score =
        L.score != null && Number.isFinite(L.score)
          ? `${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)}`
          : "—";
      return `<article class="light" data-state="${L.state || "empty"}" data-id="${id}">
        <div class="dot" aria-hidden="true"></div>
        <div class="lbl">${L.label || id}</div>
        <div class="word">${wordFor(L)}</div>
        <div class="score">${score}</div>
      </article>`;
    })
    .join("");
}



function renderTabs(snap) {
  const tabs = $("#tabs");
  const layers = snap.layers || [];
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
    refreshViews();
  };
}

function seriesList(snap, layer) {
  // Stale/excluded series stay out of the table — they only widen the layout
  const all = Object.values(snap.series || {}).filter((s) => s.status === "ok");
  if (layer === "all") {
    return all.sort((a, b) => {
      const order = [
        "liquidity",
        "rates",
        "fx",
        "economy",
        "inflation",
        "conditions",
        "markets",
      ];
      const d = order.indexOf(a.layer) - order.indexOf(b.layer);
      return d || a.name.localeCompare(b.name);
    });
  }
  return all
    .filter((s) => s.layer === layer)
    .sort((a, b) => a.name.localeCompare(b.name));
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

function refreshViews() {
  if (!SNAP) return;
  const snap = viewOf(SNAP);
  $("#sentence").innerHTML = buildSentence(snap);
  renderLights(snap);
  renderTable(snap);
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
  return `<td><span class="cell-heat">${fmt(s.latest)}</span></td>
    <td class="${zClass(z)}">${fmtZ(z)}</td>
    <td><span class="cell-heat" style="background:${heatBg(pct)}">${fmtPct(pct)}</span></td>`;
}

function chartCell(s) {
  return `<td class="chart-cell" colspan="${COLSPAN_DATA}">
    <div class="spark-wrap" data-spark="${s.id}">
      <canvas class="spark" width="600" height="36" aria-hidden="true"></canvas>
      <span class="spark-msg muted">…</span>
    </div>
  </td>`;
}

function renderThead(rows) {
  const thead = $("#heat thead tr");
  if (!thead) return;
  const anyValues = rows.some((s) => rowView(s.id) === "values");
  const h = `${statHorizon}y`;
  if (!anyValues) {
    thead.innerHTML = `<th>Series</th><th colspan="${COLSPAN_DATA}">Chart · ${h.toUpperCase()}</th>`;
  } else {
    thead.innerHTML = `<th>Series</th>
      <th>Latest</th><th>${h} z</th><th>${h} %ile</th>`;
  }
}

function renderTable(snap) {
  if (!snap) return;
  const layerMeta =
    (snap.layers || []).find((l) => l.id === activeLayer) ||
    (activeLayer === "all"
      ? { label: "All series", blurb: "Full public book" }
      : { label: activeLayer, blurb: "" });
  $("#layerTitle").textContent = layerMeta.label || activeLayer;
  $("#layerBlurb").textContent = layerMeta.blurb || "";

  const body = $("#heatBody");
  const rows = seriesList(snap, activeLayer);
  renderThead(rows);

  body.innerHTML = rows
    .map((s) => {
      const view = rowView(s.id);
      const data =
        view === "charts" ? chartCell(s) : valuesCells(s);
      return `<tr data-id="${s.id}" data-view="${view}">
        <td class="name-cell"><span class="name">${s.name}</span><span class="sub">${seriesSub(s)}</span></td>
        ${data}
      </tr>`;
    })
    .join("");

  body.onclick = (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    // Name column → series detail; data/chart → flip that line only
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
      const hist = await loadHistory(id);
      if (!canvas) return;
      if (!hist?.points?.length) {
        if (msg) msg.textContent = "no history";
        return;
      }
      const dur = chartDuration();
      const sliced = sliceDuration(hist.points, dur);
      if (!sliced.length) {
        if (msg) msg.textContent = `no ${dur} data`;
        return;
      }
      drawSpark(canvas, sliced);
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
  $("#seriesBody").innerHTML = `
    <p><code>${escapeHtml(s.search || s.sub || s.id)}</code> · ${s.layer} · ${s.freq || "?"}</p>
    <p><strong>Latest:</strong> ${s.latest == null ? "empty" : fmt(s.latest)} <span class="muted">${s.units || ""}</span></p>
    ${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ""}
    <p><strong>As-of:</strong> ${fmtAsOf(s.asOf)}</p>
    <p><strong>1y z:</strong> ${fmtZ(s.z1y)} · <strong>2y z:</strong> ${fmtZ(s.z2y)} · <strong>5y z:</strong> ${fmtZ(s.z5y)}</p>
    <p><strong>1y %ile:</strong> ${fmtPct(s.pct1y)} · <strong>2y %ile:</strong> ${fmtPct(s.pct2y)} · <strong>5y %ile:</strong> ${fmtPct(s.pct5y)}</p>
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
  const h = `${statHorizon}y`;
  $("#formulaBody").innerHTML = `
    <p>Per light: median of member scores (each = mean of sign×${h} z and flipped ${h} %ile). The 1·2·5 control sets that window for lights, the regime story, the table, and charts. Clubs are small complementary sets; Street table keeps the rest. Score &gt;+0.45 / &lt;−0.45 paints the word. Inflation upside = hot.</p>
    <p><strong>Net liquidity:</strong> <code>${escapeHtml(snap.formula?.netLiquidity || "WALCL(bn) − TGA − ON RRP")}</code></p>
    <p><strong>Stock–bond corr:</strong> <code>${escapeHtml(snap.formula?.stockBondCorr || "")}</code></p>
    <p class="muted">Per-series sign flips “higher” into easing vs tightening for that light. Inflation light treats upside as hot.</p>
  `;
}

function renderAboutMeta(snap) {
  const d = new Date(snap.generatedAt);
  const when = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const vals = Object.values(snap.series || {});
  const ok = vals.filter((s) => s.status === "ok").length;
  const stale = vals.filter((s) => s.status === "stale");
  const empty = vals.filter((s) => s.status !== "ok" && s.status !== "stale").length;
  $("#aboutIngest").textContent = `Last ingest ${when} — when public series were last pulled (not each row’s as-of).`;
  const staleNames = stale.map((s) => s.name || s.id).join(", ");
  $("#aboutCoverage").textContent = stale.length
    ? `${ok} live in table · ${stale.length} stale hidden (${staleNames})${empty ? ` · ${empty} empty` : ""}`
    : `${ok} live series${empty ? ` · ${empty} empty` : ""}`;
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

  const snap = viewOf(SNAP);
  $("#sentence").innerHTML = buildSentence(snap);
  renderLights(snap);
  renderTabs(SNAP);
  renderTable(snap);
  renderFormula(snap);
  renderAboutMeta(SNAP);

  $("#btnAbout").onclick = () => $("#dlgAbout").showModal();

  // Backdrop click closes any dialog; regime sheet also closes on tap inside (read-only).
  document.querySelectorAll("dialog").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) {
        dlg.close();
        return;
      }
      if (dlg.id !== "dlgSentence") return;
      if (e.target.closest("a, button, input, textarea, select, label")) return;
      dlg.close();
    });
    dlg.addEventListener("close", () => {
      // Dialog restore-focus can leave a blue ring on the regime box after tap-close.
      requestAnimationFrame(() => {
        const sent = $("#sentence");
        if (sent && document.activeElement === sent) sent.blur();
      });
    });
  });

  const sent = $("#sentence");
  if (sent) {
    sent.style.cursor = "pointer";
    sent.onclick = () => openSentence(viewOf(SNAP));
    sent.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openSentence(viewOf(SNAP));
      }
    };
  }

  syncViewControls();
  $("#btnViewMode").onclick = () => {
    setGlobalView(globalView === "values" ? "charts" : "values");
  };
  $("#horizonGroup").onclick = (e) => {
    const b = e.target.closest("[data-horizon]");
    if (!b) return;
    const next = Number(b.dataset.horizon);
    if (![1, 2, 5].includes(next)) return;
    statHorizon = next;
    syncViewControls();
    refreshViews();
    renderFormula(viewOf(SNAP));
    if (globalView === "charts" || [...rowFlip].length) paintSparks();
  };

  // Tap light → teach first; Show series CTA jumps to Street tab
  $("#lights").onclick = (e) => {
    const card = e.target.closest(".light[data-id]");
    if (!card) return;
    openLight(card.dataset.id);
  };

  $("#dlgLight")?.addEventListener("close", () => {
    const dlg = $("#dlgLight");
    if (dlg?.returnValue === "series" && pendingLightTab) {
      jumpToStreetTab(pendingLightTab);
    }
    pendingLightTab = null;
  });
}

boot();
