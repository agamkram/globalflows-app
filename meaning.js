/**
 * Regime → duration risk / credit risk → six asset classes (in / mixed / out).
 * Lights are levels. The 1w/2w/1m/3m/6m/1y lookback only nudges needle position.
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

function hzImp(s, horizon) {
  const imp = s?.impulse?.[horizon];
  return { dir: imp?.dir || null, delta: imp?.delta ?? null, score: imp?.score ?? null };
}

function pastWindow(horizon) {
  if (horizon === "1w") return "Over the past week";
  if (horizon === "2w") return "Over the past two weeks";
  if (horizon === "1m") return "Over the past month";
  if (horizon === "3m") return "Over the past three months";
  if (horizon === "6m") return "Over the past six months";
  return "Over the past year";
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
 * (28% weight) but cannot flip the call.
 */
function blendMargin(stance, checklistScore, momentum) {
  const m = clampMargin(0.72 * clampMargin(checklistScore) + 0.28 * clampMargin(momentum));
  if (stance === "out") return Math.min(m, -0.05);
  if (stance === "in") return Math.max(m, 0.05);
  return m;
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
  if (n >= 1) return "in";
  if (n <= -1) return "out";
  return "mixed";
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

function gradeTenor(name, score, ctx, cap = 1) {
  const stance = scoreStance(score);
  const margin = cap > 1 ? clampMargin(score / cap) : clampMargin(score);
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
  const d = durScore(durationDir);
  const flight = R === "tight" && I !== "easing" ? 1 : 0;
  const copperImp = hzImp(seriesOk(snap, "COPPER"), horizon);
  const wtiImp = hzImp(seriesOk(snap, "WTI"), horizon);
  const copperDir = copperImp.dir;
  const wtiDir = wtiImp.dir;
  const rImp = lightImpulse(lights, "rates");
  const iImp = lightImpulse(lights, "inflation");
  const gImp = lightImpulse(lights, "growth");
  const lImp = lightImpulse(lights, "liquidity");
  const kImp = lightImpulse(lights, "risk");
  const hyImp = impulseUnit(hzImp(seriesOk(snap, "BAMLH0A0HYM2"), horizon));

  const billsPay = T === "tight" || L === "tight" || R === "tight";

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
  // 5s follow policy, not the duration score — they are the front-end sleeve now
  // that cash is not a cell. Dragging them out whenever 30s are taxed left no
  // place to sit in bills-like duration while inflation is still hot.
  const t5 = gradeTenor("5", T === "easing" ? 1 : T === "tight" ? -1 : 0, tenorCtx, 1);
  const t10 = gradeTenor("10", d + flight + (I === "easing" ? -1 : 0), tenorCtx, 2);
  const t30 = gradeTenor(
    "30",
    d + flight + (I === "easing" ? -1 : I === "tight" ? 1 : 0),
    tenorCtx,
    2
  );
  t5.margin = blendMargin(t5.stance, t5.margin, rImp);
  t10.margin = blendMargin(t10.stance, t10.margin, meanImpulse([rImp, -iImp]));
  t30.margin = blendMargin(t30.stance, t30.margin, -iImp);
  const tenorSet = new Set([t5.stance, t10.stance, t30.stance]);
  const ustStance = tenorSet.size === 1 ? t10.stance : "mixed";
  let ustWhy = `Curve is split — 5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}.`;
  if (ustStance === "out") {
    ustWhy = "The whole curve is taxed — policy, duration, and inflation aren’t paying.";
  } else if (ustStance === "in") {
    ustWhy = "The whole curve can work — policy, duration, and inflation aren’t the tax.";
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
  const ig = instrument(
    "ig",
    "IG",
    creditDir === "falling" && durationDir !== "rising",
    creditDir === "rising" || durationDir === "rising",
    "Spreads can tighten and duration is not fighting you.",
    sentence(
      igOutParts,
      "Either cash-flow doubt or rising yields — investment-grade bonds get hit from one side or both."
    ),
    "Investment-grade credit sits between duration and credit risk; neither side is giving a clean signal."
  );
  ig.label = "Investment grade";
  ig.margin = blendMargin(
    ig.stance,
    stanceMargin(
      ig.stance,
      (creditDir === "falling" ? 1 : 0) + (durationDir !== "rising" ? 1 : 0),
      (creditDir === "rising" ? 1 : 0) + (durationDir === "rising" ? 1 : 0),
      2
    ),
    meanImpulse([rImp, -iImp, kImp])
  );
  const hyOutParts = [];
  if (creditDir === "rising") {
    const named = (creditUpParts || []).filter(Boolean);
    if (named.length) hyOutParts.push(...named);
    else hyOutParts.push("credit risk is rising");
  } else {
    if (R === "tight") hyOutParts.push("fear is expensive");
    if (G === "tight") hyOutParts.push("growth is soft");
  }
  if (L === "tight" && !hyOutParts.includes("cash is draining")) {
    hyOutParts.push("cash is draining");
  }
  const hyPrint = seriesOk(snap, "BAMLH0A0HYM2");
  const hyTights = hyPrint?.anchor?.score != null && hyPrint.anchor.score >= 0.85;
  if (hyTights) hyOutParts.push("spreads are at cycle tights — you are not paid");
  const hy = instrument(
    "hy",
    "HY",
    creditDir === "falling" && L !== "tight" && R !== "tight" && !hyTights,
    creditDir === "rising" || R === "tight" || L === "tight" || G === "tight" || hyTights,
    "Growth and risk appetite still say coupons get paid.",
    sentence(hyOutParts, "High yield is the first credit to get hurt."),
    "High yield needs both growth and calm fear; only one side is helping."
  );
  hy.label = "High yield";
  hy.margin = blendMargin(
    hy.stance,
    stanceMargin(
      hy.stance,
      (creditDir === "falling" ? 1 : 0) +
        (L !== "tight" ? 1 : 0) +
        (R !== "tight" ? 1 : 0) +
        (!hyTights ? 1 : 0),
      (creditDir === "rising" ? 1 : 0) +
        (R === "tight" ? 1 : 0) +
        (L === "tight" ? 1 : 0) +
        (G === "tight" ? 1 : 0) +
        (hyTights ? 1 : 0),
      5
    ),
    meanImpulse([gImp, kImp, hyImp])
  );
  let creditStance = "mixed";
  let creditWhy = `Investment grade ${ig.stance}, high yield ${hy.stance} — duration and cash-flow aren’t the same trade.`;
  if (ig.stance === hy.stance) {
    creditStance = ig.stance;
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
  if (G === "tight") stocksOutParts.push("growth is soft");
  if (R === "tight") stocksOutParts.push("fear is in charge");
  if (L === "tight" && G !== "easing") stocksOutParts.push("cash is draining");
  const stocks = instrument(
    "stocks",
    "Equities",
    G === "easing" && R !== "tight" && L !== "tight",
    G === "tight" || R === "tight" || (L === "tight" && G !== "easing"),
    "Activity is firm and fear is not in charge — risk assets usually get the bid.",
    sentence(stocksOutParts, "Equities are out of favor here."),
    "Growth isn’t firm enough for a clean overweight, and nothing has taken them out."
  );
  stocks.margin = blendMargin(
    stocks.stance,
    stanceMargin(
      stocks.stance,
      (G === "easing" ? 1 : 0) + (R !== "tight" ? 1 : 0) + (L !== "tight" ? 1 : 0),
      (G === "tight" ? 1 : 0) + (R === "tight" ? 1 : 0) + (L === "tight" && G !== "easing" ? 1 : 0),
      3
    ),
    meanImpulse([gImp, kImp])
  );

  const cryptoInParts = [];
  if (L === "easing") cryptoInParts.push("plumbing is feeding risk");
  if (R === "easing") cryptoInParts.push("fear is cheap");
  const cryptoOutParts = [];
  if (L === "tight") cryptoOutParts.push("cash is draining");
  if (R === "tight") cryptoOutParts.push("fear is in charge");
  const crypto = instrument(
    "crypto",
    "Crypto",
    L === "easing" && R !== "tight",
    L === "tight" || R === "tight",
    sentence(cryptoInParts, "Easy plumbing and calm fear — Bitcoin is the high-beta valve."),
    sentence(cryptoOutParts, "Draining cash or expensive fear — the high-beta valve usually dumps first."),
    "Crypto wants easy plumbing and calm fear; only one side is helping."
  );
  crypto.margin = blendMargin(
    crypto.stance,
    stanceMargin(
      crypto.stance,
      (L === "easing" ? 1 : 0) + (R !== "tight" ? 1 : 0),
      (L === "tight" ? 1 : 0) + (R === "tight" ? 1 : 0),
      2
    ),
    meanImpulse([lImp, kImp])
  );

  const goldFear = R === "tight";
  const goldDrain = L === "tight" && T !== "tight";
  const goldHotEasy = I === "easing" && T === "easing";
  const goldInParts = [];
  if (goldFear) goldInParts.push("fear is paying gold’s usual wage");
  if (goldDrain) goldInParts.push("cash is draining without a rates squeeze");
  if (goldHotEasy) goldInParts.push("prices are hot and funding is easy");
  let goldMix = "Gold has no clean job right now.";
  const bei = seriesOk(snap, "T5YIFR");
  const beiAnchored =
    bei?.anchor?.score != null && Math.abs(bei.anchor.score) <= 0.45;
  if (I === "easing" && !goldHotEasy && !goldFear && !goldDrain) {
    goldMix = beiAnchored
      ? "PCE is still hot, but 5y5y is anchored and funding isn’t easy — gold has no second job."
      : "Inflation is hot, but gold has no second job — funding isn’t easy and fear isn’t paying.";
  } else if (!goldFear && !goldDrain && !goldHotEasy) {
    goldMix = "Gold has no job right now — don’t treat it as a liquidity vote.";
  }
  const gold = instrument(
    "gold",
    "Gold",
    goldFear || goldDrain || goldHotEasy,
    I === "tight" && R === "easing" && T === "tight",
    sentence(goldInParts, "Hot prices, fear, or a cash drain — gold’s usual jobs."),
    "Cold inflation, risk-on, and high real funding — gold rarely leads that mix.",
    goldMix
  );
  gold.margin = blendMargin(
    gold.stance,
    stanceMargin(
      gold.stance,
      (goldFear ? 1 : 0) + (goldDrain ? 1 : 0) + (goldHotEasy ? 1 : 0),
      I === "tight" && R === "easing" && T === "tight" ? 1 : 0,
      3
    ),
    meanImpulse([-kImp, iImp])
  );

  const cmdtyIn = G === "easing" && I === "easing";
  const cmdtyOut = G === "tight" || (I === "tight" && G !== "easing");
  const cmdty = instrument(
    "cmdty",
    "Commodities",
    cmdtyIn || (copperDir === "up" && G === "easing"),
    cmdtyOut || (wtiDir === "down" && G !== "easing"),
    "Firm activity and hot prices — copper and oil usually get the bid.",
    "Soft growth or cold inflation — the real-cycle complex is out of favor.",
    "Commodities are mixed; growth and inflation aren’t both pointing the same way."
  );
  cmdty.margin = blendMargin(
    cmdty.stance,
    stanceMargin(
      cmdty.stance,
      (G === "easing" ? 1 : 0) + (I === "easing" ? 1 : 0) + (copperDir === "up" && G === "easing" ? 1 : 0),
      (G === "tight" ? 1 : 0) +
        (I === "tight" && G !== "easing" ? 1 : 0) +
        (wtiDir === "down" && G !== "easing" ? 1 : 0),
      3
    ),
    meanImpulse([gImp, iImp, impulseUnit(copperImp)])
  );

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
  const past = pastWindow(horizon);
  const Iimp = lights.inflation?.impulse?.dir || "flat";
  const Gimp = lights.growth?.impulse?.dir || "flat";

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

  // Duration: hot inflation still taxes bonds unless it is cooling this impulse.
  let durationDir = "mixed";
  let durationLabel = "Duration risk mixed";
  let durationLine = "";

  const hotStill = I === "easing" && Iimp !== "down";
  const coolingHot = I === "easing" && Iimp === "down";
  const durationUp = hotStill || T === "tight" || (G === "easing" && I !== "tight" && Iimp !== "down");
  const durationDown =
    I === "tight" ||
    (coolingHot && T !== "tight") ||
    (I === "tight" && T === "easing");

  const durationUpParts = [];
  if (hotStill) durationUpParts.push("inflation is still hot and not cooling this window");
  if (T === "tight") durationUpParts.push("funding is tight");
  if (G === "easing" && I !== "tight" && Iimp !== "down" && !hotStill && T !== "tight") {
    durationUpParts.push("firm growth is keeping a premium in the long end");
  }

  if (durationUp && !durationDown) {
    durationDir = "rising";
    durationLabel = "Duration risk rising";
    durationLine = durationUpParts.length
      ? `Long bonds aren’t getting paid — ${joinEnglish(durationUpParts)}, so present value stays under pressure.`
      : "Long bonds aren’t getting paid for the risk, so present value stays under pressure.";
  } else if (durationDown && !durationUp) {
    durationDir = "falling";
    durationLabel = "Duration risk falling";
    durationLine = coolingHot
      ? "Inflation is still high but cooling this window — duration gets a look if funding isn’t fighting you."
      : "Long bonds can work again — cooler inflation and softer funding open room for duration if credit stays calm.";
  } else {
    durationDir = "mixed";
    durationLabel = "Duration risk mixed";
    durationLine = coolingHot
      ? "Hot but cooling — the level still taxes duration; the turn is the reason not to treat 30s as a clean avoid."
      : "Duration is split — parts of the rates complex ease while inflation or growth still keep long bonds from a clean bid.";
  }

  if (realY?.latest != null && Number.isFinite(realY.latest) && realY.latest > 2) {
    durationLine += " Real 10y yields are high — discount rates still bite.";
  } else if (realYImp.dir === "up" && durationDir !== "falling") {
    durationLine += " Real 10y yields are rising this window — discount rates still bite.";
  }

  let creditDir = "mixed";
  let creditLabel = "Credit risk mixed";
  let creditLine = "";

  // Impulse slowing is a note, not a witness. High-yield at cycle tights with a still-
  // positive impulse is not "credit risk rising" just because lending cooled a bit.
  const creditUpParts = [];
  if (G === "tight") creditUpParts.push("growth is soft");
  if (R === "tight") creditUpParts.push("fear is expensive");
  if (Gimp === "down") creditUpParts.push("activity is rolling over this window");
  if (hyImp.dir === "up") creditUpParts.push("high-yield spreads are widening this window");
  const impulseSlow = creditFlow.dir === "down";
  if (impulseSlow && creditUpParts.length) {
    creditUpParts.push("bank credit impulse is slowing");
  }

  const creditUp = creditUpParts.length > 0;
  const creditDown =
    (G === "easing" && R === "easing" && Gimp !== "down") ||
    (G === "easing" && R === "neutral" && creditFlow.dir !== "down");

  if (creditUp && !creditDown) {
    creditDir = "rising";
    creditLabel = "Credit risk rising";
    creditLine = sentence(creditUpParts, "Credit risk is waking up — cash flows look less certain.");
  } else if (creditDown && !creditUp) {
    creditDir = "falling";
    creditLabel = "Credit risk falling";
    creditLine =
      "Credit risk is being paid down — firm growth and quiet risk premia say cash flows still look collectible.";
  } else if (impulseSlow && !creditUp) {
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
