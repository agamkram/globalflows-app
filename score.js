/**
 * One scoring model: anchor (where it is) + impulse (which way).
 * Lights read anchors only. 1m/3m/6m/1y are impulse clocks.
 */

export const IMPULSE_KEYS = ["1m", "3m", "6m", "1y"];
export const DEFAULT_IMPULSE = "6m";

const DAYS = { "1m": 30, "3m": 91, "6m": 182, "1y": 365 };

export function lightStateFromScore(score) {
  if (score == null || !Number.isFinite(score)) return { state: "empty", score: null };
  if (score > 0.45) return { state: "easing", score };
  if (score < -0.45) return { state: "tight", score };
  return { state: "neutral", score };
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
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

function signedForLight(rawScore, spec, lid) {
  if (rawScore == null) return null;
  const sign = spec.sign ?? 0;
  const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
  return rawScore * s;
}

/**
 * Anchor kind by series id. `none` = no color vote (flow or no ground truth).
 * `level` = treat the print as already in economic units and use generic bands via kind.
 */
const KIND = {
  CPIAUCSL: "cpi_yoy",
  CPILFESL: "cpi_yoy",
  PCEPILFE: "pce_yoy",
  PCEPI: "pce_yoy",
  MICH: "mich",
  STICKY_CPI: "cpi_yoy",
  UNRATE: "unrate",
  ICSA: "claims",
  PAYEMS: "payrolls",
  GDPC1: "gdp_real",
  GDP: "gdp_nom",
  CFNAI: "cfnai",
  WEI: "wei",
  RSAFS: "none",
  COPPER: "none",
  VIX: "vix",
  BAMLH0A0HYM2: "hy",
  NFCI: "nfci",
  BBB_OAS: "bbb",
  RRPONTSYD: "rrp",
  WTREGEN: "tga",
  WALCL: "none",
  WRESBAL: "none",
  TOTLL: "none",
  NET_LIQ: "none",
  CREDIT_IMPULSE: "none",
  DGS2: "pending_real",
  DFEDTARU: "pending_real",
  MORTGAGE30US: "mortgage",
  T10Y2Y: "curve",
  DTWEXBGS: "none",
  MOVE: "move",
};

export function anchorKind(id) {
  return KIND[id] || "none";
}

function scoreKind(kind, value) {
  switch (kind) {
    case "cpi_yoy":
    case "pce_yoy":
      return bandScore(value, 1.2, 2.0, 4.0, false);
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
    case "vix":
      return bandScore(value, 14, 20, 28, true);
    case "hy":
      return bandScore(value, 3.2, 4.2, 6.0, true);
    case "bbb":
      return bandScore(value, 1.0, 1.5, 2.5, true);
    case "nfci":
      return bandScore(value, -0.4, 0, 0.4, true);
    case "rrp":
      return bandScore(value, 80, 400, 1200, false);
    case "tga":
      return bandScore(value, 400000, 700000, 1000000, true);
    case "mortgage":
      return bandScore(value, 4.0, 6.0, 7.5, true);
    case "curve":
      return bandScore(value, -0.3, 0.3, 1.2, false);
    case "move":
      return bandScore(value, 70, 100, 140, true);
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
    case "vix":
      return `VIX ${fmt(v, 1)}`;
    case "hy":
      return `HY OAS ${fmt(v)}%`;
    case "bbb":
      return `BBB OAS ${fmt(v)}%`;
    case "nfci":
      return `NFCI ${fmt(v, 2)}`;
    case "rrp":
      return `ON RRP ${fmt(v, 0)} — high = ample parked cash`;
    case "tga":
      return `Treasury cash ${fmt(v, 0)}`;
    case "mortgage":
      return `30y mortgage ${fmt(v)}%`;
    case "curve":
      return `2s10s ${fmt(v, 2)} pp`;
    case "move":
      return `MOVE ${fmt(v, 0)}`;
    case "real_rate":
      return `real policy/short rate ${fmt(v, 2)}%`;
    default:
      return "no level anchor — flow/impulse only";
  }
}

export function makeAnchor(spec, value) {
  const kind = spec.anchorKind || anchorKind(spec.id);
  const raw = scoreKind(kind, value);
  if (raw == null) {
    return { kind, score: null, why: whyKind(kind, value), votes: false };
  }
  const lid = spec.light;
  const score = signedForLight(kind === "cpi_yoy" || kind === "pce_yoy" || kind === "mich" ? raw : raw, spec, lid);
  // inflation kinds already “higher = hot = easing”
  let scored = raw;
  if (lid && lid !== "inflation" && kind !== "cpi_yoy" && kind !== "pce_yoy" && kind !== "mich") {
    const sign = spec.sign ?? 0;
    const s = sign === 0 ? 1 : sign;
    // bandScore already oriented for economic meaning; don't double-apply sign
    // except series whose bands were written in native units matching the light.
    scored = raw;
    if (kind === "unrate" || kind === "claims" || kind === "vix" || kind === "hy" || kind === "bbb" || kind === "nfci" || kind === "mortgage" || kind === "move" || kind === "tga" || kind === "real_rate") {
      scored = raw; // invert already in bandScore
    } else if (kind === "rrp" || kind === "curve" || kind === "payrolls" || kind === "gdp_real" || kind === "gdp_nom" || kind === "cfnai" || kind === "wei") {
      scored = raw;
    } else {
      scored = raw * s;
    }
  }
  return { kind, score: scored, why: whyKind(kind, value), votes: true };
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
  if (kind === "cpi_yoy" || kind === "pce_yoy" || kind === "mich") return 0.08;
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
  for (const id of ["DFEDTARU", "DGS2", "EFFR"]) {
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

export function memberAnchorScore(m) {
  if (!m || m.status !== "ok") return null;
  if (!m.anchor?.votes) return null;
  const sc = m.anchor.score;
  return sc != null && Number.isFinite(sc) ? sc : null;
}

export function memberImpulseScore(m, horizon = DEFAULT_IMPULSE) {
  if (!m || m.status !== "ok") return null;
  const sc = m.impulse?.[horizon]?.score;
  return sc != null && Number.isFinite(sc) ? sc : null;
}

export function buildLights(snap) {
  const meta = snap.lightsMeta || [];
  const baked = snap.lights || {};
  const lightIds = ["liquidity", "rates", "growth", "inflation", "risk"];
  const out = {};
  for (const lid of lightIds) {
    const memberIds = Object.values(snap.series || {})
      .filter((r) => r.light === lid && r.status === "ok")
      .map((r) => r.id);
    const impulseIds = [
      ...new Set([
        ...memberIds,
        ...Object.values(snap.series || {})
          .filter((r) => r.impulseLight === lid && r.status === "ok")
          .map((r) => r.id),
      ]),
    ];
    const members = memberIds.map((id) => snap.series?.[id]).filter((m) => m && m.status === "ok");
    const scores = [];
    for (const m of members) {
      const sc = memberAnchorScore(m);
      if (sc == null) continue;
      const w = Math.max(1, Math.round(m.weight || 1));
      for (let i = 0; i < w; i++) scores.push(sc);
    }
    const score = scores.length ? median(scores) : null;
    const { state } = lightStateFromScore(score);
    const m = meta.find((x) => x.id === lid) || baked[lid];
    out[lid] = {
      id: lid,
      label: m?.label || baked[lid]?.label || lid,
      state,
      score,
      n: members.length,
      nAnchor: scores.length,
      words: {
        easing: m?.easing || baked[lid]?.words?.easing,
        neutral: m?.neutral || baked[lid]?.words?.neutral,
        tight: m?.tight || baked[lid]?.words?.tight,
      },
      members: memberIds,
      impulseMembers: impulseIds,
    };
  }
  return out;
}

export function attachImpulse(lights, snap, horizon = DEFAULT_IMPULSE) {
  const h = IMPULSE_KEYS.includes(horizon) ? horizon : DEFAULT_IMPULSE;
  for (const lid of Object.keys(lights || {})) {
    const ids = lights[lid].impulseMembers || lights[lid].members || [];
    const bag = [];
    for (const id of ids) {
      const m = snap.series?.[id];
      const sc = memberImpulseScore(m, h);
      if (sc == null) continue;
      const w = Math.max(1, Math.round(m.weight || 1));
      for (let i = 0; i < w; i++) bag.push(sc);
    }
    const score = bag.length ? median(bag) : null;
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
