/**
 * Regime → duration risk / credit risk → six asset classes (in / mixed / out).
 * Lights are levels. The 1w/2w/1m lookback only nudges needle position.
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

/** Term premium compressed — long bonds are not paid for duration risk. */
function termPremiumUnpaid(snap) {
  const tp = seriesOk(snap, "THREEFFTP10");
  return tp?.latest != null && Number.isFinite(tp.latest) && tp.latest < 0.75;
}

/** Market 10y real yield already high — discount rates bite. */
function real10High(snap, thresh = 1.5) {
  const r = seriesOk(snap, "DFII10");
  return r?.latest != null && Number.isFinite(r.latest) && r.latest > thresh;
}

/** Market 10y real yield low/negative — gold’s usual wage from rates. */
function real10Low(snap, thresh = 0.5) {
  const r = seriesOk(snap, "DFII10");
  return r?.latest != null && Number.isFinite(r.latest) && r.latest < thresh;
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

  const tpUnpaid = termPremiumUnpaid(snap);
  const realHigh = real10High(snap);
  const realLow = real10Low(snap);
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
  const tpTax = tpUnpaid ? -0.85 : 0;
  const t5Net = easeW(tSc) - tightW(tSc);
  const t10Net = d + flight * 0.8 - easeW(iSc) * 0.7 + tpTax;
  const t30Net = d + flight * 0.8 - easeW(iSc) + tightW(iSc) * 0.5 + tpTax;
  const t5 = gradeTenor("5", t5Net, tenorCtx, 1);
  t5.margin = blendMargin(t5.stance, t5Net, rImp);
  const t10 = gradeTenor("10", t10Net, tenorCtx, 2);
  const t30 = gradeTenor("30", t30Net, tenorCtx, 2);
  t10.margin = blendMargin(t10.stance, clampMargin(t10Net / 2), meanImpulse([rImp, -iImp]));
  t30.margin = blendMargin(t30.stance, clampMargin(t30Net / 2), -iImp);
  if (tpUnpaid && t10.stance === "in") {
    t10.why = (t10.why || "") + " Term premium is compressed — duration is not paid.";
  }
  const tenorSet = new Set([t5.stance, t10.stance, t30.stance]);
  // Parent follows the curve average — a 5s/30s split is not an automatic mixed.
  const ustAvgNet = (t5Net + t10Net + t30Net) / 3;
  const ustStance = netCall(ustAvgNet, 0.35, -0.35);
  let ustWhy = `Curve is split — 5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}.`;
  if (tenorSet.size === 1 && ustStance === t10.stance) {
    if (ustStance === "out") {
      ustWhy = tpUnpaid
        ? "The curve is taxed — term premium is compressed and duration is not paid."
        : "The whole curve is taxed — policy, duration, and inflation aren’t paying.";
    } else if (ustStance === "in") {
      ustWhy = "The whole curve can work — policy, duration, and inflation aren’t the tax.";
    } else {
      ustWhy = "The whole curve is mixed — no clean duration bid.";
    }
  } else if (ustStance === "out") {
    ustWhy = `The curve leans out (5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}).`;
  } else if (ustStance === "in") {
    ustWhy = `The curve leans in (5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}).`;
  }
  if (tpUnpaid && ustStance !== "in" && !ustWhy.includes("term premium")) {
    ustWhy += " Term premium is compressed — long bonds are not paid.";
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

  const hyPrint = seriesOk(snap, "BAMLH0A0HYM2");
  const hyTights = hyPrint?.anchor?.score != null && hyPrint.anchor.score >= 0.85;
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
  if (hyTights && easeW(rSc) > 0.4) hyOutParts.push("spreads are at cycle tights — you are not paid");
  if (tightW(rSc) > 0.55) hyOutParts.push("fear is already expensive — the easy out call is late");
  const calm = easeW(rSc);
  // Credit “out” only while fear is still calm — risk-off outs are bounce days.
  const hyNet =
    (creditDir === "falling" ? 0.55 : 0) -
    (creditDir === "rising" ? 0.4 * Math.max(calm, 0.35) : 0) +
    0.35 * easeW(gSc) -
    0.5 * tightW(gSc) * calm -
    0.2 * tightW(lSc) * calm -
    (hyTights ? 0.5 * calm : 0);
  const hy = instrumentFromNet(
    "hy",
    "HY",
    hyNet,
    "Growth and risk appetite still say coupons get paid.",
    sentence(hyOutParts, "High yield is the first credit to get hurt."),
    "High yield needs both growth and calm fear; only one side is helping.",
    0.28,
    -0.28
  );
  hy.label = "High yield";
  hy.margin = blendMargin(hy.stance, hy.net, meanImpulse([gImp, kImp, hyImp]));

  let creditStance = netCall((ig.net + hy.net) / 2, 0.28, -0.28);
  let creditWhy = `Investment grade ${ig.stance}, high yield ${hy.stance} — duration and cash-flow aren’t the same trade.`;
  if (ig.stance === hy.stance) {
    if (creditStance === "out") {
      creditWhy = hyTights
        ? "Investment grade and high yield are both out — rising yields tax investment-grade bonds, and high-yield spreads are too tight to pay."
        : "Investment grade and high yield are both out — duration and cash-flow risk are both up.";
    } else if (creditStance === "in") {
      creditWhy =
        "Investment grade and high yield are both in — spreads can tighten and coupons still look collectible.";
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

  const stocksOutParts = [];
  // Equities “out” is soft growth (or a cash drain) while fear is still cheap —
  // the archive’s risk-off “out” days are mostly already-priced and then bounce.
  if (tightW(gSc) > 0.55 && easeW(rSc) > 0.4) {
    stocksOutParts.push("growth is soft while fear is still cheap");
  }
  if (tightW(lSc) > 0.55 && easeW(rSc) > 0.4 && easeW(gSc) < 0.45) {
    stocksOutParts.push("cash is draining while fear is still cheap");
  }
  if (realHigh && easeW(rSc) > 0.4) {
    stocksOutParts.push("real 10y yields are high — equities are not cheap on the discount rate");
  }
  if (tightW(rSc) > 0.55) {
    stocksOutParts.push("fear is already expensive — a clean underweight is late");
  }
  const calmRisk = easeW(rSc);
  // Soft growth alone is not enough for “out” — that sample still bounced.
  // Out needs soft growth (or a drain) while fear is calm AND either high real
  // yields or draining cash are confirming the multiple is taxed.
  const stocksTax = Math.max(realHigh ? 1 : 0, tightW(lSc));
  const stocksNet =
    0.55 * easeW(gSc) -
    0.35 * tightW(gSc) * calmRisk -
    0.75 * tightW(gSc) * calmRisk * stocksTax -
    0.55 * tightW(lSc) * calmRisk -
    (realHigh ? 0.55 * calmRisk : 0) +
    0.1 * calmRisk;
  const cycNet =
    0.6 * easeW(gSc) -
    0.35 * tightW(gSc) * calmRisk -
    0.75 * tightW(gSc) * calmRisk * stocksTax -
    (realHigh ? 0.5 * calmRisk : 0) +
    0.1 * calmRisk;
  const defNet =
    0.5 * tightW(gSc) * calmRisk * Math.max(stocksTax, 0.5) +
    0.15 * tightW(rSc) -
    0.55 * easeW(gSc) * calmRisk;
  const cyc = instrumentFromNet(
    "cyc",
    "Cy",
    cycNet,
    "Growth is firm and fear isn’t in charge — cyclicals usually get the bid.",
    tightW(gSc) > 0.55 && easeW(rSc) > 0.4
      ? "Growth is soft while fear is still cheap — cyclicals usually get hurt first."
      : realHigh
        ? "Real yields are high — cyclicals pay more for every dollar of cash flow."
        : "Fear is already expensive — the easy cyclical underweight is late.",
    "Cyclicals want Strong growth and calm fear; only one side is helping."
  );
  cyc.label = "Cyclicals";
  cyc.margin = blendMargin(cyc.stance, cyc.net, meanImpulse([gImp, kImp]));
  const def = instrumentFromNet(
    "def",
    "Df",
    defNet,
    tightW(gSc) > 0.55 && easeW(rSc) > 0.4
      ? "Growth is soft while fear is still cheap — defensives are the ballast inside equities."
      : "Fear is expensive — defensives usually hold up better than the cycle.",
    "Strong growth and calm fear — defensives usually lag that mix.",
    "Defensives want Soft growth with calm fear, or expensive fear; the expansion mix leaves them mixed."
  );
  def.label = "Defensives";
  def.margin = blendMargin(def.stance, def.net, meanImpulse([-gImp, -kImp]));
  const stocks = instrumentFromNet(
    "stocks",
    "Equities",
    stocksNet,
    "Activity is firm and fear is not in charge — risk assets usually get the bid.",
    sentence(stocksOutParts, "Equities are out of favor here."),
    realHigh
      ? "Growth isn’t a clean overweight, and real 10y yields already tax the multiple."
      : "Growth isn’t firm enough for a clean overweight, and nothing has taken them out.",
    0.15,
    -0.28
  );
  stocks.margin = blendMargin(stocks.stance, stocks.net, meanImpulse([gImp, kImp]));
  stocks.splits = [cyc, def];

  const cryptoOutParts = [];
  if (tightW(lSc) > 0.55) cryptoOutParts.push("cash is draining");
  if (dolStrong) cryptoOutParts.push("the dollar is rising");
  if (realHigh && easeW(rSc) > 0.4) cryptoOutParts.push("real yields are high — the high-beta valve is taxed");
  if (tightW(rSc) > 0.55) cryptoOutParts.push("fear is already expensive — the easy dump call is late");
  const cryptoInParts = [];
  if (easeW(lSc) > 0.55) cryptoInParts.push("plumbing is feeding risk");
  if (easeW(rSc) > 0.55 && easeW(lSc) > 0.4) cryptoInParts.push("fear is cheap with easy plumbing");
  const cryptoNet =
    0.5 * easeW(lSc) -
    0.5 * tightW(lSc) +
    0.15 * easeW(rSc) -
    0.1 * tightW(rSc) -
    (realHigh ? 0.25 * calmRisk : 0) -
    (dolStrong ? 0.45 : 0);
  const crypto = instrumentFromNet(
    "crypto",
    "Crypto",
    cryptoNet,
    sentence(cryptoInParts, "Easy plumbing and calm fear — Bitcoin is the high-beta valve."),
    sentence(cryptoOutParts, "Draining cash or a rising dollar — the high-beta valve usually dumps first."),
    "Crypto wants easy plumbing; fear alone is a late signal.",
    0.32,
    -0.32
  );
  crypto.margin = blendMargin(crypto.stance, crypto.net, meanImpulse([lImp, kImp]));

  const goldDrain = tightW(lSc) > 0.55 && tightW(tSc) < 0.45;
  const goldCrisis = tightW(lSc) > 0.45 && tightW(rSc) > 0.45;
  const goldInParts = [];
  if (goldCrisis) goldInParts.push("cash is draining and fear is expensive — gold’s crisis bid");
  if (goldDrain && !dolStrong) goldInParts.push("cash is draining without a dollar squeeze");
  if (dolSoft && !realHigh) goldInParts.push("the dollar is soft");
  const goldOutParts = [];
  if (dolStrong) goldOutParts.push("the dollar is rising");
  let goldMix = "Gold has no clean job right now.";
  if (dolStrong) {
    goldMix = sentence(goldOutParts, "A rising dollar — gold rarely leads that mix.");
  } else if (realHigh && !goldCrisis) {
    goldMix =
      "Real 10y yields are high, but there’s no crisis bid — gold stays mixed rather than a clean avoid.";
  } else if (!goldCrisis && !goldDrain) {
    goldMix = "Gold has no job right now — don’t treat it as a liquidity vote.";
  }
  // Crisis plumbing + fear, or a soft dollar without high real yields, as “in”.
  // A rising dollar is the out.
  const goldNet =
    (goldCrisis ? 0.7 : goldDrain && !dolStrong ? 0.35 : 0) +
    (dolSoft && !realHigh ? 0.5 : 0) -
    (dolStrong ? 0.8 : 0) -
    (realHigh && dolStrong ? 0.15 : 0);
  const gold = instrumentFromNet(
    "gold",
    "Gold",
    goldNet,
    sentence(goldInParts, "Crisis plumbing and fear, or a soft dollar — gold’s usual wage."),
    sentence(goldOutParts, "A rising dollar — gold rarely leads that mix."),
    goldMix,
    0.18,
    -0.18
  );
  gold.margin = blendMargin(gold.stance, gold.net, meanImpulse([-kImp, iImp]));

  const wtiImp = hzImp(seriesOk(snap, "WTI"), horizon);
  const oilInParts = [];
  if (easeW(gSc) > 0.55) oilInParts.push("growth is firm");
  if (!dolStrong) oilInParts.push("the dollar isn’t taxing dollar oil");
  if (wtiImp.dir === "up") oilInParts.push("crude is firm this window");
  const oilOutParts = [];
  if (tightW(gSc) > 0.55) oilOutParts.push("growth is soft");
  if (dolStrong) oilOutParts.push("the dollar is rising");
  if (wtiImp.dir === "down") oilOutParts.push("crude is soft this window");
  const oilNet =
    0.5 * easeW(gSc) - 0.5 * tightW(gSc) - (dolStrong ? 0.45 : 0) + (dolSoft ? 0.2 : 0);
  const oil = instrumentFromNet(
    "oil",
    "Oi",
    oilNet,
    sentence(oilInParts, "Firm growth without a dollar squeeze — oil usually gets paid."),
    sentence(oilOutParts, "Soft growth or a rising dollar — oil rarely leads."),
    "Oil wants firm growth and a cooperative dollar; only one side is helping."
  );
  oil.label = "Oil";
  oil.margin = blendMargin(
    oil.stance,
    oil.net,
    meanImpulse([gImp, wtiImp.score != null ? impulseUnit(wtiImp) : 0])
  );
  const copperNet = easeW(gSc) - tightW(gSc);
  const copper = instrumentFromNet(
    "copper",
    "Cu",
    copperNet,
    "Growth is Strong — copper usually gets the industrial bid.",
    "Growth is Soft — copper is the first industrial to get hurt.",
    "Copper follows the Growth light; activity isn’t clearly Strong or Soft."
  );
  copper.label = "Copper";
  copper.margin = blendMargin(copper.stance, copper.net, gImp);

  let cmdtyStance = netCall((oil.net + copper.net) / 2, 0.35, -0.35);
  let cmdtyWhy = `Oil ${oil.stance}, copper ${copper.stance} — growth and the dollar aren’t the same trade as the industrial metal.`;
  if (oil.stance === copper.stance) {
    cmdtyWhy =
      cmdtyStance === "in"
        ? "Oil and copper are both in — firm growth and a cooperative dollar."
        : cmdtyStance === "out"
          ? "Oil and copper are both out — soft growth or a rising dollar."
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
  const nomReal = seriesOk(snap, "NOM_REAL_SPREAD");
  const sbCorr = seriesOk(snap, "STOCK_BOND_CORR");
  const realY = seriesOk(snap, "DFII10");
  const dgs10 = seriesOk(snap, "DGS10");
  const hy = seriesOk(snap, "BAMLH0A0HYM2");
  const btc = seriesOk(snap, "BTC");
  const gold = seriesOk(snap, "GOLD");
  const dollar = seriesOk(snap, "DTWEXBGS");

  const creditFlow = hzImp(impulse, horizon);
  const sbImp = hzImp(sbCorr, horizon);
  const realYImp = hzImp(realY, horizon);
  const hyImp = hzImp(hy, horizon);

  // Duration net: positive = duration risk falling (bonds helped).
  // Continuous inflation/rates scores — no Hot/Mid cliff at 0.45.
  let durationDir = "mixed";
  let durationLabel = "Duration risk mixed";
  let durationLine = "";

  const tpUnpaid = termPremiumUnpaid(snap);
  const hotNotCooling = easeW(iSc) * (Iimp === "down" ? 0.25 : 1);
  const coldInfl = tightW(iSc);
  const coolingRelief = easeW(iSc) * (Iimp === "down" ? 0.55 : 0);
  let durNet =
    -0.7 * hotNotCooling +
    0.65 * coldInfl +
    0.45 * coolingRelief -
    0.55 * tightW(tSc) +
    0.35 * easeW(tSc) -
    (tpUnpaid ? 0.7 : 0) -
    0.25 * easeW(gSc) * (1 - tightW(iSc));

  const durationUpParts = [];
  if (hotNotCooling > 0.45) durationUpParts.push("inflation is still hot and not cooling this window");
  if (tightW(tSc) > 0.55) durationUpParts.push("funding is tight");
  if (tpUnpaid) durationUpParts.push("term premium is compressed — duration is not paid");
  if (easeW(gSc) > 0.55 && tightW(iSc) < 0.4 && hotNotCooling < 0.45 && tightW(tSc) < 0.45 && !tpUnpaid) {
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
    durationLine = coolingRelief > 0.3
      ? "Inflation is still high but cooling this window — duration gets a look if funding isn’t fighting you."
      : "Long bonds can work again — cooler inflation and softer funding open room for duration if credit stays calm.";
  } else {
    durationDir = "mixed";
    durationLabel = "Duration risk mixed";
    durationLine = coolingRelief > 0.3
      ? "Hot but cooling — the level still taxes duration; the turn is the reason not to treat 30s as a clean avoid."
      : "Duration is split — parts of the rates complex ease while inflation or growth still keep long bonds from a clean bid.";
  }

  if (realY?.latest != null && Number.isFinite(realY.latest) && realY.latest > 2) {
    durationLine += " Real 10y yields are high — discount rates still bite.";
  } else if (realYImp.dir === "up" && durationDir !== "falling") {
    durationLine += " Real 10y yields are rising this window — discount rates still bite.";
  }
  if (tpUnpaid && !durationLine.includes("term premium")) {
    durationLine += " Term premium is compressed — you are not paid for duration risk.";
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
  if (impulseSlow && creditUpParts.length) {
    creditUpParts.push("bank credit impulse is slowing");
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
    (impulseSlow ? 0.2 : 0) +
    (creditFlow.dir === "up" ? 0.2 : 0);

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
      "Credit is split — growth and risk lights aren’t telling the same story on cash-flow certainty.";
  }

  if (creditFlow.dir === "up" && !creditLine.includes("impulse")) {
    creditLine += ` Bank credit impulse is accelerating this window — private lending is adding fuel.`;
  } else if (creditFlow.dir === "down" && !creditLine.includes("impulse")) {
    creditLine += ` Bank credit impulse is decelerating this window — private lending is not confirming easy plumbing.`;
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
