/**
 * Regime → duration / credit → six asset classes.
 * Lights are anchors. Impulse horizon only nudges the mapping.
 */
import { DEFAULT_IMPULSE } from "./score.js";

const LIGHT_IDS = ["liquidity", "rates", "growth", "inflation", "risk"];

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

function tenorWhy(stance, tenor) {
  if (stance === "in") {
    if (tenor === "5") return "Front-end duration can work — policy isn’t fighting the 5s.";
    if (tenor === "10") return "The benchmark 10s can get paid — duration risk is easing.";
    return "Long 30s can work — inflation/term premium isn’t the tax.";
  }
  if (stance === "out") {
    if (tenor === "5") return "Policy/funding still taxes the 5s.";
    if (tenor === "10") return "Discount rates still tax the 10s.";
    return "Hot inflation or term premium — 30s aren’t getting paid.";
  }
  if (tenor === "5") return "5s sit between policy and duration — not a clean bid.";
  if (tenor === "10") return "10s are split; duration isn’t a clean overweight or avoid.";
  return "30s are split — inflation and duration aren’t telling the same story.";
}

function gradeTenor(name, score) {
  const stance = scoreStance(score);
  return { id: name, name, stance, why: tenorWhy(stance, name) };
}

/**
 * Map duration × credit (plus lights) onto six asset classes.
 * Treasuries split 5 / 10 / 30. Credit is one class (IG vs HY in the tap).
 */
function buildFavor(lights, durationDir, creditDir, snap, horizon) {
  const L = stateOf(lights, "liquidity");
  const T = stateOf(lights, "rates");
  const G = stateOf(lights, "growth");
  const I = stateOf(lights, "inflation");
  const R = stateOf(lights, "risk");
  const d = durScore(durationDir);
  const flight = R === "tight" && I !== "easing" ? 1 : 0;

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
    pairLine = "Cash over stocks and long bonds";
    pairWhy =
      "Both discount-rate risk and cash-flow risk are up — get paid to wait.";
  } else if (durationDir === "falling" && creditDir === "falling") {
    pairLine = "Risk assets and duration can both work";
    pairWhy = "Softer funding/inflation and collectible cash flows — an easing mix.";
  }

  const cash = instrument(
    "cash",
    "Cash",
    T === "tight" || L === "tight" || R === "tight",
    T === "easing" && L === "easing" && R === "easing",
    "High or scarce funding pays you to sit in bills; cash is the parking place.",
    "Easy cash, easy rates, and calm fear — cash is the leftover, not the trade.",
    "Bills are a fine parking place, not a strong overweight."
  );

  const t5 = gradeTenor("5", d + (T === "easing" ? 1 : T === "tight" ? -1 : 0));
  const t10 = gradeTenor("10", d + flight + (I === "easing" ? -1 : 0));
  const t30 = gradeTenor(
    "30",
    d + flight + (I === "easing" ? -1 : I === "tight" ? 1 : 0)
  );
  const tenorSet = new Set([t5.stance, t10.stance, t30.stance]);
  const ustStance = tenorSet.size === 1 ? t10.stance : "mixed";
  let ustWhy = t10.why;
  if (ustStance === "mixed" && tenorSet.size > 1) {
    ustWhy = `Curve is split — 5s ${t5.stance}, 10s ${t10.stance}, 30s ${t30.stance}.`;
  }
  const treasuries = {
    id: "treasuries",
    name: "Treasuries",
    stance: ustStance,
    why: ustWhy,
    tenors: [t5, t10, t30],
  };

  const ig = instrument(
    "ig",
    "IG",
    creditDir === "falling" && durationDir !== "rising",
    creditDir === "rising" || durationDir === "rising",
    "Spreads can tighten and duration is not fighting you.",
    "Either cash-flow doubt or rising yields — IG gets hit from one side or both.",
    "IG sits between duration and credit; neither side is giving a clean signal."
  );
  const hy = instrument(
    "hy",
    "HY",
    creditDir === "falling" && L !== "tight" && R !== "tight",
    creditDir === "rising" || R === "tight" || L === "tight" || G === "tight",
    "Growth and risk appetite still say coupons get paid.",
    "Soft growth, draining cash, or rising fear — HY is the first credit to get hurt.",
    "HY needs both growth and calm fear; only one side is helping."
  );
  let creditStance = "mixed";
  let creditWhy = `IG ${ig.stance}, HY ${hy.stance} — duration vs cash-flow aren’t the same trade.`;
  if (ig.stance === hy.stance) {
    creditStance = ig.stance;
    creditWhy = ig.stance === "in" ? hy.why : ig.why;
  }
  const credit = {
    id: "credit",
    name: "Credit",
    stance: creditStance,
    why: creditWhy,
    splits: [ig, hy],
  };

  const stocks = instrument(
    "stocks",
    "Equities",
    G === "easing" && R !== "tight" && L !== "tight",
    G === "tight" || R === "tight" || (L === "tight" && G !== "easing"),
    "Activity is firm and fear is not in charge — risk assets usually get the bid.",
    "Soft growth, draining cash, or risk-off — equities are out of favor here.",
    "Growth may look fine while funding, inflation, or fear still cap multiples."
  );
  stocks.note = "Crypto follows equities unless it disagrees with the cash story.";

  const gold = instrument(
    "gold",
    "Gold",
    I === "easing" || R === "tight" || (L === "tight" && T !== "tight"),
    I === "tight" && R === "easing" && T === "tight",
    "Hot prices, fear, or draining cash without a rates squeeze — gold’s usual jobs.",
    "Cold inflation, risk-on, and high real funding — gold rarely leads that mix.",
    "Gold is doing more than one job; don’t treat it as a liquidity vote."
  );

  const copperDir = hzImp(seriesOk(snap, "COPPER"), horizon).dir;
  const wtiDir = hzImp(seriesOk(snap, "WTI"), horizon).dir;
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
  const nomRealImp = hzImp(nomReal, horizon);
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

  if (durationUp && !durationDown) {
    durationDir = "rising";
    durationLabel = "Duration risk rising";
    durationLine =
      "Long bonds aren’t getting paid for the risk — inflation and/or funding are in the way, so present value stays under pressure.";
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

  const creditUp =
    G === "tight" ||
    R === "tight" ||
    Gimp === "down" ||
    creditFlow.dir === "down" ||
    hyImp.dir === "up";
  const creditDown =
    (G === "easing" && R === "easing" && Gimp !== "down") ||
    (G === "easing" && R === "neutral" && creditFlow.dir !== "down");

  if (creditUp && !creditDown) {
    creditDir = "rising";
    creditLabel = "Credit risk rising";
    creditLine =
      "Credit risk is waking up — soft growth, wider spreads, or a weak credit impulse mean cash flows look less certain.";
  } else if (creditDown && !creditUp) {
    creditDir = "falling";
    creditLabel = "Credit risk falling";
    creditLine =
      "Credit risk is being paid down — firm growth and quiet risk premia say cash flows still look collectible.";
  } else {
    creditDir = "mixed";
    creditLabel = "Credit risk mixed";
    creditLine =
      "Credit is split — growth and risk lights aren’t telling the same story on cash-flow certainty.";
  }

  if (creditFlow.dir === "up") {
    creditLine += ` Bank credit impulse is accelerating this window — private lending is adding fuel.`;
  } else if (creditFlow.dir === "down") {
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

  const favor = buildFavor(lights, durationDir, creditDir, snap, horizon);

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

export { LIGHT_IDS, pastWindow };
