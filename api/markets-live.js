import { fetchMarketsLive } from "../scripts/markets-live.mjs";

const CACHE_MS = 15_000;
let cache = null;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const fresh =
    req.query?.fresh === "1" ||
    (typeof req.url === "string" && /[?&]fresh=1/.test(req.url));
  const now = Date.now();
  if (!fresh && cache && now - cache.t < CACHE_MS) {
    res.statusCode = 200;
    res.end(JSON.stringify(cache.body));
    return;
  }
  try {
    const body = await fetchMarketsLive();
    cache = { t: now, body };
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  } catch (e) {
    if (cache?.body) {
      res.statusCode = 200;
      res.end(JSON.stringify(cache.body));
      return;
    }
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e.message || e), quotes: {} }));
  }
}
