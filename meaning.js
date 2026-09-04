/**
 * Regime → duration / credit meaning (Street physics, plain English).
 * Shared by UI + bake. Not trade advice — what the regime implies and what would break it.
 */

const LIGHT_IDS = ["liquidity", "transmission", "growth", "inflation", "risk"];

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

function hz(s, years) {
  if (!s) return { z: null, pct: null };
  if (years === 1) return { z: s.z1y, pct: s.pct1y };
  if (years === 5) return { z: s.z5y, pct: s.pct5y };
  return { z: s.z2y, pct: s.pct2y };
}

function pastWindow(years) {
  if (years === 1) return "Over the past year";
  if (years === 5) return "Over the past five years";
  return "Over the past two years";
}

/**
 * Map light club + key series into duration / credit stance + confirm / falsify.
 * @returns {{ past: string, duration: object, credit: object, confirm: string[], falsify: string[], lines: string[] }}
 */
export function buildMeaning(snap, years = 2) {
  const lights = snap?.lights || {};
  const L = stateOf(lights, "liquidity");
  const T = stateOf(lights, "transmission");
  const G = stateOf(lights, "growth");
  const I = stateOf(lights, "inflation");
  const R = stateOf(lights, "risk");
  const past = pastWindow(years);

  const impulse = seriesOk(snap, "CREDIT_IMPULSE");
  const nomReal = seriesOk(snap, "NOM_REAL_SPREAD");
  const sbCorr = seriesOk(snap, "STOCK_BOND_CORR");
  const realY = seriesOk(snap, "DFII10");
  const dgs10 = seriesOk(snap, "DGS10");
  const hy = seriesOk(snap, "BAMLH0A0HYM2");
  const btc = seriesOk(snap, "BTC");
  const gold = seriesOk(snap, "GOLD");
  const dollar = seriesOk(snap, "DTWEXBGS");

  const impulseZ = hz(impulse, years).z;
  const nomRealZ = hz(nomReal, years).z;
  const sbZ = hz(sbCorr, years).z;
  const realYZ = hz(realY, years).z;

  // --- Duration risk (rates / present value) ---
  // Rising duration risk: inflation heat, tight transmission, or hot nominal-vs-real GDP.
  // Falling: cold inflation + easy transmission.
  let durationDir = "mixed";
  let durationLabel = "Duration risk mixed";
  let durationLine = "";

  const durationUp =
    I === "easing" ||
    T === "tight" ||
    (G === "easing" && I !== "tight") ||
    (nomRealZ != null && nomRealZ > 0.45);
  const durationDown =
    (I === "tight" && T === "easing") ||
    (I === "tight" && T === "neutral" && G !== "easing");

  if (durationUp && !durationDown) {
    durationDir = "rising";
    durationLabel = "Duration risk rising";
    durationLine = `${past}, duration looks hard — inflation and/or funding aren’t giving bonds a clean bid. Long rates stay a constraint on present value.`;
  } else if (durationDown && !durationUp) {
    durationDir = "falling";
    durationLabel = "Duration risk falling";
    durationLine = `${past}, duration looks easier — cooler inflation and softer transmission open room for bonds to work if credit stays calm.`;
  } else {
    durationDir = "mixed";
    durationLabel = "Duration risk mixed";
    durationLine = `${past}, duration is split — parts of the rates complex ease while inflation or growth still fight a clean bond rally.`;
  }

  if (realYZ != null && realYZ > 0.75 && durationDir !== "falling") {
    durationLine += ` Real 10y yields sit high vs this window — discount rates bite.`;
  }

  // --- Credit risk (cash-flow / risk appetite) ---
  let creditDir = "mixed";
  let creditLabel = "Credit risk mixed";
  let creditLine = "";

  const creditUp =
    G === "tight" ||
    R === "tight" ||
    (impulseZ != null && impulseZ < -0.45) ||
    (hy && hz(hy, years).z != null && hz(hy, years).z > 0.45);
  const creditDown =
    (G === "easing" && R === "easing") ||
    (G === "easing" && R === "neutral" && !(impulseZ < -0.45));

  if (creditUp && !creditDown) {
    creditDir = "rising";
    creditLabel = "Credit risk rising";
    creditLine = `${past}, credit risk is waking up — soft growth, wider spreads, or a weak credit impulse mean cash flows look less certain.`;
  } else if (creditDown && !creditUp) {
    creditDir = "falling";
    creditLabel = "Credit risk falling";
    creditLine = `${past}, credit risk is being paid down — firm growth and quiet risk premia say cash flows still look collectible.`;
  } else {
    creditDir = "mixed";
    creditLabel = "Credit risk mixed";
    creditLine = `${past}, credit is split — growth and risk lights aren’t telling the same story on cash-flow certainty.`;
  }

  if (impulseZ != null && Number.isFinite(impulseZ)) {
    if (impulseZ > 0.45) {
      creditLine += ` Bank credit impulse is accelerating — private liquidity is adding fuel beyond the Fed sheet.`;
    } else if (impulseZ < -0.45) {
      creditLine += ` Bank credit impulse is decelerating — private lending is not confirming easy Fed plumbing.`;
    }
  }

  // --- Confirm / falsify (outputs + disagreements) ---
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
      "Strong growth with hot inflation is a classic duration-hostile mix — credit can still look fine until the Fed or the long end bites."
    );
    falsify.push("Falsify if Inflation flips Cold while Growth stays Strong — the duration call softens.");
  }

  if (btc && L === "tight") {
    const bz = hz(btc, years).z;
    if (bz != null && bz > 0.45) {
      confirm.push(
        "Bitcoin is not confirming the cash drain — treat it as an output disagreement, not a liquidity vote."
      );
    } else if (bz != null && bz < -0.45) {
      confirm.push("Bitcoin is soft with draining cash — the liquidity release valve is confirming.");
    }
  }

  if (gold && L === "tight") {
    const gz = hz(gold, years).z;
    if (gz != null && gz > 0.45) {
      confirm.push(
        "Gold is strong while cash drains — not a clean plumbing confirmation; gold is doing another job."
      );
    }
  }

  if (sbCorr && sbZ != null) {
    if (sbZ > 0.45) {
      confirm.push(
        "Stock–bond correlation is elevated vs this window — diversification is weaker; duration and credit can hurt together."
      );
    } else if (sbZ < -0.45) {
      confirm.push(
        "Stock–bond correlation is low/negative vs this window — classic balancers can still hedge each other."
      );
    }
  }

  if (dollar && T === "tight") {
    const dz = hz(dollar, years).z;
    if (dz != null && dz > 0.45) {
      confirm.push("A strong dollar is part of the tight transmission story — global USD liquidity is scarce.");
    }
  }

  if (dgs10 && durationDir === "rising") {
    const yz = hz(dgs10, years).z;
    if (yz != null && yz > 0.45) {
      confirm.push("The 10y yield is high vs this window — markets are already marking duration risk up.");
    }
  }

  // Deduplicate empties
  const lines = [durationLine, creditLine, ...confirm.slice(0, 3), ...falsify.slice(0, 2)].filter(
    Boolean
  );

  return {
    past,
    years,
    duration: { dir: durationDir, label: durationLabel, line: durationLine },
    credit: { dir: creditDir, label: creditLabel, line: creditLine },
    confirm,
    falsify,
    lines,
    snapshot: {
      liquidity: wordOf(lights, "liquidity"),
      transmission: wordOf(lights, "transmission"),
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
