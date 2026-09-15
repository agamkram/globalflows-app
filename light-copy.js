/**
 * Component story — same paragraphs the morning job writes, rebuilt from
 * whoever is voting now. Boxes and taps must use this, not a frozen file.
 *
 * Math stays in score.js (one module in the browser). This file is only words.
 */

import { chipBandFromScore } from "./score.js?v=20261241";

export const LIGHT_IDS = ["liquidity", "rates", "growth", "inflation", "risk"];

/** Three-way colour band — teach paragraphs still key off this. */
export const LIGHT_WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};

/** Chip / headline / the six. Lean is not a modifier on Mid — it is the word. */
export const CHIP_WORD = {
  liquidity: {
    easing: "Easing",
    leaningEasing: "Leaning easy",
    neutral: "Neutral",
    leaningTight: "Leaning tight",
    tight: "Tightening",
  },
  rates: {
    easing: "Easy",
    leaningEasing: "Leaning easy",
    neutral: "Neutral",
    leaningTight: "Leaning tight",
    tight: "Tight",
  },
  growth: {
    easing: "Strong",
    leaningEasing: "Leaning strong",
    neutral: "Mid",
    leaningTight: "Leaning soft",
    tight: "Soft",
  },
  inflation: {
    easing: "Hot",
    leaningEasing: "Leaning hot",
    neutral: "Mid",
    leaningTight: "Leaning cold",
    tight: "Cold",
  },
  risk: {
    easing: "Risk-on",
    leaningEasing: "Leaning risk-on",
    neutral: "Neutral",
    leaningTight: "Leaning risk-off",
    tight: "Risk-off",
  },
};

export function chipWord(lid, score) {
  const band = chipBandFromScore(score);
  return CHIP_WORD[lid]?.[band] || LIGHT_WORD[lid]?.[band] || band;
}

export const LIGHT_COLOR = {
  easing: "green",
  neutral: "white",
  tight: "red",
  empty: "gray",
};

function names(arr, n = 2) {
  return arr.slice(0, n).map((v) => v.name).join(", ");
}

/** "Reserves ÷ GDP leans" vs "Reserves ÷ GDP, Net liquidity ÷ GDP lean". */
function leans(arr, n = 2) {
  return Math.min((arr || []).length, n) === 1 ? "leans" : "lean";
}

/** Inflation chevron: down = cooling, up = heating, flat = not cooling. */
export function inflationTurn(dir) {
  if (dir === "down") return "cooling";
  if (dir === "up") return "heating";
  return "not cooling";
}

/** Plain-English paragraph for this component’s current vote. Pass cliff on c. */
export function teachLight(lid, c) {
  const soft = names(c.easy || [], 2);
  const hard = names(c.tight || [], 2);
  const split =
    c.easy?.length && c.tight?.length
      ? ` Split: ${soft || "some"} ${soft ? leans(c.easy) : "lean"} easier;` +
        ` ${hard || "others"} ${hard ? leans(c.tight) : "lean"} tighter.`
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
  const band = chipBandFromScore(c.score);
  const word = chipWord(lid, c.score);
  const fullEase = LIGHT_WORD[lid]?.easing || "the green word";
  const fullTight = LIGHT_WORD[lid]?.tight || "the red word";
  const midName = LIGHT_WORD[lid]?.neutral || "the middle";
  let growthNote = split;
  let growthPoint =
    band === "easing"
      ? "the real side is holding up"
      : band === "tight"
        ? "demand/labor are under pressure"
        : band === "leaningEasing"
          ? "leaning strong, not Strong yet"
          : band === "leaningTight"
            ? "leaning soft, not Soft yet"
            : "no clean boom or bust";
  if (lid === "growth") {
    const surveyLoud = (c.voters || []).some(
      (v) => (v.id === "EMPIRE_MFG" || v.id === "PHILLY_MFG") && Math.abs(v.score) > 0.45
    );
    // The ballot average is what votes, not any single print — claims alone can
    // sit past the rail while jobs and GDP are still flat.
    const coin = (c.voters || []).filter((v) =>
      ["PAYEMS", "UNRATE", "ICSA", "GDPC1", "CFNAI", "WEI"].includes(v.id)
    );
    const coincidentMid =
      coin.length > 0 &&
      Math.abs(coin.reduce((a, v) => a + v.score, 0) / coin.length) <= 0.45;
    if (surveyLoud && coincidentMid) {
      const tick = c.score > 0 ? "Strong" : "Soft";
      const pay = coin.find((v) => v.id === "PAYEMS");
      const gdp = coin.find((v) => v.id === "GDPC1");
      const claims = coin.find((v) => v.id === "ICSA");
      const jobsMid = !pay || Math.abs(pay.score) <= 0.45;
      const gdpMid = !gdp || Math.abs(gdp.score) <= 0.45;
      const midBits = [];
      if (jobsMid) midBits.push("jobs");
      if (gdpMid) midBits.push("GDP");
      const midBit = midBits.length
        ? `${midBits.join(" and ")} ${midBits.length === 1 ? "is" : "are"} still Mid`
        : "the coincident ballot is still inside the band";
      const claimsBit =
        claims && Math.abs(claims.score) > 0.45 ? " Claims have already moved." : "";
      growthNote =
        ` Regional surveys are at the rail while ${midBit} — the surveys are early, not wrong.` +
        claimsBit +
        ` Since 2003 the hard data has followed them within a quarter about two thirds of the time.`;
      if (band === "neutral") {
        growthPoint = `the surveys are calling ${tick.toLowerCase()} before the hard data has moved`;
      } else {
        growthPoint = "early, not confirmed";
      }
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
  const nextFull = c.score > 0 ? fullEase : fullTight;
  const cliffNote =
    cliff != null && cliff < 0.05
      ? Math.abs(c.score) > 0.45
        ? ` Only ${cliff.toFixed(2)} inside ${word}.`
        : ` Only ${cliff.toFixed(2)} from ${nextFull}.`
      : "";
  const by = {
    liquidity: {
      easing: `Cash looks ample on the level.${split}${cliffNote} Point: plumbing is not the scarce good.`,
      leaningEasing: `Cash is leaning easy.${split}${cliffNote} Point: still inside ${midName} — not Easing yet.`,
      neutral: `Cash looks neither clearly ample nor scarce.${split}${cliffNote} Point: liquidity isn’t the loud driver right now.`,
      leaningTight: `Cash is leaning tight.${split}${cliffNote} Point: still inside ${midName} — not Tightening yet.`,
      tight: `Cash looks scarce on the level.${split}${cliffNote} Point: funding/parking say less fuel in the pipes.`,
    },
    rates: {
      easing: `Real funding looks easy.${split}${cliffNote} Point: money is cheap to fund with.`,
      leaningEasing: `Real funding is leaning easy.${split}${cliffNote} Point: still inside ${midName} — not Easy yet.`,
      neutral: `Real funding looks mixed.${split}${cliffNote} Point: not clearly cheap or dear.`,
      leaningTight: `Real funding is leaning tight.${split}${cliffNote} Point: still inside ${midName} — not Tight yet.`,
      tight: `Real funding looks tight.${split}${cliffNote} Point: you are being paid to wait in cash, not in duration.`,
    },
    growth: {
      easing: `Activity looks firm versus full employment / trend.${growthNote}${cliffNote} Point: ${growthPoint}.`,
      leaningEasing: `Activity is leaning strong versus trend.${growthNote}${cliffNote} Point: ${growthPoint}.`,
      neutral: `Activity looks mixed versus trend.${growthNote}${cliffNote} Point: ${growthPoint}.`,
      leaningTight: `Activity is leaning soft versus trend.${growthNote}${cliffNote} Point: ${growthPoint}.`,
      tight: `Activity looks soft versus trend.${growthNote}${cliffNote} Point: ${growthPoint}.`,
    },
    inflation: {
      easing: `Prices are high versus ~2%.${inflNote}${cliffNote} Point: the level is still hot — ${inflationTurn(c.impulse?.dir)}.`,
      leaningEasing: `Prices are leaning hot versus ~2%.${inflNote}${cliffNote} Point: still inside ${midName} — not Hot yet.`,
      neutral: `Prices are near the target band.${inflNote}${cliffNote} Point: no clean hot or cold call.`,
      leaningTight: `Prices are leaning cold versus ~2%.${inflNote}${cliffNote} Point: still inside ${midName} — not Cold yet.`,
      tight: `Prices are cold versus ~2%.${inflNote}${cliffNote} Point: inflation is not the tax right now.`,
    },
    risk: {
      easing: `Fear is cheap on the gauges.${riskNote}${cliffNote} Point: vol and credit are quiet.`,
      leaningEasing: `Fear is leaning risk-on.${riskNote}${cliffNote} Point: still inside ${midName} — not a full Risk-on tape.`,
      neutral: `Fear gauges look mixed.${riskNote}${cliffNote} Point: not a clear risk-on or risk-off tape.`,
      leaningTight: `Fear is leaning risk-off.${riskNote}${cliffNote} Point: still inside ${midName} — not a full Risk-off tape.`,
      tight: `Markets are paying up for fear.${riskNote}${cliffNote} Point: vol/credit stress is elevated.`,
    },
  };
  return by[lid]?.[band] || `${word}.`;
}

/** Club + story + distance to a word flip. `c` is clubLight() plus cliff. */
export function lightSheet(lid, c) {
  const painted = {
    ...c,
    word: chipWord(lid, c.score),
    color: LIGHT_COLOR[c.state],
  };
  return {
    ...painted,
    teach: teachLight(lid, painted),
  };
}
