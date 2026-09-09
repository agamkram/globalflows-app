/**
 * One scoring model: anchor (where it is) + impulse (which way).
 * Lights read levels only. 1w/2w/1m is the lookback (the turn).
 */

export const LIGHT_IDS = ["liquidity", "rates", "growth", "inflation", "risk"];
export const IMPULSE_KEYS = ["1w", "2w", "1m"];
export const DEFAULT_IMPULSE = "1m";

const DAYS = { "1w": 7, "2w": 14, "1m": 30 };

export function lightStateFromScore(score) {
  if (score == null || !Number.isFinite(score)) return { state: "empty", score: null };
  if (score > 0.45) return { state: "easing", score };
  if (score < -0.45) return { state: "tight", score };
  return { state: "neutral", score };
}

/** Signed distance to the nearest colour cliff (−0.45 / +0.45). */
export function distanceToCliff(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score > 0.45) return score - 0.45;
  if (score < -0.45) return -0.45 - score;
  return Math.min(0.45 - score, score - -0.45);
}

/**
 * Correlated voters average into one family ballot before the light mean, so
 * three credit spreads cannot outvote VIX three times over. Ungrouped voters
 * keep their catalog weights as true multipliers (not bag-duplicates).
 * Family entry is an id list (ballot weight 1) or `{ ids, weight }` so a
 * low-variance peer cannot flatten the light 50/50.
 */
const VOTE_FAMILIES = {
  risk: {
    credit: ["BAMLH0A0HYM2", "NFCI", "BAA10Y", "BBB_OAS", "BAMLC0A0CM"],
    vol: ["VIX"],
  },
  // Coincident labor/GDP, leading housing/orders/openings, and regional surveys
  // each cast one family ballot so six lagging prints cannot drown the turn.
  // Survey weight 0.5 — two regional prints at the ceiling were carrying a third
  // of Growth and flipping Strong by a hair over six coincident prints at +0.24.
  growth: {
    coincident: ["PAYEMS", "UNRATE", "ICSA", "GDPC1", "CFNAI", "WEI"],
    leading: ["PERMIT", "HOUST", "DGORDER", "JTSJOL"],
    survey: { ids: ["EMPIRE_MFG", "PHILLY_MFG"], weight: 0.5 },
  },
  // Realized core weight 2 so low-variance expectations cannot cap Hot.
  // Persistence (sticky + wages + upstream PPI) is a third ballot, not a half.
  inflation: {
    realized: { ids: ["CPILFESL", "PCEPILFE"], weight: 2 },
    persistence: { ids: ["STICKY_CPI", "CES0500000003", "PPIFIS"], weight: 1 },
    expected: { ids: ["T5YIFR"], weight: 1 },
  },
  // Level-of-rates was casting ~5 ballots vs 1 each for curve and vol.
  rates: {
    real: ["DFII5", "DFII10", "DGS2"],
    nominal: ["MORTGAGE30US", "G3_10Y"],
    curve: ["T10Y2Y"],
    vol: ["MOVE"],
  },
  // Two Fed-balance-sheet/GDP ratios share one ballot.
  liquidity: {
    fed: ["RESERVES_GDP", "NETLIQ_GDP"],
    funding: ["SOFR_SPREAD"],
    global: ["GLOBAL_CB_YOY", "DOLLAR_YOY"],
  },
};

function familySpec(raw) {
  if (Array.isArray(raw)) return { ids: raw, weight: 1 };
  if (raw && Array.isArray(raw.ids)) {
    const w = Number(raw.weight);
    return { ids: raw.ids, weight: Number.isFinite(w) && w > 0 ? w : 1 };
  }
  return null;
}

/** Weight is influence, not a duplicate median seat. */
export function weightedMean(items) {
  let num = 0;
  let den = 0;
  for (const it of items || []) {
    if (!Number.isFinite(it?.score) || !Number.isFinite(it?.weight) || it.weight <= 0) continue;
    num += it.score * it.weight;
    den += it.weight;
  }
  return den ? num / den : null;
}

/** Drop the highest and lowest score once when there are enough ballots. */
export function weightedTrimmedMean(items) {
  const ok = (items || []).filter(
    (it) => Number.isFinite(it?.score) && Number.isFinite(it?.weight) && it.weight > 0
  );
  if (ok.length < 3) return weightedMean(ok);
  const sorted = [...ok].sort((a, b) => a.score - b.score);
  return weightedMean(sorted.slice(1, -1));
}

/**
 * Build light (or impulse) ballots: family-average first, then weighted trimmed mean.
 * @param {string} lid
 * @param {{ id: string, score: number, weight?: number }[]} voters
 */
export function aggregateVotes(lid, voters) {
  const list = (voters || []).filter((v) => v && Number.isFinite(v.score));
  if (!list.length) return null;
  const families = VOTE_FAMILIES[lid] || {};
  const used = new Set();
  const ballots = [];
  for (const [fname, raw] of Object.entries(families)) {
    const spec = familySpec(raw);
    if (!spec) continue;
    const members = list.filter((v) => spec.ids.includes(v.id));
    if (!members.length) continue;
    for (const m of members) used.add(m.id);
    const fam = weightedMean(
      members.map((m) => ({ score: m.score, weight: Math.max(1, m.weight || 1) }))
    );
    // One ballot per family — weight is explicit (default 1), not always equal.
    if (fam != null) ballots.push({ id: `family:${fname}`, score: fam, weight: spec.weight });
  }
  for (const v of list) {
    if (used.has(v.id)) continue;
    ballots.push({
      id: v.id,
      score: v.score,
      weight: Math.max(1, Number(v.weight) || 1),
    });
  }
  return weightedTrimmedMean(ballots);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Piecewise: value vs lo (low) / mid / hi (high) → about -1..+1. invert = high is the tight/soft side. */
export function bandScore(value, lo, mid, hi, invert = false) {
  if (value == null || !Number.isFinite(value)) return null;
  let s;
  if (value <= lo) s = -1;
  else if (value >= hi) s = 1;
  else if (value < mid) s = -1 + ((value - lo) / Math.max(mid - lo, 1e-9)) * 1;
  else s = 0 + ((value - mid) / Math.max(hi - mid, 1e-9)) * 1;
  return invert ? -s : s;
}

/**
 * Anchor kind by series id. `none` = no color vote (flow or no ground truth).
 * `level` = treat the print as already in economic units and use generic bands via kind.
 *
 * Only score a series against a fixed band when the series is already normalised —
 * a rate, a ratio, a spread, or a share of GDP. A raw nominal quantity (reserves in
 * dollars, loans outstanding, a balance sheet) grows with the economy, so any band
 * written for it goes stale and eventually pins the light to one colour. ON RRP is
 * the cautionary tale: its band read "near zero = scarce cash", which was true in
 * 2019 and false from 2023 on, once the facility drained into reserves. Nominal
 * quantities belong on the lookback, or in a ratio, never on a fixed band.
 */
const KIND = {
  CPIAUCSL: "cpi_yoy",
  CPILFESL: "cpi_yoy",
  PCEPILFE: "pce_yoy",
  PCEPI: "pce_yoy",
  MICH: "mich",
  STICKY_CPI: "cpi_yoy",
  CES0500000003: "wage_yoy",
  PPIFIS: "ppi_yoy",
  UNRATE: "unrate",
  ICSA: "claims",
  PAYEMS: "payrolls",
  GDPC1: "gdp_real",
  GDP: "gdp_nom",
  CFNAI: "cfnai",
  WEI: "wei",
  // Leading growth sleeve — housing levels (physical units), orders/openings as YoY.
  PERMIT: "permits",
  HOUST: "housings",
  DGORDER: "dgorder_yoy",
  JTSJOL: "jolts_yoy",
  // Regional Fed surveys stand in for ISM (not on FRED).
  EMPIRE_MFG: "empire_mfg",
  PHILLY_MFG: "philly_mfg",
  RSAFS: "none",
  COPPER: "none",
  VIX: "vix",
  BAMLH0A0HYM2: "hy",
  NFCI: "nfci",
  // Moody's Baa over 10s. FRED computes it rather than licensing it from ICE, so
  // unlike BAMLH0A0HYM2 and BBB_OAS it downloads with 40 years of history instead
  // of three — which is what lets the risk light be scored consistently back
  // through the archive.
  BAA10Y: "baa10y",
  BBB_OAS: "bbb",
  // Plumbing levels are normalised before they vote: a spread against policy and
  // two shares of nominal GDP. The dollar stocks themselves are impulse-only.
  SOFR_SPREAD: "sofr_spread",
  RESERVES_GDP: "reserves_gdp",
  NETLIQ_GDP: "netliq_gdp",
  RRPONTSYD: "none",
  WTREGEN: "none",
  WALCL: "none",
  WRESBAL: "none",
  TOTLL: "none",
  NET_LIQ: "none",
  CREDIT_IMPULSE: "none",
  DGS2: "pending_real",
  // Market TIPS real yields — the Rates light's primary real-rate voters.
  // Trailing-core-PCE constructs (DGS2 only) stay as at most one voter; DFEDTARU
  // was pinned and no longer votes the light.
  DFII5: "tips_real",
  DFII10: "tips_real",
  MORTGAGE30US: "mortgage",
  T10Y2Y: "curve",
  DTWEXBGS: "none",
  MOVE: "move",
  // The rest of the world. A balance sheet level grows forever and cannot carry a
  // band, so the G4 stock is impulse-only and its 12-month change does the voting.
  GLOBAL_CB: "none",
  GLOBAL_CB_YOY: "global_cb_yoy",
  DOLLAR_YOY: "dollar_yoy",
  G3_10Y: "g3_10y",
  T5YIFR: "bei_5y5y",
};

export function anchorKind(id) {
  return KIND[id] || "none";
}

function scoreKind(kind, value) {
  switch (kind) {
    case "cpi_yoy":
    case "pce_yoy":
      return bandScore(value, 1.2, 2.0, 4.0, false);
    // Average hourly earnings, 12-month %. Soft near 2%, mid ~3%, hot near 4.5%
    // on the 2003–2026 wage-growth record.
    case "wage_yoy":
      return bandScore(value, 2.0, 3.0, 4.5, false);
    // Final-demand PPI YoY. Softer and wider than core CPI: 0 / 2 / 6.5.
    case "ppi_yoy":
      return bandScore(value, 0, 2.0, 6.5, false);
    case "mich":
      return bandScore(value, 2.0, 3.0, 4.5, false);
    case "unrate":
      return bandScore(value, 3.5, 4.2, 5.5, true);
    case "claims":
      return bandScore(value, 200000, 250000, 350000, true);
    case "payrolls":
      return bandScore(value, 0, 150, 300, false);
    case "gdp_real":
      return bandScore(value, 0.5, 2.0, 3.5, false);
    case "gdp_nom":
      return bandScore(value, 2.0, 4.0, 6.0, false);
    case "cfnai":
      return bandScore(value, -0.7, 0, 0.7, false);
    case "wei":
      return bandScore(value, 0, 2.0, 4.0, false);
    // Building permits (thousands SAAR). 1990–2026: ~900 is soft (post-GFC floor
    // neighbourhood), 1400 the median, 1850 the boom upper quartile.
    case "permits":
      return bandScore(value, 900, 1400, 1850, false);
    // Housing starts (thousands SAAR). Same record: soft near 850, mid 1350, firm 1750.
    case "housings":
      return bandScore(value, 850, 1350, 1750, false);
    // Durable goods orders, 12-month %. Dollar levels trend up forever; YoY is the
    // signal. Soft near −7 (p10), mid +4 (p50), firm +13 (p90).
    case "dgorder_yoy":
      return bandScore(value, -7, 4, 13, false);
    // JOLTS openings, 12-month %. The stock of openings drifted up for a decade, so
    // the light reads the turn: soft near −15, mid +4, firm +20.
    case "jolts_yoy":
      return bandScore(value, -15, 4, 20, false);
    // NY Fed Empire State general business conditions. Diffusion index: soft −10,
    // mid ~7.5, firm ~22 (p10 / p50 / ~p90 since 2001).
    case "empire_mfg":
      return bandScore(value, -10, 7.5, 22, false);
    // Philly Fed current activity. Soft −12, mid 9, firm 24 on the 1990–2026 record.
    case "philly_mfg":
      return bandScore(value, -12, 9, 24, false);
    // Last ten years: 12 is the 10th percentile, 17 the median, 28 the 90th.
    // Floor at 14 left VIX near maximum calm whenever it sat in the teens.
    case "vix":
      return bandScore(value, 12, 17, 28, true);
    // ICE HY OAS. FRED only publishes three years, all of them cycle-tights, so
    // this band is the long-run shape not the sample: 2.5 is this-cycle tights
    // (the ICE print's min is 2.59), 4.0 is typical, 6.5 is stress. The old floor
    // at 3.2 sat inside this download's 75th percentile and pinned 68% of days
    // at maximum risk-on — a constant, not a signal.
    case "hy":
      return bandScore(value, 2.5, 4.0, 6.5, true);
    case "bbb":
      // ICE BBB OAS. FRED only ships ~3y of cycle tights (roughly 0.9–1.6). The old
      // long-run band (1.0 / 1.5 / 2.5) pinned almost every day at +1 if this voted.
      // Keep the kind for audit; do not put BBB_OAS on the Risk light until stress
      // episodes are in the download. Soft/mid/firm from the short sample.
      return bandScore(value, 0.95, 1.15, 1.55, true);
    // Calibrated on the full 1986-2026 record: 1.45 is the 5th percentile, 2.10 the
    // median, and 3.30 the 95th - roughly where 2011 and 2016 topped out, with the
    // GFC (6.07) and COVID (4.31) beyond it. That pins on 8% of days over 40 years,
    // against 68% for the three-year ICE series it stands in for.
    case "baa10y":
      return bandScore(value, 1.45, 2.1, 3.3, true);
    // NFCI is standardised against its own 1971+ history, but conditions have sat
    // in the loose half of that range for most of the post-crisis era: the band
    // (-0.4, 0, +0.4) left it pinned at a maximum risk-on vote on 70% of days since
    // 2015, which is a constant, not a signal. Recentre on the modern range —
    // roughly -0.65 at its loosest, -0.50 typical, and +0.18 at the COVID peak.
    case "nfci":
      return bandScore(value, -0.6, -0.45, -0.1, true);
    // SOFR minus the top of the fed funds target, in bp. Deeply negative = reserves
    // so ample that secured cash trades well inside the corridor; at or above zero =
    // scarce, the condition that broke repo in September 2019.
    case "sofr_spread":
      return bandScore(value, -20, -10, 0, true);
    // Reserves as a share of nominal GDP. 6.9% is where the 2019 repo crisis hit;
    // the QE peak was 16.6%.
    case "reserves_gdp":
      return bandScore(value, 7, 10, 14, false);
    // Net liquidity as a share of nominal GDP. 16.6% on the eve of the 2019 crisis,
    // 27.8% at the QE peak.
    case "netliq_gdp":
      return bandScore(value, 16.5, 20, 26, false);
    // G4 balance sheets, 12-month change. Neutral sits at +5% rather than zero
    // because world nominal GDP grows around that much: balance sheets held flat
    // are shrinking against the economy they fund, which is a mild drain and not a
    // neutral stance. -6% is roughly the 8th percentile since 2003 and about where
    // 2022's joint QT ran; +20% is the QE end.
    case "global_cb_yoy":
      return bandScore(value, -6, 5, 20, false);
    // Broad dollar, 12-month change, inverted: most of the world borrows in dollars
    // it cannot print, so a rising dollar tightens those balance sheets no matter
    // what any central bank intends. +10% is the 2015 and 2022 wrecking-ball pace.
    case "dollar_yoy":
      return bandScore(value, -8, 1, 10, true);
    // Mean 10-year across Germany, the UK and Japan. The band has to span an era
    // when these yielded 8% and an era when they yielded nothing, so it is set on
    // the 1989-2026 distribution: 0.5% is the ZIRP floor, 6% genuinely restrictive.
    case "g3_10y":
      return bandScore(value, 0.5, 3.0, 6.0, true);
    // 5y5y forward inflation (CPI). 1.7 is the 5th percentile of the 2003–2026
    // record, 2.3 the median and the CPI-equivalent of a 2% PCE target, 2.8
    // where 2022 stopped looking anchored.
    case "bei_5y5y":
      return bandScore(value, 1.7, 2.3, 2.8, false);
    case "mortgage":
      return bandScore(value, 4.0, 6.0, 7.5, true);
    case "curve":
      return bandScore(value, -0.3, 0.3, 1.2, false);
    // MOVE ran a median of 56 through the 2015-21 QE years, so a floor at 70 left
    // it stuck at maximum calm for most of a decade and unable to tell quiet from
    // silent. Drop the floor to the quarter-percentile of the last ten years; the
    // stress end is unchanged, since 140 is still where bond vol hurts.
    // The band stays two-sided for audit. The vote is one-way: see makeAnchor.
    case "move":
      return bandScore(value, 55, 100, 140, true);
    // Market TIPS real yields (DFII5/DFII10). Same economic lines as the trailing
    // real-rate construct: below 0 easy, around 0.5 neutral, above 2 genuinely tight.
    case "tips_real":
    case "real_rate":
      return bandScore(value, -0.5, 0.5, 2.0, true);
    default:
      return null;
  }
}

function whyKind(kind, value) {
  if (value == null || !Number.isFinite(value)) return "no print";
  const v = Number(value);
  const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  switch (kind) {
    case "cpi_yoy":
    case "pce_yoy":
      return `${fmt(v)}% YoY vs ~2% target`;
    case "wage_yoy":
      return `average hourly earnings ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m`;
    case "ppi_yoy":
      return `final-demand PPI ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m`;
    case "mich":
      return `${fmt(v)}% household expected inflation`;
    case "unrate":
      return `${fmt(v)}% unemployment vs ~4% full employment`;
    case "claims":
      return `${Math.round(v).toLocaleString()} initial claims`;
    case "payrolls":
      return `${fmt(v, 0)}k jobs in the latest month`;
    case "gdp_real":
      return `${fmt(v)}% real GDP YoY`;
    case "gdp_nom":
      return `${fmt(v)}% nominal GDP YoY`;
    case "cfnai":
      return `activity index ${fmt(v, 2)} (0 ≈ trend)`;
    case "wei":
      return `weekly activity ${fmt(v)}`;
    case "permits":
      return `${fmt(v, 0)}k building permits (SAAR)`;
    case "housings":
      return `${fmt(v, 0)}k housing starts (SAAR)`;
    case "dgorder_yoy":
      return `durable goods orders ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m`;
    case "jolts_yoy":
      return `job openings ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m`;
    case "empire_mfg":
      return `Empire manufacturing ${fmt(v, 1)}`;
    case "philly_mfg":
      return `Philly manufacturing ${fmt(v, 1)}`;
    case "vix":
      return `VIX ${fmt(v, 1)}`;
    case "hy":
      return `High-yield OAS ${fmt(v)}% — 2.5 is cycle tights, 4 is typical, 6.5 is stress`;
    case "bei_5y5y":
      return `5y5y ${fmt(v)}% — 2.3 is the CPI-equivalent of a 2% PCE target`;
    case "bbb":
      return `BBB OAS ${fmt(v)}%`;
    case "baa10y":
      return `Baa over 10s ${fmt(v, 2)}pp — 2.1 is the 40-year median, 3.3 is crisis`;
    case "nfci":
      return `NFCI ${fmt(v, 2)}`;
    case "sofr_spread":
      return `SOFR ${fmt(v, 0)}bp vs the top of the target range — 0 is where repo broke in 2019`;
    case "reserves_gdp":
      return `reserves ${fmt(v)}% of GDP — 6.9% in the 2019 squeeze, 16.6% at the QE peak`;
    case "netliq_gdp":
      return `net liquidity ${fmt(v)}% of GDP — 16.6% in the 2019 squeeze, 27.8% at the QE peak`;
    case "global_cb_yoy":
      return `G4 balance sheets ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m — flat is a mild drain, since world nominal GDP grows ~5%`;
    case "dollar_yoy":
      return `broad dollar ${v >= 0 ? "+" : ""}${fmt(v)}% over 12m — a rising dollar tightens every borrower who owes in it`;
    case "g3_10y":
      return `German, UK and Japanese 10-year average ${fmt(v)}%`;
    case "mortgage":
      return `30y mortgage ${fmt(v)}%`;
    case "curve":
      return `2s10s ${fmt(v, 2)} pp`;
    case "move":
      return v > 100
        ? `MOVE ${fmt(v, 0)} — elevated, taxes the rates complex`
        : `MOVE ${fmt(v, 0)} — calm, so it doesn’t vote (only a spike taxes Rates)`;
    case "tips_real":
      return `TIPS real yield ${fmt(v, 2)}%`;
    case "real_rate":
      return `trailing real short rate ${fmt(v, 2)}%`;
    default:
      return "no level anchor — flow/impulse only";
  }
}

/**
 * Every band in `scoreKind` is already written in the light's direction: its
 * `invert` flag carries the orientation, so `spec.sign` must not be applied again
 * here or the vote flips twice and cancels. Positive is always the reflationary
 * side of the light — more cash, easier funding, firmer growth, hotter prices,
 * more risk appetite.
 */
export function makeAnchor(spec, value) {
  const kind = spec.anchorKind || anchorKind(spec.id);
  const score = scoreKind(kind, value);
  // MOVE is the rates complex’s stress gauge: a spike means duration is
  // unownable, so it can tighten the light. Calm is not cheap money — keep the
  // band score for audit, but do not let silence vote “easy.”
  const votes = kind === "move" ? score != null && score < 0 : score != null;
  return {
    kind,
    score,
    why: whyKind(kind, value),
    votes,
  };
}

function priorPoint(points, days, freq) {
  if (!points?.length) return null;
  const last = points[points.length - 1];
  if (freq === "monthly") {
    const steps = days <= 40 ? 1 : days <= 100 ? 3 : days <= 200 ? 6 : 12;
    const i = points.length - 1 - steps;
    return i >= 0 ? points[i] : null;
  }
  if (freq === "quarterly") {
    const steps = days <= 100 ? 1 : days <= 200 ? 2 : 4;
    const i = points.length - 1 - steps;
    return i >= 0 ? points[i] : last;
  }
  const end = Date.parse(last.date + "T00:00:00Z");
  const target = end - days * 86400000;
  let best = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const t = Date.parse(points[i].date + "T00:00:00Z");
    if (t <= target) {
      best = points[i];
      break;
    }
  }
  return best;
}

function impulseDeadband(spec, latest) {
  const kind = anchorKind(spec.id);
  if (kind === "cpi_yoy" || kind === "pce_yoy" || kind === "mich" || kind === "bei_5y5y" || kind === "wage_yoy" || kind === "ppi_yoy") return 0.08;
  if (kind === "unrate") return 0.05;
  if (kind === "vix") return 0.8;
  if (kind === "hy" || kind === "bbb") return 0.08;
  if (typeof latest === "number" && Math.abs(latest) > 1000) return Math.abs(latest) * 0.004;
  return Math.max(Math.abs(latest || 0) * 0.004, 0.02);
}

export function makeImpulse(points, spec) {
  const last = points?.[points.length - 1];
  const out = {};
  for (const key of IMPULSE_KEYS) {
    const prior = last ? priorPoint(points, DAYS[key], spec.freq) : null;
    if (!last || !prior || prior.date === last.date) {
      out[key] = { delta: null, dir: null, score: null };
      continue;
    }
    const delta = last.value - prior.value;
    const db = impulseDeadband(spec, last.value);
    let dir = "flat";
    if (delta > db) dir = "up";
    else if (delta < -db) dir = "down";
    const sign = spec.sign ?? 0;
    const lid = spec.light;
    const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
    const mag = clamp(delta / Math.max(db * 4, 1e-9), -1.5, 1.5);
    out[key] = { delta, dir, score: mag * s, prior: prior.value, priorDate: prior.date };
  }
  return out;
}

export function seriesFacts(points, spec) {
  if (!points?.length) {
    return {
      latest: null,
      asOf: null,
      n: 0,
      anchor: { kind: anchorKind(spec.id), score: null, why: "no print", votes: false },
      impulse: Object.fromEntries(IMPULSE_KEYS.map((k) => [k, { delta: null, dir: null, score: null }])),
    };
  }
  const last = points[points.length - 1];
  return {
    latest: last.value,
    asOf: last.date,
    n: points.length,
    anchor: makeAnchor(spec, last.value),
    impulse: makeImpulse(points, spec),
  };
}

export function applyRealRateAnchors(results) {
  const core = results.PCEPILFE?.status === "ok" ? results.PCEPILFE.latest : null;
  if (core == null || !Number.isFinite(core)) return;
  // At most one trailing-core-PCE construct. Market TIPS (DFII5/DFII10) vote the
  // real-rate band directly; DFEDTARU was a pinned constant and no longer votes.
  for (const id of ["DGS2"]) {
    const row = results[id];
    if (!row || row.status !== "ok" || row.latest == null) continue;
    const real = row.latest - core;
    const score = scoreKind("real_rate", real);
    row.anchor = {
      kind: "real_rate",
      score,
      why: whyKind("real_rate", real) + ` (nominal ${row.latest.toFixed(2)} − core PCE ${core.toFixed(1)})`,
      votes: score != null,
    };
  }
}

/** Calendar days from the print date to now. Observation-month dating, not release date. */
export function printAgeDays(asOf, now = Date.now()) {
  if (!asOf) return null;
  const t = Date.parse(String(asOf).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * How old a level vote may be. Monthly prints are dated the 1st of the observation
 * month, so ~80 days still covers a late release of last month; it does not cover
 * an OECD print from two months ago. Daily allows a long weekend plus a week.
 */
export function voteMaxAgeDays(freq) {
  if (freq === "quarterly") return 190;
  if (freq === "monthly") return 85;
  if (freq === "weekly") return 21;
  return 14;
}

export function isFreshEnoughToVote(m, now = Date.now()) {
  const age = printAgeDays(m?.asOf, now);
  if (age == null) return true;
  const cap = Number.isFinite(m.voteMaxAgeDays) ? m.voteMaxAgeDays : voteMaxAgeDays(m.freq);
  return age <= cap;
}

export function memberAnchorScore(m, now = Date.now()) {
  if (!m || m.status !== "ok") return null;
  if (!m.anchor?.votes) return null;
  if (!isFreshEnoughToVote(m, now)) return null;
  const sc = m.anchor.score;
  return sc != null && Number.isFinite(sc) ? sc : null;
}

export function memberImpulseScore(m, horizon = DEFAULT_IMPULSE) {
  if (!m || m.status !== "ok") return null;
  // MOVE: calm does not vote easy on the light or the turn — same gate.
  if (m.anchor?.kind === "move" && !m.anchor?.votes) return null;
  const sc = m.impulse?.[horizon]?.score;
  return sc != null && Number.isFinite(sc) ? sc : null;
}

export function buildLights(snap, now = Date.now()) {
  const meta = snap.lightsMeta || [];
  const baked = snap.lights || {};
  const out = {};
  for (const lid of LIGHT_IDS) {
    const clubIds = Object.values(snap.series || {})
      .filter((r) => r.light === lid && r.status === "ok")
      .map((r) => r.id);
    const voterIds = clubIds.filter((id) => memberAnchorScore(snap.series?.[id], now) != null);
    const impulseIds = [
      ...new Set([
        ...clubIds,
        ...Object.values(snap.series || {})
          .filter((r) => r.impulseLight === lid && r.status === "ok")
          .map((r) => r.id),
      ]),
    ];
    const voters = [];
    for (const id of voterIds) {
      const row = snap.series?.[id];
      const sc = memberAnchorScore(row, now);
      if (sc == null) continue;
      voters.push({ id, score: sc, weight: Math.max(1, Number(row.weight) || 1) });
    }
    const score = aggregateVotes(lid, voters);
    const { state } = lightStateFromScore(score);
    const m = meta.find((x) => x.id === lid) || baked[lid];
    out[lid] = {
      id: lid,
      label: m?.label || baked[lid]?.label || lid,
      state,
      score,
      n: voterIds.length,
      nAnchor: voters.length,
      words: {
        easing: m?.easing || baked[lid]?.words?.easing,
        neutral: m?.neutral || baked[lid]?.words?.neutral,
        tight: m?.tight || baked[lid]?.words?.tight,
      },
      members: voterIds,
      impulseMembers: impulseIds,
    };
  }
  return out;
}

export function attachImpulse(lights, snap, horizon = DEFAULT_IMPULSE) {
  const h = IMPULSE_KEYS.includes(horizon) ? horizon : DEFAULT_IMPULSE;
  for (const lid of Object.keys(lights || {})) {
    const ids = lights[lid].impulseMembers || lights[lid].members || [];
    const voters = [];
    for (const id of ids) {
      const m = snap.series?.[id];
      const sc = memberImpulseScore(m, h);
      if (sc == null) continue;
      voters.push({ id, score: sc, weight: Math.max(1, Number(m.weight) || 1) });
    }
    const score = aggregateVotes(lid, voters);
    let dir = "flat";
    if (score > 0.2) dir = "up";
    else if (score < -0.2) dir = "down";
    lights[lid].impulse = { horizon: h, score, dir };
  }
  return lights;
}

export function impulseDirOf(series, horizon = DEFAULT_IMPULSE) {
  return series?.impulse?.[horizon]?.dir || null;
}
