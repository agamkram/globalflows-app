# Task: show what a hit rate is being compared to

**Difficulty:** moderate but fully specified. Arithmetic, not judgement.

## The problem

The base-rate panel says things like "High yield rose 100% of the time (34 days)".
That sounds overwhelming until you know high yield rose roughly **80% of all**
six-month windows anyway, because carry alone usually gets it there. The real
information is the *lift* over that baseline — about +20 points — not the raw
100%.

Right now the app shows the impressive number and withholds the meaningful one.
A professional reader's first question is "compared to what?", and the app has no
answer. Fix that.

## Where the code is

- `scripts/analogs.mjs` — computes `stats[horizon][assetId]` = `{ name, n, median, up, best, worst }` from the analog days only.
- `data/regime-history.json` — the full archive: `rows[]`, each with `date` and `fwd[horizon][assetId]`. Gitignored; rebuild with `npm run bake:history`.
- `app.js` → `baseRateHtml()` renders the table; `favorBaseRate()` + `renderFavorStrip()` render the inline verdicts.

## What to build

1. In `scripts/analogs.mjs`, compute an **unconditional** baseline per asset per
   horizon: the median and the share-positive across *every* row in
   `regime-history.json` that has a forward return for that asset — not just the
   analog days. Do not apply the `MIN_GAP_DAYS` spacing to the baseline; it exists
   to stop a few episodes masquerading as a large sample, which is not a concern
   when using the whole record.

2. Add it to the returned object as `baseline[horizon][assetId] = { median, up, n }`,
   alongside the existing `stats`.

3. In the panel (`baseRateHtml`), show the lift, not just the level. Something
   like `78% up vs 62% normally` — the exact wording is yours, but both numbers
   must be visible and it must be obvious which is conditional.

4. In the inline verdict (`favorBaseRate`), the agree/disagree test should use the
   **lift** rather than the raw hit rate. A 62% hit rate is not bullish if the
   asset rises 62% of the time regardless; it is neutral. Suggested: compare
   `up - baseline.up`, treat roughly ±8 points as the threshold for a lean, and
   keep the existing `weak` handling for a distant match.

## Verifying it

Do not trust a screenshot; read the numbers.

```bash
npm run bake:history && npm run bake:regime
node -e 'const a=require("./regime-today.json").analogs;
console.log(JSON.stringify(a.baseline["6m"],null,1))'
```

Sanity expectations, from a 2018-2026 archive measured on total return:

- HYG unconditional 6m share-positive should land near **80%**. If it comes out near 53% you are reading price instead of adjusted close — see the guardrails rule.
- TLT should be roughly a coin flip, near **50%**.
- Every `baseline[hz][asset].n` should be in the low thousands (the whole record), not ~34 (the analogs). If it is ~34 you have filtered to the analog set by mistake.

Then:

```bash
npm run sanity
```

## Done when

The panel shows both numbers, the inline verdicts key off the lift, and a reader
can tell whether "rose 100% of the time" is remarkable or just what that asset
does. Take a screenshot at phone width and read the text back to confirm no row
claims a lean that the baseline explains away.
