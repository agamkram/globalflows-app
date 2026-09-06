# Task: stop the regime dialog repeating itself

**Difficulty:** small and local. Safe for a cheap model.

## The problem

In **Today's regime → In / out of favor**, two rows print the same sentence twice
in a row. Treasuries reads:

```
Treasuries                                    Out
— Discount rates still tax the 10s.
5 Out  — Policy/funding still taxes the 5s.
10 Out — Discount rates still tax the 10s.      <-- identical to the parent
30 Out — Hot inflation or term premium — 30s aren't getting paid.
```

Credit does the same thing, with the parent line repeating the IG line verbatim.

It reads like a machine padding its answer, which undercuts the careful reasoning
everywhere else in the dialog.

## Why it happens

In `meaning.js`, when the sub-items agree the parent simply borrows one of their
sentences:

- Treasuries, line 128: `let ustWhy = t10.why;` — so the parent equals the 10-year row.
- Credit, line 162: `creditWhy = ig.stance === "in" ? hy.why : ig.why;` — so the parent equals the IG row (or HY when "in").

The dialog then renders the parent line and every child line, so one child is
always an exact echo.

## What to do

Pick **one** of these. Do not do both.

- **Preferred:** in `app.js`, where the favor rows are rendered (`openSentence`
  — `it.tenors` at line 933, `it.splits` at line 947), skip a child's sentence
  when it is identical to the parent's. Keep the child's name and stance badge —
  `10 Out` still carries information — and drop only the repeated prose. Both
  branches need the fix; they are separate code paths, and letting them drift is
  exactly how the clash marker ended up inconsistent earlier.

- **Alternative:** in `meaning.js`, give the parent its own summary sentence when
  the children agree, instead of borrowing one.

The first is smaller and cannot change any score or stance. Prefer it.

Compare the strings after trimming whitespace. Do not compare rendered HTML.

## Constraints

- Do not change any stance, score, or `data-state` attribute. This is copy only.
- Do not remove the child rows themselves.
- Leave the `mixed` case alone: when tenors disagree, the parent already has its
  own distinct sentence ("Curve is split — ...") and nothing is duplicated.

## Verifying it

```bash
python3 scripts/bump-version.py
npm run serve   # then open the app, tap "In and out of favor"
```

Read the actual text out of the DOM rather than judging from a screenshot:

```js
[...document.querySelectorAll(".rubric-row, .sent-explain")].map(e =>
  e.textContent.replace(/\s+/g, " ").trim()
)
```

## Done when

No Treasuries or Credit child row repeats its parent's sentence, the tenor badges
(`5 / 10 / 30`, `IG / HY`) are all still present with their original stances, and
the `mixed` case is unchanged. Confirm at phone width — this dialog is read on a
phone.
