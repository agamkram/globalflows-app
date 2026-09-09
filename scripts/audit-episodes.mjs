/**
 * Episode audit — does each light read the events it must get right?
 *
 *   npm run audit:episodes
 *
 * The distribution checks in audit:bands ask whether a light is well-shaped.
 * They cannot ask whether it is correct. Liquidity passed every one of them
 * while calling the GFC, COVID and the 2022 tightening "ample" — the sd was
 * right, the centre drift was right, the amber share was inside its warn line,
 * and the light was confidently wrong about all three events it most needed to
 * read. What exposed it was lining it up against those events and reading off
 * what it said at the time.
 *
 * So: named episodes with an expected reading, written from what actually
 * happened rather than from what the app currently prints. A light is allowed
 * to be early or late at the edges of a window — these are wide enough to
 * include lead-in and recovery — but it may not spend a crisis in the opposite
 * colour.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIGHT_IDS } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST = path.join(ROOT, "data", "regime-history.json");

/** Reach the expected colour on at least this share of the window. */
const MIN_HIT = 0.33;
/** Spend no more than this share of the window in the opposite colour. */
const MAX_WRONG = 0.15;

/**
 * expect: "green" | "red" | "not-green" | "not-red"
 * Green is the reflationary end of each light, red the contractionary end.
 */
const EPISODES = [
  // ── LIQUIDITY ────────────────────────────────────────────────────────────
  {
    light: "liquidity", name: "GFC", from: "2008-09-01", to: "2009-03-31", expect: "red",
    why: "Lehman, the money-market break, commercial paper at 242bp over fed funds.",
  },
  {
    light: "liquidity", name: "2013 taper tantrum", from: "2013-05-01", to: "2013-12-01", expect: "not-red",
    why: "The tantrum was about the prospect of tapering; QE was still adding $85bn a month.",
  },
  {
    light: "liquidity", name: "2018-19 QT", from: "2018-09-01", to: "2019-09-30", expect: "red",
    why: "Balance sheet runoff drained reserves until repo broke in September 2019.",
  },
  {
    light: "liquidity", name: "COVID crash", from: "2020-03-01", to: "2020-04-30", expect: "red",
    why: "The dash for cash — even Treasuries stopped trading properly.",
  },
  {
    light: "liquidity", name: "peak QE", from: "2021-01-01", to: "2021-12-31", expect: "green",
    why: "$120bn a month, reserves and the reverse repo facility at records.",
  },
  {
    light: "liquidity", name: "2022 QT and the dollar", from: "2022-04-01", to: "2023-04-01", expect: "red",
    why: "Fastest runoff on record into a 20% dollar rally — a global squeeze.",
  },

  // ── RATES ────────────────────────────────────────────────────────────────
  {
    light: "rates", name: "post-hike plateau", from: "2006-07-01", to: "2007-08-01", expect: "red",
    why: "Funds held at 5.25% with real yields around 2.5% — restrictive by any measure.",
  },
  {
    light: "rates", name: "ZIRP and QE1/QE2", from: "2009-06-01", to: "2011-12-31", expect: "green",
    why: "Policy at zero with the Fed buying duration outright.",
  },
  {
    // The one episode where level and turn part company, so it tests both. The
    // drama of the tantrum lives entirely in the change: the 2-year sat at 0.2
    // to 0.4%, the real 5-year never got above zero, the real 10-year finished
    // at 0.80% against a 23-year median of 1.05%, the curve steepened from 146
    // to 266bp, and QE was still running $85bn a month. Rates were easy the
    // whole way — they became dramatically less easy. A light that went red
    // here would be reporting the turn and calling it the level.
    light: "rates", name: "taper tantrum", from: "2013-06-01", to: "2013-12-31", expect: "green",
    turn: "down", turnMin: 0.2,
    why: "Policy at zero and real yields still below their median, tightening hard the whole way.",
  },
  {
    light: "rates", name: "2018 hikes into QT", from: "2018-09-01", to: "2019-01-31", expect: "not-green",
    why: "Funds at 2.25-2.50% with runoff running; the equity market cracked on it.",
  },
  {
    light: "rates", name: "pandemic ZIRP", from: "2020-05-01", to: "2021-06-30", expect: "green",
    why: "Zero policy rate and the 10-year real yield near −1%.",
  },
  {
    light: "rates", name: "2022-23 tightening", from: "2022-09-01", to: "2023-10-31", expect: "red",
    why: "Fastest hiking cycle in forty years; the 10-year real yield went −1% to +2.5%.",
  },

  // ── GROWTH ───────────────────────────────────────────────────────────────
  {
    light: "growth", name: "GFC recession", from: "2008-09-01", to: "2009-06-30", expect: "red",
    why: "Payrolls falling 700k a month; the deepest post-war contraction until COVID.",
  },
  {
    light: "growth", name: "mid-2000s expansion", from: "2004-01-01", to: "2006-06-30", expect: "not-red",
    why: "Unemployment falling through 5%, steady payroll growth.",
  },
  {
    light: "growth", name: "COVID collapse", from: "2020-03-15", to: "2020-06-30", expect: "red",
    why: "22 million jobs lost in two months; unemployment 14.7%.",
  },
  {
    light: "growth", name: "reopening boom", from: "2021-03-01", to: "2021-12-31", expect: "not-red",
    why: "Payrolls adding 600k a month against the strongest GDP year since 1984.",
  },

  // ── INFLATION ────────────────────────────────────────────────────────────
  {
    light: "inflation", name: "deflation scare", from: "2009-03-01", to: "2009-12-31", expect: "red",
    why: "Core PCE near 1%, breakevens briefly negative, the Fed openly worried about deflation.",
  },
  {
    light: "inflation", name: "oil crash disinflation", from: "2015-01-01", to: "2016-06-30", expect: "not-green",
    why: "Headline CPI at zero, 5y5y forward down to 1.8% — the opposite of hot.",
  },
  {
    light: "inflation", name: "the 2021-22 surge", from: "2021-06-01", to: "2022-12-31", expect: "green",
    why: "Core PCE 5.4%, headline CPI 9.1% — the highest in forty years.",
  },

  // ── RISK ─────────────────────────────────────────────────────────────────
  {
    light: "risk", name: "GFC", from: "2008-09-01", to: "2009-03-31", expect: "red",
    why: "VIX at 80, high yield above 2,000bp.",
  },
  {
    light: "risk", name: "euro crisis and US downgrade", from: "2011-08-01", to: "2011-11-30", expect: "red",
    why: "S&P cut the US, the euro area was pricing breakup, VIX held above 30.",
  },
  {
    light: "risk", name: "2017 calm", from: "2017-01-01", to: "2017-12-31", expect: "green",
    why: "The lowest-volatility year on record; VIX averaged 11.",
  },
  {
    light: "risk", name: "COVID crash", from: "2020-02-20", to: "2020-04-30", expect: "red",
    why: "VIX at 82, the fastest 30% drawdown in history.",
  },
  {
    light: "risk", name: "2022 bear market", from: "2022-04-01", to: "2022-10-31", expect: "red",
    why: "A 25% drawdown, high yield out to 600bp.",
  },
];

const COLOUR = { easing: "green", neutral: "amber", tight: "red" };

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  let hist;
  try {
    hist = JSON.parse(await fs.readFile(HIST, "utf8"));
  } catch {
    console.error("audit-episodes: no data/regime-history.json — run npm run bake:history");
    process.exit(1);
  }
  const rows = hist.rows || [];
  const idx = Object.fromEntries(LIGHT_IDS.map((id, i) => [id, i]));

  console.log("Episode audit — what each light said during the events it must read\n");
  console.log(
    `pass when the light reaches the expected colour on ≥${Math.round(MIN_HIT * 100)}% of the window ` +
      `and spends ≤${Math.round(MAX_WRONG * 100)}% in the opposite colour\n`
  );

  const fails = [];
  let lastLight = null;

  for (const ep of EPISODES) {
    if (ep.light !== lastLight) {
      console.log(`${ep.light.toUpperCase()}`);
      lastLight = ep.light;
    }
    const i = idx[ep.light];
    const win = rows.filter((r) => r.date >= ep.from && r.date <= ep.to);
    if (win.length < 15) {
      console.log(`  ${pad(ep.name, 28)} no archive coverage`);
      fails.push(`${ep.light}/${ep.name}: no archive coverage`);
      continue;
    }
    const share = { green: 0, amber: 0, red: 0 };
    for (const r of win) share[COLOUR[r.st[i]] || "amber"]++;
    for (const k of Object.keys(share)) share[k] /= win.length;
    const mean = win.reduce((a, r) => a + (r.s[i] ?? 0), 0) / win.length;

    let ok;
    let need;
    if (ep.expect === "green") {
      ok = share.green >= MIN_HIT && share.red <= MAX_WRONG;
      need = "green";
    } else if (ep.expect === "red") {
      ok = share.red >= MIN_HIT && share.green <= MAX_WRONG;
      need = "red";
    } else if (ep.expect === "not-green") {
      ok = share.green <= MAX_WRONG;
      need = "not green";
    } else {
      ok = share.red <= MAX_WRONG;
      need = "not red";
    }

    // Some episodes are about direction of travel, not colour. A light can sit
    // at the right level and still have gone deaf to a move happening inside it.
    let turnOk = true;
    let turnNote = "";
    if (ep.turn) {
      const move = (win[win.length - 1].s[i] ?? 0) - (win[0].s[i] ?? 0);
      const want = ep.turnMin ?? 0.2;
      turnOk = ep.turn === "down" ? move <= -want : move >= want;
      turnNote = `  turn ${(move >= 0 ? "+" : "") + move.toFixed(2)}`;
      if (!turnOk) {
        fails.push(
          `${ep.light}/${ep.name} (${ep.from}..${ep.to}): level is right but the light barely moved ` +
            `(${move.toFixed(2)}, wanted ${ep.turn} at least ${want}). ${ep.why}`
        );
      }
    }

    console.log(
      `  ${pad(ep.name, 28)} green ${pad(Math.round(share.green * 100) + "%", 5)}` +
        ` amber ${pad(Math.round(share.amber * 100) + "%", 5)}` +
        ` red ${pad(Math.round(share.red * 100) + "%", 5)}` +
        ` mean ${(mean >= 0 ? "+" : "") + mean.toFixed(2)}${pad(turnNote, 13)}   ` +
        `${ok && turnOk ? "ok" : ok ? "WRONG — did not move" : `WRONG — expected ${need}`}`
    );
    if (!ok) {
      fails.push(
        `${ep.light}/${ep.name} (${ep.from}..${ep.to}): expected ${need}, got ` +
          `green ${Math.round(share.green * 100)}% / red ${Math.round(share.red * 100)}%. ${ep.why}`
      );
    }
  }

  console.log();
  if (!fails.length) {
    console.log(`ok — all ${EPISODES.length} episodes read correctly.`);
    return;
  }
  console.log(`${fails.length} of ${EPISODES.length} episodes misread:\n`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`audit-episodes failed: ${e.message}`);
  process.exit(1);
});
