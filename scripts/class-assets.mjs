/**
 * Which traded assets stand in for each of the six classes, and how a class
 * return is formed from them.
 *
 * Shared so the backtest (audit-calls) and the live scorecard (score-log)
 * cannot drift apart. If the two measured a class differently the forward
 * record would not be comparable to the base rates it is meant to test, and
 * the difference would be invisible — both would still print a number.
 *
 * Bond and equity ETFs are adjusted close: a coupon is most of a bond's
 * return, and raw price makes every duration and credit read look worse than
 * the trade was.
 */

export const CLASS_ASSETS = {
  treasuries: ["UST5", "UST10", "UST30"],
  credit: ["HYG", "LQD"],
  stocks: ["SPX"],
  crypto: ["BTC"],
  gold: ["GOLD"],
  cmdty: ["WTI", "COPPER"],
};

export const CLASS_ORDER = ["treasuries", "credit", "stocks", "crypto", "gold", "cmdty"];

/** The strip labels these differently from the audit keys. */
export const CLASS_LABEL = {
  treasuries: "Treasuries",
  credit: "Credit",
  stocks: "Equities",
  crypto: "Crypto",
  gold: "Gold",
  cmdty: "Commodity",
};

/** Equal-weighted across the class's assets; null when none have matured. */
export function classReturn(fwd, assetIds) {
  if (!fwd) return null;
  const vals = assetIds.map((id) => fwd[id]).filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
