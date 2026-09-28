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

## The four (auto)

| Folder | Source | Cadence | Notes |
|---|---|---|---|
| `cot/` | CFTC TFF + Disaggregated | Weekly | Free official API. As-of ≠ Friday publish. |
| `fear-greed/` | CNN Fear & Greed | Daily | Unofficial page JSON; can break. |
| `arsenal/` | Arsenal growth×inflation rule | With FRED prints | Their published thresholds on our GDPC1 / CPIAUCSL YoY. |
| `iitian/` | IITian regime matrix | When their page updates | Public HTML scrape; fragile. |

## Also manual

| File | Cadence | Notes |
|---|---|---|
| `house-card.csv` | Monthly | Copy from `house-card.template.csv`. OW / N / UW only. |
| `peers/latest.json` | Weekday morning, after the bake | `npm run fetch:peers`. A card changes only when that house’s page date is newer. Blank is not Neutral. Not a bake file. |

## Do not

- Feed these into `score.js` without an explicit design pass
- Treat peer agreement as correctness (the forward record owns that)
- Use COT Friday publish as if it were known on Tuesday
- Average unlike units into a fake “validation score”
