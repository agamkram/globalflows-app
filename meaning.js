/**
 * Regime → duration / credit → six asset classes.
 * Lights are anchors. Impulse horizon only nudges the mapping.
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
  if (tenor === "5") return "5s sit between policy and duration — not a clean bid.";
  if (tenor === "10") return "10s are split; duration isn’t a clean overweight or avoid.";
  return "30s are split — inflation and duration aren’t telling the same story.";
}

function gradeTenor(name, score, ctx) {
  const stance = scoreStance(score);
  return { id: name, name, stance, why: tenorWhy(stance, name, ctx) };
}

/**
 * Map duration × credit (plus lights) onto six asset classes.
 * Treasuries split 5 / 10 / 30. Credit is one class (IG vs HY in the tap).
 */
function buildFavor(lights, durationDir, creditDir, snap, horizon, creditUpParts) {
  const L = stateOf(lights, "liquidity");
  const T = stateOf(lights, "rates");
  const G = stateOf(lights, "growth");
  const I = stateOf(lights, "inflation");
  const R = stateOf(lights, "risk");
  const d = durScore(durationDir);
  const flight = R === "tight" && I !== "easing" ? 1 : 0;
  const copperDir = hzImp(seriesOk(snap, "COPPER"), horizon).dir;
  const wtiDir = hzImp(seriesOk(snap, "WTI"), horizon).dir;

  const cashInParts = [];
  if (T === "tight") cashInParts.push("high funding pays you to sit in bills");
  if (L === "tight") cashInParts.push("scarce plumbing pays you to wait");
  if (R === "tight") cashInParts.push("fear pays you to wait in bills");
  const cash = instrument(
    "cash",
    "Cash",
    cashInParts.length > 0,
    T === "easing" && L === "easing" && R === "easing",
    sentence(cashInParts, "High or scarce funding pays you to sit in bills."),
    "Easy cash, easy rates, and calm fear — cash is the leftover, not the trade.",
    "Funding, plumbing, and fear are not all tight — bills are a parking place, not the trade."
  );

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
    if (cash.stance === "in") {
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
  const t5 = gradeTenor("5", d + (T === "easing" ? 1 : T === "tight" ? -1 : 0), tenorCtx);
  const t10 = gradeTenor("10", d + flight + (I === "easing" ? -1 : 0), tenorCtx);
  const t30 = gradeTenor(
    "30",
    d + flight + (I === "easing" ? -1 : I === "tight" ? 1 : 0),
    tenorCtx
  );
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
    tenors: [t5, t10, t30],
  };

  const igOutParts = [];
  if (durationDir === "rising") igOutParts.push("rising yields tax the duration in IG");
  if (creditDir === "rising") igOutParts.push("cash-flow doubt is hitting credit");
  const ig = instrument(
    "ig",
    "IG",
    creditDir === "falling" && durationDir !== "rising",
    creditDir === "rising" || durationDir === "rising",
    "Spreads can tighten and duration is not fighting you.",
    sentence(igOutParts, "Either cash-flow doubt or rising yields — IG gets hit from one side or both."),
    "IG sits between duration and credit; neither side is giving a clean signal."
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
  const hy = instrument(
    "hy",
    "HY",
    creditDir === "falling" && L !== "tight" && R !== "tight",
    creditDir === "rising" || R === "tight" || L === "tight" || G === "tight",
    "Growth and risk appetite still say coupons get paid.",
    sentence(hyOutParts, "HY is the first credit to get hurt."),
    "HY needs both growth and calm fear; only one side is helping."
  );
  let creditStance = "mixed";
  let creditWhy = `IG ${ig.stance}, HY ${hy.stance} — duration vs cash-flow aren’t the same trade.`;
  if (ig.stance === hy.stance) {
    creditStance = ig.stance;
    if (creditStance === "out") {
      creditWhy = "IG and HY are both out — duration and cash-flow risk are both up.";
    } else if (creditStance === "in") {
      creditWhy = "IG and HY are both in — spreads can tighten and coupons still look collectible.";
    } else {
      creditWhy = "IG and HY are both mixed.";
    }
  }
  const credit = {
    id: "credit",
    name: "Credit",
    stance: creditStance,
    why: creditWhy,
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
  stocks.note = "Crypto follows equities unless it disagrees with the cash story.";

  const goldFear = R === "tight";
  const goldDrain = L === "tight" && T !== "tight";
  const goldHotEasy = I === "easing" && T === "easing";
  const goldInParts = [];
  if (goldFear) goldInParts.push("fear is paying gold’s usual wage");
  if (goldDrain) goldInParts.push("cash is draining without a rates squeeze");
  if (goldHotEasy) goldInParts.push("prices are hot and funding is easy");
  let goldMix = "Gold has no clean job right now.";
  if (I === "easing" && !goldHotEasy && !goldFear && !goldDrain) {
    goldMix =
      "Inflation is hot, but gold has no second job — funding isn’t easy and fear isn’t paying.";
  } else if (!goldFear && !goldDrain && !goldHotEasy) {
    goldMix = "Gold is doing more than one job; don’t treat it as a liquidity vote.";
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

  return {
    pair: { line: pairLine, why: pairWhy },
    items: [cash, treasuries, credit, stocks, gold, cmdty],
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

  // Impulse slowing is a note, not a witness. HY at cycle tights with a still-
  // positive impulse is not "credit risk rising" just because lending cooled a bit.
  const creditUpParts = [];
  if (G === "tight") creditUpParts.push("growth is soft");
  if (R === "tight") creditUpParts.push("fear is expensive");
  if (Gimp === "down") creditUpParts.push("activity is rolling over this window");
  if (hyImp.dir === "up") creditUpParts.push("HY spreads are widening this window");
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
      "Falsify if Risk flips Risk-off or HY blows out while Liquidity stays Tightening."
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
