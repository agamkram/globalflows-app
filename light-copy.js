/**
 * Component story — same paragraphs the morning job writes, rebuilt from
 * whoever is voting now. Boxes and taps must use this, not a frozen file.
 *
 * Math stays in score.js (one module in the browser). This file is only words.
 */

export const LIGHT_IDS = ["liquidity", "rates", "growth", "inflation", "risk"];

export const LIGHT_WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};

export const LIGHT_COLOR = {
  easing: "green",
  neutral: "amber",
  tight: "red",
  empty: "gray",
};

function names(arr, n = 2) {
  return arr.slice(0, n).map((v) => v.name).join(", ");
}

/** Plain-English paragraph for this component’s current vote. Pass cliff on c. */
export function teachLight(lid, c) {
  const soft = names(c.easy || [], 2);
  const hard = names(c.tight || [], 2);
  const split =
    c.easy?.length && c.tight?.length
      ? ` Split: ${soft || "some"} lean easier; ${hard || "others"} lean tighter.`
      : "";
  let inflNote = split;
  if (lid === "inflation") {
    const pce = (c.voters || []).find((v) => v.id === "PCEPILFE");
    const bei = (c.voters || []).find((v) => v.id === "T5YIFR");
    if (pce && bei && pce.score > 0.45 && bei.score <= 0.45 && bei.score >= -0.45) {
      inflNote =
        " Core PCE is still high versus ~2%; 5y5y is anchored at the CPI-equivalent of target.";
    } else if (pce && bei && pce.score > 0.45 && bei.score < -0.45) {
      inflNote = " Split: core PCE still hot; the bond market is pricing cold.";
    } else if (pce && bei && pce.score < -0.45 && bei.score > 0.45) {
      inflNote = " Split: core PCE is cold; the bond market is pricing hot.";
    }
  }
  let growthNote = split;
  if (lid === "growth") {
    const surveyLoud = (c.voters || []).some(
      (v) => (v.id === "EMPIRE_MFG" || v.id === "PHILLY_MFG") && Math.abs(v.score) > 0.45
    );
    if (c.state === "neutral" && surveyLoud && Math.abs(c.score) >= 0.4) {
      growthNote =
        " The coincident ballot (jobs, GDP, activity) is still Mid. Regional surveys are at the rail — they sit the needle on the Strong tick; they cannot take the word.";
    }
  }
  let riskNote = split;
  if (lid === "risk") {
    const hy = (c.voters || []).find((v) => v.id === "BAMLH0A0HYM2");
    if (hy && hy.score >= 0.85) {
      riskNote = " HY OAS is at cycle tights — calm, and not paid.";
    }
  }
  const cliff = c.cliff;
  const cliffNote =
    cliff != null && cliff < 0.05
      ? Math.abs(c.score) > 0.45
        ? ` Only ${cliff.toFixed(2)} past a word flip.`
        : ` Only ${cliff.toFixed(2)} from flipping the word.`
      : "";
  const by = {
    liquidity: {
      easing: `Cash looks ample on the level.${split}${cliffNote} Point: plumbing is not the scarce good.`,
      neutral: `Cash looks neither clearly ample nor scarce.${split}${cliffNote} Point: liquidity isn’t the loud driver right now.`,
      tight: `Cash looks scarce on the level.${split}${cliffNote} Point: funding/parking say less fuel in the pipes.`,
    },
    rates: {
      easing: `Real funding looks easy.${split}${cliffNote} Point: money is cheap to fund with.`,
      neutral: `Real funding looks mixed.${split}${cliffNote} Point: not clearly cheap or dear.`,
      tight: `Real funding looks tight.${split}${cliffNote} Point: you are being paid to wait in cash, not in duration.`,
    },
    growth: {
      easing: `Activity looks firm versus full employment / trend.${growthNote}${cliffNote} Point: the real side is holding up.`,
      neutral: `Activity looks mixed versus trend.${growthNote}${cliffNote} Point: no clean boom or bust.`,
      tight: `Activity looks soft versus trend.${split}${cliffNote} Point: demand/labor are under pressure.`,
    },
    inflation: {
      easing: `Prices are high versus ~2%.${inflNote}${cliffNote} Point: the level is still hot — the impulse row says if it’s cooling.`,
      neutral: `Prices are near the target band.${inflNote}${cliffNote} Point: no clean hot or cold call.`,
      tight: `Prices are cold versus ~2%.${inflNote}${cliffNote} Point: inflation is not the tax right now.`,
    },
    risk: {
      easing: `Fear is cheap on the gauges.${riskNote}${cliffNote} Point: vol and credit are quiet.`,
      neutral: `Fear gauges look mixed.${riskNote}${cliffNote} Point: not a clear risk-on or risk-off tape.`,
      tight: `Markets are paying up for fear.${riskNote}${cliffNote} Point: vol/credit stress is elevated.`,
    },
  };
  return by[lid]?.[c.state] || `${c.word || c.state}.`;
}

/** Club + story + distance to a word flip. `c` is clubLight() plus cliff. */
export function lightSheet(lid, c) {
  const painted = {
    ...c,
    word: LIGHT_WORD[lid]?.[c.state] || c.state,
    color: LIGHT_COLOR[c.state],
  };
  return {
    ...painted,
    teach: teachLight(lid, painted),
  };
}
