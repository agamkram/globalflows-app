/**
 * Regime → duration risk / credit risk → six asset classes (in / mixed / out).
 * The five components are levels. The 1w/2w/1m lookback only nudges needle position.
 */
import { DEFAULT_IMPULSE } from "./score.js";

function stateOf(lights, id) {
  return lights?.[id]?.state || "empty";
}

function wordOf(lights, id) {
  return lights?.[id]?.word || lights?.[id]?.words?.[lights[id].state] || stateOf(lights, id);
}

function seriesOk(snap, id) {
  const s = snap?.series?.[id];
  return s && s.status === "ok" ? s : null;
}

/**
 * 2003–2026 centres for signed valuation. Rich (above centre for yields /
 * below for spreads that pay you) subtracts; cheap adds. HY uses the long-run
 * typical (band mid) — FRED’s ICE print is only ~3y of cycle tights.
 * Live path prefers snap.valCenter (data/val-center.json via ingest/calibrate:val).
 */
const VAL_CENTER_DEFAULT = {
  THREEFFTP10: { median: 1.06, scale: 0.75 },
  DFII10: { median: 1.05, scale: 0.8 },
  BAMLH0A0HYM2: { median: 4.0, scale: 1.5 },
  BAA10Y: { median: 2.24, scale: 0.7 },
  // Earnings yield − 10y real (2003–2026). Wide = equities cheap.
  EQUITY_ERP: { median: 3.71, scale: 1.5 },
  SPX_EY: { median: 4.47, scale: 1.0 },
};

let VAL_CENTER = { ...VAL_CENTER_DEFAULT };

/** Install archive-fitted centres `{ id: { median, scale } }`. */
export function setValCenter(table) {
  if (!table) {
    VAL_CENTER = { ...VAL_CENTER_DEFAULT };
    return;
  }
  VAL_CENTER = { ...VAL_CENTER_DEFAULT, ...table };
}

function centerOf(snap, id) {
  return snap?.valCenter?.[id] || VAL_CENTER[id] || VAL_CENTER_DEFAULT[id];
}

/** (value − median) / scale, clamped to −1..+1. */
function valZ(value, median, scale) {
  if (value == null || !Number.isFinite(value) || !(scale > 0)) return 0;
  return Math.max(-1, Math.min(1, (value - median) / scale));
}

function seriesValZ(snap, id, fallbackId = null) {
  const s = seriesOk(snap, id) || (fallbackId ? seriesOk(snap, fallbackId) : null);
  if (!s || s.latest == null || !Number.isFinite(s.latest)) return 0;
  const cfg = centerOf(snap, s.id) || centerOf(snap, id);
  if (!cfg) return 0;
  return valZ(s.latest, cfg.median, cfg.scale);
}

/** Term premium z: wide (+) = duration paid; compressed (−) = not paid. */
function termPremiumZ(snap) {
  return seriesValZ(snap, "THREEFFTP10");
}

/** Real 10y z: high (+) taxes risk assets; low (−) is cheap discount rate. */
function real10Z(snap) {
  return seriesValZ(snap, "DFII10");
}

/** Credit-spread z: wide (+) = paid; tight (−) = not paid. HY, else Baa. */
function creditSpreadZ(snap) {
  return seriesValZ(snap, "BAMLH0A0HYM2", "BAA10Y");
}

/** Equity valuation z: wide ERP (+) = cheap; tight (−) = not paid vs real 10y. */
function equityErpZ(snap) {
  if (seriesOk(snap, "EQUITY_ERP")) return seriesValZ(snap, "EQUITY_ERP");
  // Fallback: earnings yield alone, inverted against real yields when ERP missing.
  if (seriesOk(snap, "SPX_EY")) return seriesValZ(snap, "SPX_EY") - real10Z(snap);
  return -real10Z(snap);
}

/**
 * Broad dollar rising over 12m. DOLLAR_YOY band is inverted (rising = tight),
 * so a negative anchor score or a print above ~+3% means the dollar is taxing
 * dollar-priced commodities and gold.
 */
function dollarStrong(snap) {
  const d = seriesOk(snap, "DOLLAR_YOY");
  if (!d) return false;
  if (d.anchor?.score != null && Number.isFinite(d.anchor.score)) return d.anchor.score < -0.45;
  return d.latest != null && d.latest > 3;
}

function dollarSoft(snap) {
  const d = seriesOk(snap, "DOLLAR_YOY");
  if (!d) return false;
  if (d.anchor?.score != null && Number.isFinite(d.anchor.score)) return d.anchor.score > 0.45;
  return d.latest != null && d.latest < -3;
}

/** Continuous light score on −1..+1. Prefer the number; fall back to the word. */
function lightUnit(lights, id) {
  const s = lights?.[id]?.score;
  if (Number.isFinite(s)) return clampMargin(s);
  const st = lights?.[id]?.state;
  if (st === "easing") return 0.6;
  if (st === "tight") return -0.6;
  return 0;
}

/**
 * Soft “easing” weight 0..1 from a continuous score.
 * 0 at ≤ −0.2, 1 at ≥ +0.45 — no cliff at the paint threshold alone.
 */
function easeW(score) {
  return Math.max(0, Math.min(1, (score - -0.2) / (0.45 - -0.2)));
}

/** Soft “tight” weight 0..1. 0 at ≥ −0.2, 1 at ≤ −0.45. */
function tightW(score) {
  return Math.max(0, Math.min(1, (-0.2 - score) / (0.45 - 0.2)));
}

/** Map a continuous net to in / mixed / out. */
function netCall(net, hi = 0.35, lo = -0.35) {
  if (net >= hi) return "in";
  if (net <= lo) return "out";
  return "mixed";
}

function hzImp(s, horizon) {
  const imp = s?.impulse?.[horizon];
  return { dir: imp?.dir || null, delta: imp?.delta ?? null, score: imp?.score ?? null };
}

function pastWindow(horizon) {
  if (horizon === "1w") return "Over the past week";
  if (horizon === "2w") return "Over the past two weeks";
  return "Over the past month";
}

function joinEnglish(parts) {
  const a = (parts || []).filter(Boolean);
  if (!a.length) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}

function sentence(parts, fallback) {
  const body = joinEnglish(parts);
  if (!body) return fallback;
  const capped = body.charAt(0).toUpperCase() + body.slice(1);
  return capped.endsWith(".") ? capped : `${capped}.`;
}

function clampMargin(n) {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

/**
 * Call is still in / mixed / out of favor. Needle position is how many of the
 * checklist conditions hit, on −1..+1. Underweight counts only avoid-conditions
 * (an unused own-condition cannot cancel it). Mixed can lean a little when some
 * own-conditions are open.
 */
function stanceMargin(stance, ownCount, avoidCount, cap) {
  const c = Math.max(cap, 1);
  if (stance === "out") return clampMargin(-Math.max(avoidCount, 1) / c);
  if (stance === "in") return clampMargin(Math.max(ownCount, 1) / c);
  return clampMargin((((ownCount || 0) - (avoidCount || 0)) / c) * 0.5);
}

function impulseUnit(imp) {
  const sc = imp?.score;
  if (sc == null || !Number.isFinite(sc)) return 0;
  return clampMargin(sc / 1.5);
}

function lightImpulse(lights, id) {
  return impulseUnit(lights?.[id]?.impulse);
}

function meanImpulse(parts) {
  const a = (parts || []).filter((x) => Number.isFinite(x));
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

/**
 * The checklist sets in / mixed / out. The lookback may slide the needle
 * (28% weight) but cannot flip the call. checklistScore may be a continuous net.
 */
function blendMargin(stance, checklistScore, momentum) {
  const m = clampMargin(0.72 * clampMargin(checklistScore) + 0.28 * clampMargin(momentum));
  if (stance === "out") return Math.min(m, -0.05);
  if (stance === "in") return Math.max(m, 0.05);
  return m;
}

function instrumentFromNet(id, name, net, whyIn, whyOut, whyMix, hi = 0.35, lo = -0.35) {
  const stance = netCall(net, hi, lo);
  const why = stance === "in" ? whyIn : stance === "out" ? whyOut : whyMix;
  return { id, name, stance, why, net: clampMargin(net) };
}

function instrument(id, name, inOn, outOn, whyIn, whyOut, whyMix) {
  let stance = "mixed";
  let why = whyMix;
  if (inOn && !outOn) {
    stance = "in";
    why = whyIn;
  } else if (outOn && !inOn) {
    stance = "out";
    why = whyOut;
  }
  return { id, name, stance, why };
}

function durScore(dir) {
  if (dir === "falling") return 1;
  if (dir === "rising") return -1;
  return 0;
}

function scoreStance(n) {
  return netCall(n, 0.35, -0.35);
}

function tenorWhy(stance, tenor, ctx = {}) {
  const T = ctx.T;
  const I = ctx.I;
  if (stance === "in") {
    if (tenor === "5") return "Front-end duration can work — policy isn’t fighting the 5s.";
    if (tenor === "10") return "The benchmark 10s can get paid — duration risk is easing.";
    return "Long 30s can work — inflation/term premium isn’t the tax.";
  }
  if (stance === "out") {
    if (tenor === "5") {
      return T === "tight"
        ? "Policy/funding still taxes the 5s."
        : "Duration risk is feeding back into the 5s — not a clean front-end bid.";
    }
    if (tenor === "10") return "Discount rates still tax the 10s.";
    return I === "easing"
      ? "Hot inflation — 30s aren’t getting paid."
      : "Term premium or duration risk — 30s aren’t getting paid.";
  }
  if (tenor === "5") return "Policy isn’t tight or easy — 5s are a parking place, not the trade.";
  if (tenor === "10") return "10s are split; duration isn’t a clean overweight or avoid.";
  return "30s are split — inflation and duration aren’t telling the same story.";
}

function gradeTenor(name, net, ctx, cap = 1) {
  const stance = netCall(net, 0.35, -0.35);
  const margin = clampMargin(net / Math.max(cap, 1));
  return { id: name, name, stance, why: tenorWhy(stance, name, ctx), margin };
}

/**
 * Map duration × credit (plus lights) onto six asset classes.
 * Treasuries split 5 / 10 / 30. Credit shows investment grade and high yield.
 */
function buildFavor(lights, durationDir, creditDir, snap, horizon, creditUpParts) {
  const L = stateOf(lights, "liquidity");
  const T = stateOf(lights, "rates");
  const G = stateOf(lights, "growth");
  const I = stateOf(lights, "inflation");
  const R = stateOf(lights, "risk");
  const lSc = lightUnit(lights, "liquidity");
  const tSc = lightUnit(lights, "rates");
  const gSc = lightUnit(lights, "growth");
  const iSc = lightUnit(lights, "inflation");
  const rSc = lightUnit(lights, "risk");
  const d = durScore(durationDir);
  const flight = tightW(rSc) * (1 - easeW(iSc));
  const rImp = lightImpulse(lights, "rates");
  const iImp = lightImpulse(lights, "inflation");
  const gImp = lightImpulse(lights, "growth");
  const lImp = lightImpulse(lights, "liquidity");
  const kImp = lightImpulse(lights, "risk");
  const hyImp = impulseUnit(hzImp(seriesOk(snap, "BAMLH0A0HYM2"), horizon));

  const tpZ = termPremiumZ(snap);
  const realZ = real10Z(snap);
  const spreadZ = creditSpreadZ(snap);
  const erpZ = equityErpZ(snap);
  const realHigh = realZ > 0.45;
  const realLow = realZ < -0.45;
  const dolStrong = dollarStrong(snap);
  const dolSoft = dollarSoft(snap);

  const billsPay = tightW(tSc) > 0.55 || tightW(lSc) > 0.55 || tightW(rSc) > 0.55;

  let pairLine = "No clean stocks-versus-bonds call";
  let pairWhy =
    "Duration and credit are not lined up the same way — wait for a cleaner mix.";
  if (durationDir === "rising" && creditDir === "falling") {
    pairLine = "Stocks over long Treasuries";
    pairWhy =
      "Cash flows still look collectible while discount rates tax long bonds.";
  } else if (durationDir === "falling" && creditDir === "rising") {
    pairLine = "Long Treasuries over stocks";
    pairWhy = "Duration can work; the problem is whether borrowers still pay.";
  } else if (durationDir === "rising" && creditDir === "rising") {
    if (billsPay) {
      pairLine = "Cash over stocks and long bonds";
      pairWhy =
        "Both discount-rate risk and cash-flow risk are up — get paid to wait.";
    } else {
      pairLine = "Neither stocks nor long bonds are a clean bid";
      pairWhy =
        "Both discount-rate risk and cash-flow risk are up — wait for a cleaner mix before overweighting cash.";
    }
  } else if (durationDir === "falling" && creditDir === "falling") {
    pairLine = "Risk assets and duration can both work";
    pairWhy = "Softer funding/inflation and collectible cash flows — an easing mix.";
  }

  const tenorCtx = { T, I };
  // Continuous policy lean for 5s; duration + inflation + term premium for 10s/30s.
  // Term premium and real yields are two-sided: wide/high pay duration, compressed/low tax it.
  const tpTerm = 0.85 * tpZ;
  const realPay = 0.7 * realZ;
  const t5Net = easeW(tSc) - tightW(tSc);
  const t10Net = d + flight * 0.8 - easeW(iSc) * 0.7 + tpTerm + realPay;
  const t30Net = d + flight * 0.8 - easeW(iSc) + tightW(iSc) * 0.5 + tpTerm + realPay;
  const t5 = gradeTenor("5", t5Net, tenorCtx, 1);
  t5.margin = blendMargin(t5.stance, t5Net, rImp);
  const t10 = gradeTenor("10", t10Net, tenorCtx, 2);
  const t30 = gradeTenor("30", t30Net, tenorCtx, 2);
  t10.margin = blendMargin(t10.stance, clampMargin(t10Net / 2), meanImpulse([rImp, -iImp]));
  t30.margin = blendMargin(t30.stance, clampMargin(t30Net / 2), -iImp);
  if (tpZ < -0.35 && t10.stance === "in") {
    t10.why = (t10.why || "") + " Term premium is compressed — duration is not paid.";
  } else if (tpZ > 0.35 && t10.stance !== "out") {
    t10.why = (t10.why || "") + " Term premium is wide — duration is paid.";
  }
  if (realZ > 0.35 && (t10.stance === "in" || t30.stance === "in")) {
    const tip = " Real 10y yields are high — duration is paid.";
    if (t10.stance === "in" && !t10.why.includes("duration is paid")) t10.why += tip;
    if (t30.stance === "in" && !t30.why.includes("duration is paid")) t30.why += tip;
  }
  const tenorSet = new Set([t5.stance, t10.stance, t30.stance]);
  // Parent is the long end. Carrying the 5-year at even a fifth of the weight
  // did not soften a taxed front end, it vetoed a paid long end: whenever Rates
  // is tight the 5-year net pins at −1, which lifts the bar on the 10s and 30s
  // from the 0.35 a tenor needs on its own to 0.69 each. The strip could show
  // Treasuries mixed with both long tenors in favor, and the parent went the
  // whole of 2021-2026 without one in-favor day. The front end is the Rates
  // light's job — it is reported here, not voted twice.
  const ustAvgNet = 0.5 * t10Net + 0.5 * t30Net;
  const ustStance = netCall(ustAvgNet, 0.35, -0.35);
  let ustWhy = `Curve is split — 5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}.`;
  if (tenorSet.size === 1 && ustStance === t10.stance) {
    if (ustStance === "out") {
      ustWhy =
        tpZ < -0.35
          ? "The curve is taxed — term premium is compressed and duration is not paid."
          : "The whole curve is taxed — policy, duration, and inflation aren’t paying.";
    } else if (ustStance === "in") {
      ustWhy =
        tpZ > 0.35 || realZ > 0.35
          ? "The whole curve can work — duration is paid on term premium or real yield."
          : "The whole curve can work — policy, duration, and inflation aren’t the tax.";
    } else {
      ustWhy = "The whole curve is mixed — no clean duration bid.";
    }
  } else if (ustStance === "out") {
    ustWhy = `The curve leans out (5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}).`;
  } else if (ustStance === "in") {
    ustWhy = `The curve leans in (5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}).`;
  }
  if (tpZ < -0.35 && ustStance !== "in" && !ustWhy.includes("term premium")) {
    ustWhy += " Term premium is compressed — long bonds are not paid.";
  } else if (tpZ > 0.35 && ustStance === "in" && !ustWhy.includes("term premium")) {
    ustWhy += " Term premium is wide — long bonds are paid.";
  }
  const treasuries = {
    id: "treasuries",
    name: "Treasuries",
    stance: ustStance,
    why: ustWhy,
    margin: clampMargin((t5.margin + t10.margin + t30.margin) / 3),
    tenors: [t5, t10, t30],
  };

  const igOutParts = [];
  if (durationDir === "rising") {
    igOutParts.push("rising yields tax the duration in investment-grade bonds");
  }
  if (creditDir === "rising") igOutParts.push("cash-flow doubt is hitting credit");
  const igNet =
    (creditDir === "falling" ? 0.55 : creditDir === "rising" ? -0.55 : 0) +
    (durationDir === "rising" ? -0.55 : durationDir === "falling" ? 0.35 : 0);
  const ig = instrumentFromNet(
    "ig",
    "IG",
    igNet,
    "Spreads can tighten and duration is not fighting you.",
    sentence(
      igOutParts,
      "Either cash-flow doubt or rising yields — investment-grade bonds get hit from one side or both."
    ),
    "Investment-grade credit sits between duration and credit risk; neither side is giving a clean signal."
  );
  ig.label = "Investment grade";
  ig.margin = blendMargin(ig.stance, ig.net, meanImpulse([rImp, -iImp, kImp]));

  const hyOutParts = [];
  if (creditDir === "rising") {
    const named = (creditUpParts || []).filter(Boolean);
    if (named.length) hyOutParts.push(...named);
    else hyOutParts.push("credit risk is rising");
  }
  // Soft growth / drain / tights only take HY out while fear is still calm —
  // once fear is expensive the bounce is often already the trade.
  if (tightW(gSc) > 0.55 && easeW(rSc) > 0.4) hyOutParts.push("growth is soft while fear is still cheap");
  if (tightW(lSc) > 0.55 && easeW(rSc) > 0.4) hyOutParts.push("cash is draining while fear is still cheap");
  if (spreadZ < -0.35 && easeW(rSc) > 0.4) hyOutParts.push("spreads are tight — you are not paid");
  if (tightW(rSc) > 0.55) hyOutParts.push("fear is already expensive — the easy out call is late");
  const calm = easeW(rSc);
  // Credit on 1m: wide spreads + collectible coupons pay; tight spreads into calm
  // fear are not paid (late). Soft growth into calm is the other out.
  const hyNet =
    (creditDir === "falling" ? 0.5 : 0) -
    (creditDir === "rising" ? 0.4 * Math.max(calm, 0.35) : 0) +
    0.3 * easeW(gSc) -
    0.5 * tightW(gSc) * calm -
    0.2 * tightW(lSc) * calm +
    0.5 * spreadZ -
    0.25 * Math.max(0, -spreadZ) * calm;
  const hy = instrumentFromNet(
    "hy",
    "HY",
    hyNet,
    spreadZ > 0.35
      ? "Spreads are wide and growth still says coupons get paid."
      : "Growth and risk appetite still say coupons get paid.",
    sentence(hyOutParts, "High yield is the first credit to get hurt."),
    "High yield needs both growth and calm fear; only one side is helping.",
    0.26,
    -0.26
  );
  hy.label = "High yield";
  hy.margin = blendMargin(hy.stance, hy.net, meanImpulse([gImp, kImp, hyImp]));

  let creditStance = netCall((ig.net + hy.net) / 2, 0.24, -0.26);
  let creditWhy = `Investment grade ${ig.stance}, high yield ${hy.stance} — duration and cash-flow aren’t the same trade.`;
  if (ig.stance === hy.stance) {
    if (creditStance === "out") {
      creditWhy =
        spreadZ < -0.35
          ? "Investment grade and high yield are both out — rising yields tax investment-grade bonds, and spreads are too tight to pay."
          : "Investment grade and high yield are both out — duration and cash-flow risk are both up.";
    } else if (creditStance === "in") {
      creditWhy =
        spreadZ > 0.35
          ? "Investment grade and high yield are both in — spreads are wide enough to pay and coupons still look collectible."
          : "Investment grade and high yield are both in — spreads can tighten and coupons still look collectible.";
    } else {
      creditWhy = "Investment grade and high yield are both mixed.";
    }
  } else if (creditStance === "in") {
    creditWhy = `Credit leans in — investment grade ${ig.stance}, high yield ${hy.stance}.`;
  } else if (creditStance === "out") {
    creditWhy = `Credit leans out — investment grade ${ig.stance}, high yield ${hy.stance}.`;
  }
  const credit = {
    id: "credit",
    name: "Credit",
    stance: creditStance,
    why: creditWhy,
    margin: clampMargin((ig.margin + hy.margin) / 2),
    splits: [ig, hy],
  };

  // Equities on 1m: fear-expensive days pay (risk premium open). Soft-growth
  // “outs” bounce. The late trade is firm growth while fear is still cheap.
  const calmRisk = easeW(rSc);
  const fearW = tightW(rSc);
  const stocksInParts = [];
  if (fearW > 0.55) stocksInParts.push("fear is expensive — the risk premium is open");
  if (erpZ > 0.35 && calmRisk < 0.55) {
    stocksInParts.push("earnings yield is wide vs real 10y while fear isn’t complacent");
  }
  if (tightW(gSc) > 0.55 && fearW > 0.4) {
    stocksInParts.push("growth is soft into expensive fear — the bounce sample");
  }
  const stocksOutParts = [];
  if (easeW(gSc) > 0.55 && calmRisk > 0.55) {
    stocksOutParts.push("growth is firm while fear is still cheap — late to the expansion");
  }
  if (tightW(lSc) > 0.55 && calmRisk > 0.55 && easeW(gSc) > 0.4) {
    stocksOutParts.push("cash is draining into a still-calm tape");
  }
  const stocksNet =
    0.55 * fearW +
    0.4 * Math.max(0, erpZ) * (1 - calmRisk * 0.5) -
    0.65 * easeW(gSc) * calmRisk -
    0.35 * tightW(lSc) * calmRisk +
    0.2 * tightW(gSc) * fearW;
  const cycNet =
    0.4 * fearW -
    0.8 * easeW(gSc) * calmRisk +
    0.3 * Math.max(0, erpZ) * (1 - calmRisk * 0.5) +
    0.15 * tightW(gSc) * fearW;
  const defNet =
    0.6 * fearW +
    0.35 * tightW(gSc) * fearW -
    0.4 * easeW(gSc) * calmRisk;
  const cyc = instrumentFromNet(
    "cyc",
    "Cy",
    cycNet,
    sentence(stocksInParts, "Risk premium is open — cyclicals usually lead the bounce."),
    sentence(stocksOutParts, "Firm growth with cheap fear — cyclicals are late to that expansion."),
    "Cyclicals want paid fear, not complacent strength; only one side is helping."
  );
  cyc.label = "Cyclicals";
  cyc.margin = blendMargin(cyc.stance, cyc.net, meanImpulse([gImp, kImp]));
  const def = instrumentFromNet(
    "def",
    "Df",
    defNet,
    fearW > 0.55
      ? "Fear is expensive — defensives are the ballast inside the risk-premium bid."
      : "Soft growth into fear — defensives usually hold up better than the cycle.",
    "Firm growth and calm fear — defensives usually lag that mix.",
    "Defensives want expensive fear or soft growth; complacent strength leaves them mixed."
  );
  def.label = "Defensives";
  def.margin = blendMargin(def.stance, def.net, meanImpulse([-gImp, -kImp]));
  const stocks = instrumentFromNet(
    "stocks",
    "Equities",
    stocksNet,
    sentence(stocksInParts, "Fear is expensive — risk assets usually get paid for the premium."),
    sentence(stocksOutParts, "Equities are out of favor here."),
    erpZ > 0.35 && calmRisk > 0.55
      ? "Earnings yield is wide, but fear is still cheap — not a clean overweight."
      : "Neither paid fear nor late-expansion complacency is loud enough for a clean call.",
    0.1,
    -0.18
  );
  stocks.margin = blendMargin(stocks.stance, stocks.net, meanImpulse([gImp, kImp]));
  stocks.splits = [cyc, def];

  // Crypto on 1m: easy plumbing into cheap fear is late (dump). Drain into fear
  // is the bounce. Keep a mild easy-plumbing bid when fear is already paid.
  const cryptoOutParts = [];
  if (easeW(lSc) > 0.55 && calmRisk > 0.55) {
    cryptoOutParts.push("plumbing is easy while fear is still cheap — late to the liquidity bid");
  }
  if (dolStrong && calmRisk > 0.45) cryptoOutParts.push("the dollar is rising into calm fear");
  if (realZ > 0.45 && calmRisk > 0.45) cryptoOutParts.push("real yields are high — the high-beta valve is taxed");
  const cryptoInParts = [];
  if (tightW(lSc) > 0.45 && fearW > 0.35) {
    cryptoInParts.push("cash is draining into paid fear — the bounce sample");
  }
  if (easeW(lSc) > 0.55 && fearW > 0.45) {
    cryptoInParts.push("plumbing is easy while fear is already paid");
  }
  if (realZ < -0.35 && fearW > 0.3) {
    cryptoInParts.push("real yields are low while fear is paid — discount rate helps the valve");
  }
  const cryptoNet =
    0.45 * tightW(lSc) * Math.max(fearW, 0.25) +
    0.35 * easeW(lSc) * fearW -
    0.75 * easeW(lSc) * calmRisk -
    0.3 * realZ * calmRisk -
    (dolStrong ? 0.35 : 0) * Math.max(calmRisk, 0.3) +
    0.2 * fearW;
  const crypto = instrumentFromNet(
    "crypto",
    "Crypto",
    cryptoNet,
    sentence(cryptoInParts, "Drain into fear — Bitcoin is the high-beta bounce valve."),
    sentence(cryptoOutParts, "Easy plumbing into cheap fear — the high-beta valve usually dumps."),
    "Crypto wants paid fear or a clean drain; complacent easy plumbing is late.",
    0.14,
    -0.24
  );
  crypto.margin = blendMargin(crypto.stance, crypto.net, meanImpulse([lImp, kImp]));

  const goldDrain = tightW(lSc) > 0.55 && tightW(tSc) < 0.45;
  const goldCrisis = tightW(lSc) > 0.45 && tightW(rSc) > 0.45;
  const cotS = seriesOk(snap, "GOLD_COT");
  const cotZ =
    cotS?.anchor?.score != null && Number.isFinite(cotS.anchor.score)
      ? clampMargin(cotS.anchor.score)
      : 0;
  // Gold on 1m: bare low reals were half the old “in” sample and lost money.
  // Crisis / drain still pay. Inflation hedge when Hot and real yields are high.
  // Soft dollar + Cold is the deflation-fear bid. Low reals without crisis = out
  // (easy-money risk-on where gold lags). Rising dollar alone is not the out.
  // Crowded speculative longs tax the box (rich positioning); light longs help.
  const goldInParts = [];
  if (goldCrisis) goldInParts.push("cash is draining and fear is expensive — gold’s crisis bid");
  if (goldDrain && !dolStrong) goldInParts.push("cash is draining without a dollar squeeze");
  if (dolSoft && tightW(iSc) > 0.55) {
    goldInParts.push("the dollar is soft and inflation is cold — deflation-fear bid");
  }
  if (realHigh && easeW(iSc) > 0.55) {
    goldInParts.push("inflation is hot and real yields are high — gold’s inflation wage");
  }
  if (cotZ > 0.45) goldInParts.push("speculative longs are light — the crowding tax is off");
  const goldOutParts = [];
  if (realLow && !goldCrisis) {
    goldOutParts.push("real 10y yields are low without a crisis bid — gold lags easy-money risk-on");
  }
  if (cotZ < -0.45) goldOutParts.push("speculative longs are crowded");
  let goldMix = "Gold has no clean job right now.";
  if (realHigh && easeW(iSc) <= 0.55 && !goldCrisis && !(goldDrain && !dolStrong)) {
    goldMix =
      "Real yields are high without hot inflation or a crisis bid — not a clean gold overweight.";
  } else if (dolStrong && !goldCrisis && !realLow) {
    goldMix = "The dollar is rising — gold rarely leads that mix without a crisis bid.";
  } else if (!goldCrisis && !(goldDrain && !dolStrong)) {
    goldMix = "Gold has no job right now — don’t treat it as a liquidity vote.";
  }
  const goldNet =
    (goldCrisis ? 0.65 : 0) +
    (goldDrain && !dolStrong ? 0.4 : 0) +
    (dolSoft && tightW(iSc) > 0.55 ? 0.45 : 0) +
    (realHigh && easeW(iSc) > 0.55 ? 0.5 : 0) -
    (realLow && !goldCrisis ? 0.65 : 0) +
    0.35 * cotZ;
  const gold = instrumentFromNet(
    "gold",
    "Gold",
    goldNet,
    sentence(goldInParts, "Crisis plumbing, inflation wage, or deflation fear — gold’s usual bid."),
    sentence(goldOutParts, "Easy real yields without a crisis — gold rarely leads that mix."),
    goldMix,
    0.18,
    -0.18
  );
  gold.margin = blendMargin(gold.stance, gold.net, meanImpulse([-kImp, iImp]));

  const wtiImp = hzImp(seriesOk(snap, "WTI"), horizon);
  const wtiMom = wtiImp.score != null ? impulseUnit(wtiImp) : 0;
  // Continuous dollar: DOLLAR_YOY anchor is inverted (rising $ → negative score).
  const dolZ = (() => {
    const d = seriesOk(snap, "DOLLAR_YOY");
    if (d?.anchor?.score != null && Number.isFinite(d.anchor.score)) return -d.anchor.score;
    return dolStrong ? 0.7 : dolSoft ? -0.7 : 0;
  })();
  // Cmdty on 1m: firm growth into calm fear is late for oil/copper (same as equities).
  // Soft growth into fear is the bounce. Dollar taxes continuously; WTI lookback
  // sits in the oil net, not only the why text.
  const oilInParts = [];
  if (tightW(gSc) > 0.55 && fearW > 0.4) oilInParts.push("growth is soft into expensive fear — the bounce sample");
  if (dolZ < -0.35) oilInParts.push("the dollar isn’t taxing dollar oil");
  if (easeW(iSc) > 0.55) oilInParts.push("inflation is hot — crude’s price bid");
  if (wtiImp.dir === "up") oilInParts.push("crude is firm this window");
  const oilOutParts = [];
  if (easeW(gSc) > 0.55 && calmRisk > 0.55) {
    oilOutParts.push("growth is firm while fear is still cheap — late to the industrial bid");
  }
  if (dolZ > 0.35) oilOutParts.push("the dollar is rising");
  if (tightW(iSc) > 0.55) oilOutParts.push("inflation is cold — crude rarely leads");
  if (wtiImp.dir === "down") oilOutParts.push("crude is soft this window");
  const oilNet =
    0.45 * tightW(gSc) * fearW -
    0.55 * easeW(gSc) * calmRisk -
    0.4 * dolZ +
    0.3 * easeW(iSc) -
    0.15 * tightW(iSc) +
    0.25 * wtiMom +
    0.2 * easeW(gSc) * (1 - calmRisk);
  const oil = instrumentFromNet(
    "oil",
    "Oi",
    oilNet,
    sentence(oilInParts, "Soft growth into fear or a cooperative dollar — oil usually gets paid."),
    sentence(oilOutParts, "Firm growth into cheap fear or a rising dollar — oil rarely leads."),
    "Oil wants paid fear or a soft dollar; complacent strength is late.",
    0.12,
    -0.22
  );
  oil.label = "Oil";
  oil.margin = blendMargin(oil.stance, oil.net, meanImpulse([gImp, wtiMom]));
  const copperNet =
    0.4 * tightW(gSc) * fearW -
    0.55 * easeW(gSc) * calmRisk -
    0.3 * dolZ +
    0.2 * easeW(gSc) * (1 - calmRisk);
  const copper = instrumentFromNet(
    "copper",
    "Cu",
    copperNet,
    "Soft growth into fear — copper’s bounce sample.",
    "Firm growth into cheap fear — copper is late to that industrial bid.",
    "Copper wants paid fear or soft growth; complacent strength leaves it mixed.",
    0.12,
    -0.22
  );
  copper.label = "Copper";
  copper.margin = blendMargin(copper.stance, copper.net, gImp);

  let cmdtyStance = netCall((oil.net + copper.net) / 2, 0.12, -0.22);
  let cmdtyWhy = `Oil ${oil.stance}, copper ${copper.stance} — growth and the dollar aren’t the same trade as the industrial metal.`;
  if (oil.stance === copper.stance) {
    cmdtyWhy =
      cmdtyStance === "in"
        ? "Oil and copper are both in — soft growth into fear or a cooperative dollar."
        : cmdtyStance === "out"
          ? "Oil and copper are both out — firm growth into cheap fear or a rising dollar."
          : "Oil and copper are both mixed.";
  } else if (cmdtyStance === "in") {
    cmdtyWhy = `Commodities lean in — oil ${oil.stance}, copper ${copper.stance}.`;
  } else if (cmdtyStance === "out") {
    cmdtyWhy = `Commodities lean out — oil ${oil.stance}, copper ${copper.stance}.`;
  }
  const cmdty = {
    id: "cmdty",
    name: "Commodity",
    stance: cmdtyStance,
    why: cmdtyWhy,
    margin: clampMargin((oil.margin + copper.margin) / 2),
    splits: [oil, copper],
  };

  return {
    pair: { line: pairLine, why: pairWhy },
    items: [treasuries, credit, stocks, crypto, gold, cmdty],
  };
}

/**
 * Map light club + key series into duration / credit stance + confirm / falsify.
 * @returns {{ past: string, duration: object, credit: object, favor: object, confirm: string[], falsify: string[], lines: string[] }}
 */
export function buildMeaning(snap, horizon = DEFAULT_IMPULSE) {
  if (snap?.valCenter) setValCenter(snap.valCenter);
  const lights = snap?.lights || {};
  const L = stateOf(lights, "liquidity");
  const T = stateOf(lights, "rates");
  const G = stateOf(lights, "growth");
  const I = stateOf(lights, "inflation");
  const R = stateOf(lights, "risk");
  const lSc = lightUnit(lights, "liquidity");
  const tSc = lightUnit(lights, "rates");
  const gSc = lightUnit(lights, "growth");
  const iSc = lightUnit(lights, "inflation");
  const rSc = lightUnit(lights, "risk");
  const past = pastWindow(horizon);
  const Iimp = lights.inflation?.impulse?.dir || "flat";
  const Gimp = lights.growth?.impulse?.dir || "flat";
  const iImpSc = impulseUnit(lights.inflation?.impulse);
  const gImpSc = impulseUnit(lights.growth?.impulse);

  const impulse = seriesOk(snap, "CREDIT_IMPULSE");
  const chinaImpulse = seriesOk(snap, "CHINA_CREDIT_IMPULSE");
  const nomReal = seriesOk(snap, "NOM_REAL_SPREAD");
  const sbCorr = seriesOk(snap, "STOCK_BOND_CORR");
  const realY = seriesOk(snap, "DFII10");
  const dgs10 = seriesOk(snap, "DGS10");
  const hy = seriesOk(snap, "BAMLH0A0HYM2");
  const btc = seriesOk(snap, "BTC");
  const gold = seriesOk(snap, "GOLD");
  const dollar = seriesOk(snap, "DTWEXBGS");

  const creditFlow = hzImp(impulse, horizon);
  const chinaFlow = hzImp(chinaImpulse, horizon);
  const sbImp = hzImp(sbCorr, horizon);
  const realYImp = hzImp(realY, horizon);
  const hyImp = hzImp(hy, horizon);

  // Duration net: positive = duration risk falling (bonds helped).
  // Continuous inflation/rates scores — no Hot/Mid cliff at 0.45.
  let durationDir = "mixed";
  let durationLabel = "Duration risk mixed";
  let durationLine = "";

  const tpZ = termPremiumZ(snap);
  const realZ = real10Z(snap);
  const hotNotCooling = easeW(iSc) * (Iimp === "down" ? 0.25 : 1);
  const coldInfl = tightW(iSc);
  const coolingRelief = easeW(iSc) * (Iimp === "down" ? 0.55 : 0);
  // Term premium and real yields are two-sided: paid (+z) eases duration risk.
  let durNet =
    -0.7 * hotNotCooling +
    0.65 * coldInfl +
    0.45 * coolingRelief -
    0.55 * tightW(tSc) +
    0.35 * easeW(tSc) +
    0.7 * tpZ +
    0.55 * realZ -
    0.25 * easeW(gSc) * (1 - tightW(iSc));

  const durationUpParts = [];
  if (hotNotCooling > 0.45) durationUpParts.push("inflation is still hot and not cooling this window");
  if (tightW(tSc) > 0.55 && realZ < 0.35) durationUpParts.push("funding is tight");
  if (tpZ < -0.35) durationUpParts.push("term premium is compressed — duration is not paid");
  if (easeW(gSc) > 0.55 && tightW(iSc) < 0.4 && hotNotCooling < 0.45 && tightW(tSc) < 0.45 && tpZ >= -0.2) {
    durationUpParts.push("firm growth is keeping a premium in the long end");
  }

  if (durNet <= -0.35) {
    durationDir = "rising";
    durationLabel = "Duration risk rising";
    durationLine = durationUpParts.length
      ? `Long bonds aren’t getting paid — ${joinEnglish(durationUpParts)}, so present value stays under pressure.`
      : "Long bonds aren’t getting paid for the risk, so present value stays under pressure.";
  } else if (durNet >= 0.35) {
    durationDir = "falling";
    durationLabel = "Duration risk falling";
    durationLine =
      realZ > 0.35 || tpZ > 0.35
        ? "Duration is paid — wide term premium or high real yields open room for long bonds if inflation isn’t fighting you."
        : coolingRelief > 0.3
          ? "Inflation is still high but cooling this window — duration gets a look if funding isn’t fighting you."
          : "Long bonds can work again — cooler inflation and softer funding open room for duration if credit stays calm.";
  } else {
    durationDir = "mixed";
    durationLabel = "Duration risk mixed";
    durationLine = coolingRelief > 0.3
      ? "Hot but cooling — the level still taxes duration; the turn is the reason not to treat 30s as a clean avoid."
      : "Duration is split — parts of the rates complex ease while inflation or growth still keep long bonds from a clean bid.";
  }

  if (realZ > 0.45 && durationDir === "rising") {
    durationLine += " Real 10y yields are high — you are paid on the rate, but inflation or funding still tax present value.";
  } else if (realZ > 0.45 && durationDir !== "rising" && !durationLine.includes("real")) {
    durationLine += " Real 10y yields are high — duration is paid.";
  } else if (realYImp.dir === "up" && durationDir !== "falling") {
    durationLine += " Real 10y yields are rising this window — discount rates still bite.";
  }
  if (tpZ < -0.35 && !durationLine.includes("term premium")) {
    durationLine += " Term premium is compressed — you are not paid for duration risk.";
  } else if (tpZ > 0.35 && durationDir === "falling" && !durationLine.includes("term premium")) {
    durationLine += " Term premium is wide — you are paid for duration risk.";
  }

  // Credit net: positive = credit risk falling. Symmetric ease/stress weights.
  let creditDir = "mixed";
  let creditLabel = "Credit risk mixed";
  let creditLine = "";

  const creditUpParts = [];
  if (tightW(gSc) > 0.55) creditUpParts.push("growth is soft");
  if (tightW(rSc) > 0.55) creditUpParts.push("fear is expensive");
  if (Gimp === "down" || gImpSc < -0.25) creditUpParts.push("activity is rolling over this window");
  if (hyImp.dir === "up") creditUpParts.push("high-yield spreads are widening this window");
  const impulseSlow = creditFlow.dir === "down";
  const chinaSlow = chinaFlow.dir === "down";
  if (impulseSlow && creditUpParts.length) {
    creditUpParts.push("bank credit impulse is slowing");
  }
  if (chinaSlow && creditUpParts.length) {
    creditUpParts.push("China credit impulse is slowing");
  }

  let creditNet =
    0.35 * easeW(gSc) -
    0.35 * tightW(gSc) +
    0.35 * easeW(rSc) -
    0.35 * tightW(rSc) -
    (Gimp === "down" || gImpSc < -0.25 ? 0.3 : 0) +
    (gImpSc > 0.25 ? 0.2 : 0) -
    (hyImp.dir === "up" ? 0.3 : 0) +
    (hyImp.dir === "down" ? 0.2 : 0) -
    (impulseSlow ? 0.35 : 0) +
    (creditFlow.dir === "up" ? 0.35 : 0) -
    (chinaSlow ? 0.15 : 0) +
    (chinaFlow.dir === "up" ? 0.15 : 0) +
    0.25 * creditSpreadZ(snap);

  if (creditNet <= -0.35) {
    creditDir = "rising";
    creditLabel = "Credit risk rising";
    creditLine = sentence(creditUpParts, "Credit risk is waking up — cash flows look less certain.");
  } else if (creditNet >= 0.35) {
    creditDir = "falling";
    creditLabel = "Credit risk falling";
    creditLine =
      "Credit risk is being paid down — firm growth and quiet risk premia say cash flows still look collectible.";
  } else if (impulseSlow && creditNet > -0.2) {
    creditDir = "mixed";
    creditLabel = "Credit risk mixed";
    creditLine =
      "Bank credit impulse is cooling from a still-easy level — not enough on its own to call credit risk up.";
  } else {
    creditDir = "mixed";
    creditLabel = "Credit risk mixed";
    creditLine =
      "Credit is split — Growth and Risk aren’t telling the same story on cash-flow certainty.";
  }

  if (creditFlow.dir === "up" && !creditLine.includes("impulse")) {
    creditLine += ` Bank credit impulse is accelerating this window — private lending is adding fuel.`;
  } else if (creditFlow.dir === "down" && !creditLine.includes("impulse")) {
    creditLine += ` Bank credit impulse is decelerating this window — private lending is not confirming easy plumbing.`;
  }
  if (chinaFlow.dir === "up" && !creditLine.includes("China credit")) {
    creditLine += ` China credit impulse is accelerating this window — Asia’s credit cycle is adding fuel.`;
  } else if (chinaFlow.dir === "down" && !creditLine.includes("China credit")) {
    creditLine += ` China credit impulse is decelerating this window — Asia’s credit cycle is not confirming easy plumbing.`;
  }

  const confirm = [];
  const falsify = [];

  if (L === "tight" && R === "easing") {
    confirm.push(
      "Cash is draining while fear stays cheap — the tape hasn’t priced the liquidity squeeze yet."
    );
    falsify.push(
      "Falsify if Risk flips Risk-off or high-yield spreads blow out while Liquidity stays Tightening."
    );
  } else if (L === "easing" && R === "tight") {
    confirm.push(
      "Cash is easier while markets still pay for fear — liquidity isn’t buying a clean risk-on."
    );
    falsify.push("Falsify if Risk flips Risk-on and stays there while Liquidity stays Easing.");
  } else if (L === "easing" && R === "easing") {
    confirm.push("Liquidity and risk appetite agree — fuel and the tape are pointed the same way.");
  } else if (L === "tight" && R === "tight") {
    confirm.push("Liquidity and risk appetite agree on stress — drain plus fear.");
  }

  if (G === "easing" && I === "easing") {
    confirm.push(
      "Strong growth with hot inflation is a classic mix that hurts long bonds — credit can still look fine until the Fed or the long end bites."
    );
    falsify.push("Falsify if Inflation flips Cold while Growth stays Strong — the duration call softens.");
  }

  if (durationDir === "rising" && creditDir === "rising") {
    falsify.push(
      "Falsify if inflation cools this window and bank credit impulse turns up — both risk calls soften."
    );
  }

  if (btc && L === "tight") {
    const bd = hzImp(btc, horizon).dir;
    if (bd === "up") {
      confirm.push(
        "Bitcoin is not confirming the cash drain — treat it as an output disagreement, not a liquidity vote."
      );
    } else if (bd === "down") {
      confirm.push("Bitcoin is soft with draining cash — the liquidity release valve is confirming.");
    }
  }

  if (gold && L === "tight" && hzImp(gold, horizon).dir === "up") {
    confirm.push(
      "Gold is strong while cash drains — not a clean plumbing confirmation; gold is doing another job."
    );
  }

  if (sbCorr && sbImp.dir === "up") {
    confirm.push(
      "Stock–bond correlation is rising this window — diversification is weaker; duration and credit can hurt together."
    );
  } else if (sbCorr && sbImp.dir === "down") {
    confirm.push(
      "Stock–bond correlation is falling this window — classic balancers can still hedge each other."
    );
  }

  if (dollar && T === "tight" && hzImp(dollar, horizon).dir === "up") {
    confirm.push("A strong dollar is part of the tight rates story — global USD liquidity is scarce.");
  }

  if (dgs10 && durationDir === "rising" && hzImp(dgs10, horizon).dir === "up") {
    confirm.push("The 10y yield is rising this window — markets are already marking duration risk up.");
  }

  const favor = buildFavor(lights, durationDir, creditDir, snap, horizon, creditUpParts);
  const cmdtyStance = favor.items.find((x) => x.id === "cmdty")?.stance;
  const copperDir = hzImp(seriesOk(snap, "COPPER"), horizon).dir;
  const wtiDir = hzImp(seriesOk(snap, "WTI"), horizon).dir;
  if (cmdtyStance === "in") {
    if (copperDir === "down") {
      confirm.push(
        "Copper is soft while commodities are still in — treat it as an output disagreement, not a vote."
      );
    } else     if (copperDir === "up") {
      confirm.push("Copper is firm with Strong growth — the industrial tape is confirming.");
    }
    if (wtiDir === "down") {
      confirm.push(
        "Oil is soft while commodities are still in — treat it as an output disagreement, not a vote."
      );
    } else if (wtiDir === "up") {
      confirm.push("Oil is firm with Strong growth — the crude tape is confirming.");
    }
  } else if (cmdtyStance === "out") {
    if (copperDir === "up") {
      confirm.push(
        "Copper is firm while commodities are out — treat it as an output disagreement, not a vote."
      );
    } else if (copperDir === "down") {
      confirm.push("Copper is soft with the real cycle out — the tape is confirming.");
    }
    if (wtiDir === "up") {
      confirm.push(
        "Oil is firm while commodities are out — treat it as an output disagreement, not a vote."
      );
    } else if (wtiDir === "down") {
      confirm.push("Oil is soft with the real cycle out — the tape is confirming.");
    }
  }

  const lines = [durationLine, creditLine, ...confirm.slice(0, 3), ...falsify.slice(0, 2)].filter(
    Boolean
  );

  return {
    past,
    horizon,
    duration: { dir: durationDir, label: durationLabel, line: durationLine },
    credit: { dir: creditDir, label: creditLabel, line: creditLine },
    favor,
    confirm,
    falsify,
    lines,
    snapshot: {
      liquidity: wordOf(lights, "liquidity"),
      rates: wordOf(lights, "rates"),
      growth: wordOf(lights, "growth"),
      inflation: wordOf(lights, "inflation"),
      risk: wordOf(lights, "risk"),
      creditImpulse: impulse?.latest ?? null,
      nomRealSpread: nomReal?.latest ?? null,
      stockBondCorr: sbCorr?.latest ?? null,
    },
  };
}

export { pastWindow };
