/** Shared Shelf math. No network. CFTC names, Arsenal rule, CNN shape. */

export const TFF_URL =
  "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
export const DISAGG_URL =
  "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";
export const ARSENAL_URL = "https://arsenal.finance/regime";

export const ARSENAL_MAP = {
  Goldilocks: {
    winners: "Equities, credit, growth stocks",
    losers: "Gold, commodities, cash",
  },
  Reflation: {
    winners: "Commodities, value, TIPS, EM",
    losers: "Long-duration bonds",
  },
  Deflation: {
    winners: "Treasuries, cash, quality bonds",
    losers: "Equities, commodities, credit",
  },
  Stagflation: {
    winners: "Gold, TIPS, commodities, cash",
    losers: "Equities, long bonds, credit",
  },
};

export const TFF_WATCH = [
  {
    id: "ust_10y",
    label: "UST 10Y note",
    name: "UST 10Y NOTE - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "ust_5y",
    label: "UST 5Y note",
    name: "UST 5Y NOTE - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "ust_ultra",
    label: "Ultra UST bond",
    name: "ULTRA UST BOND - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "es",
    label: "E-mini S&P 500",
    name: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
    gf: "equities",
  },
  {
    id: "nq",
    label: "Nasdaq mini",
    name: "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE",
    gf: "equities",
  },
  {
    id: "btc",
    label: "Bitcoin CME",
    name: "BITCOIN - CHICAGO MERCANTILE EXCHANGE",
    gf: "crypto",
  },
  {
    id: "dxy",
    label: "USD index",
    name: "USD INDEX - ICE FUTURES U.S.",
    gf: null,
  },
];

export const DISAGG_WATCH = [
  {
    id: "gold",
    label: "Gold COMEX",
    name: "GOLD - COMMODITY EXCHANGE INC.",
    gf: "gold",
  },
  {
    id: "copper",
    label: "Copper COMEX",
    name: "COPPER- #1 - COMMODITY EXCHANGE INC.",
    gf: "commodities",
  },
  {
    id: "wti",
    label: "WTI physical NYMEX",
    name: "WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE",
    gf: "commodities",
  },
];

const FEAR_KEYS = [
  "market_momentum_sp500",
  "stock_price_strength",
  "stock_price_breadth",
  "put_call_options",
  "market_volatility_vix",
  "junk_bond_demand",
  "safe_haven_demand",
];

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function net(longV, shortV) {
  const l = num(longV);
  const s = num(shortV);
  if (l == null || s == null) return null;
  return l - s;
}

export function isoDay(s) {
  if (!s) return null;
  return String(s).slice(0, 10);
}

export function slimTff(row) {
  return {
    openInterest: num(row.open_interest_all),
    assetMgrNet: net(row.asset_mgr_positions_long, row.asset_mgr_positions_short),
    levMoneyNet: net(row.lev_money_positions_long, row.lev_money_positions_short),
    dealerNet: net(row.dealer_positions_long_all, row.dealer_positions_short_all),
    assetMgrLong: num(row.asset_mgr_positions_long),
    assetMgrShort: num(row.asset_mgr_positions_short),
    levMoneyLong: num(row.lev_money_positions_long),
    levMoneyShort: num(row.lev_money_positions_short),
  };
}

export function slimDisagg(row) {
  return {
    openInterest: num(row.open_interest_all),
    managedMoneyNet: net(
      row.m_money_positions_long_all,
      row.m_money_positions_short_all
    ),
    producerNet: net(row.prod_merc_positions_long, row.prod_merc_positions_short),
    swapNet: net(row.swap_positions_long_all, row.swap__positions_short_all),
    managedMoneyLong: num(row.m_money_positions_long_all),
    managedMoneyShort: num(row.m_money_positions_short_all),
  };
}

export function classifyArsenal(gdpYoy, cpiYoy) {
  const growthScore = Math.tanh((gdpYoy - 2) / 4);
  const inflationScore = Math.tanh((cpiYoy - 2.5) / 3);
  const growthUp = growthScore >= 0;
  const inflationUp = inflationScore >= 0;
  const regime = growthUp
    ? inflationUp
      ? "Reflation"
      : "Goldilocks"
    : inflationUp
      ? "Stagflation"
      : "Deflation";
  return { regime, growthScore, inflationScore, growthUp, inflationUp };
}

export function arsenalFromPrints({ gdpYoy, cpiYoy, gdpAsOf, cpiAsOf }) {
  const g = num(gdpYoy);
  const c = num(cpiYoy);
  if (g == null || c == null) return null;
  const cls = classifyArsenal(g, c);
  const map = ARSENAL_MAP[cls.regime];
  return {
    source: "arsenal",
    asOf: isoDay(cpiAsOf),
    gdpAsOf: isoDay(gdpAsOf),
    cpiAsOf: isoDay(cpiAsOf),
    gdpYoy: g,
    cpiYoy: c,
    growthScore: cls.growthScore,
    inflationScore: cls.inflationScore,
    growthUp: cls.growthUp,
    inflationUp: cls.inflationUp,
    regime: cls.regime,
    winners: map.winners,
    losers: map.losers,
    attribution: {
      text: "Arsenal published growth×inflation rule",
      url: ARSENAL_URL,
    },
  };
}

export function arsenalFromSnapshot(snap) {
  const gdp = snap?.series?.GDPC1;
  const cpi = snap?.series?.CPIAUCSL;
  return arsenalFromPrints({
    gdpYoy: gdp?.latest,
    cpiYoy: cpi?.latest,
    gdpAsOf: gdp?.asOf,
    cpiAsOf: cpi?.asOf,
  });
}

export function fearFromRaw(raw, fetchedAt) {
  const fg = raw?.fear_and_greed || {};
  const subs = {};
  for (const key of FEAR_KEYS) {
    const block = raw?.[key];
    if (!block) continue;
    subs[key] = {
      score: num(block.score ?? block.now),
      rating: block.rating ?? null,
      timestamp: block.timestamp ?? null,
    };
  }
  return {
    source: "fear-greed",
    fetchedAt,
    asOf: isoDay(fg.timestamp) || isoDay(fetchedAt),
    score: num(fg.score),
    rating: fg.rating || null,
    previousClose: num(fg.previous_close),
    previous1Week: num(fg.previous_1_week),
    previous1Month: num(fg.previous_1_month),
    previous1Year: num(fg.previous_1_year),
    subs,
  };
}

function sqlList(names) {
  return names.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(",");
}

export async function latestReportDate(getJson, url) {
  const rows = await getJson(
    `${url}?$select=max(report_date_as_yyyy_mm_dd)%20as%20d`
  );
  return rows?.[0]?.d || null;
}

export async function rowsForMarkets(getJson, url, reportDate, names) {
  const q = new URL(url);
  q.searchParams.set(
    "$where",
    `report_date_as_yyyy_mm_dd='${isoDay(reportDate)}' AND market_and_exchange_names in(${sqlList(names)})`
  );
  q.searchParams.set("$limit", String(names.length + 4));
  return getJson(q.toString());
}

function packWatch(watch, report, asOf, byName, slim) {
  return watch.map((w) => {
    const row = byName.get(w.name);
    return {
      id: w.id,
      label: w.label,
      gf: w.gf,
      report,
      market: w.name,
      asOf: isoDay(asOf),
      ...(row ? slim(row) : { missing: true }),
    };
  });
}

/** Pull the ten CFTC markets. `getJson(url)` is fetch in the browser, node on the job. */
export async function pullCot(getJson) {
  const [tffDate, disaggDate] = await Promise.all([
    latestReportDate(getJson, TFF_URL),
    latestReportDate(getJson, DISAGG_URL),
  ]);
  const [tffRows, disaggRows] = await Promise.all([
    rowsForMarkets(
      getJson,
      TFF_URL,
      tffDate,
      TFF_WATCH.map((w) => w.name)
    ),
    rowsForMarkets(
      getJson,
      DISAGG_URL,
      disaggDate,
      DISAGG_WATCH.map((w) => w.name)
    ),
  ]);
  const tffByName = new Map(
    (tffRows || []).map((r) => [r.market_and_exchange_names, r])
  );
  const disaggByName = new Map(
    (disaggRows || []).map((r) => [r.market_and_exchange_names, r])
  );
  return {
    source: "cot",
    fetchedAt: new Date().toISOString(),
    tffAsOf: isoDay(tffDate),
    disaggregatedAsOf: isoDay(disaggDate),
    contracts: [
      ...packWatch(TFF_WATCH, "tff", tffDate, tffByName, slimTff),
      ...packWatch(DISAGG_WATCH, "disaggregated", disaggDate, disaggByName, slimDisagg),
    ],
  };
}
