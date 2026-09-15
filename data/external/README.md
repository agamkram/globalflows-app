# External shelf

Warehouse of outside reads kept **beside** GlobalFlows, not inside the bake.

Nothing here votes, paints a component, or rewrites a call. Pull it, sort it,
look at it. If something earns a seat later, that is a separate decision.

## View

- Browser: open `/external.html` on the local preview (About → Shelf).
- Terminal: `npm run peek:external`

## Refresh

```bash
npm run fetch:external
```

Writes dated history lines under each source folder and refreshes `latest.json`.

## What is automatic

| Folder | Source | Cadence | Notes |
|---|---|---|---|
| `cot/` | CFTC TFF + Disaggregated | Weekly | Free official API. As-of date ≠ Friday publish date. |
| `fear-greed/` | CNN Fear & Greed | Daily | Unofficial page JSON; can break. |
| `convex/` | Convex public regime | When they refresh | Peer dashboard. Attribution required. |

## What Mark fills by hand

| File | Cadence | Notes |
|---|---|---|
| `house-card.csv` | Monthly | Copy from `house-card.template.csv`. OW / N / UW only. |

## Do not

- Feed these series into `score.js` without an explicit design pass
- Treat agreement with Convex or CNN as correctness (the forward record owns that)
- Use COT Friday publish as if it were known on Tuesday
