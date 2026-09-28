#!/usr/bin/env node
/**
 * Peers desk check. Nine houses, beside the regime, never inside the scores.
 *
 * Each house has a page we already know. If that page's date has not moved,
 * the card stays. A quiet day writes nothing.
 *
 * A newer note replaces the card. The two lines under the name are sentences
 * from that page, copied. A component is filled only when the note says it
 * in words this job is allowed to trust. Otherwise the cell stays blank.
 * Blank is not Neutral.
 *
 *   npm run fetch:peers
 *   npm run fetch:peers -- --dry-run
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PEERS = path.join(ROOT, "data", "external", "peers", "latest.json");
const REGIME = path.join(ROOT, "regime-today.json");
const UA =
  "GlobalFlows/0.1 (+https://markmaga.com; educational macro instrument; peers desk)";
const DRY = process.argv.includes("--dry-run");

const AXES = ["liquidity", "rates", "growth", "inflation", "risk"];

const WORDS = {
  liquidity: ["Easing", "Leaning easy", "Neutral", "Leaning tight", "Tightening"],
  rates: ["Easy", "Leaning easy", "Neutral", "Leaning tight", "Tight"],
  growth: ["Strong", "Leaning strong", "Mid", "Leaning soft", "Soft"],
  inflation: ["Hot", "Leaning hot", "Mid", "Leaning cold", "Cold"],
  risk: ["Risk-on", "Leaning risk-on", "Neutral", "Leaning risk-off", "Risk-off"],
};

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function strip(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDate(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) return iso(+m[3], month, +m[2]);
  }
  m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return iso(+m[3], month, +m[1]);
  }
  return null;
}

function shiftIso(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function headOk(url) {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  return res.ok;
}

const BROCHURE =
  /explore our|tools and training|for advisors|educational resources|investment strategies, solutions|subscribe|cookie|disclaimer|past performance/i;

function paragraphsFrom(htmlChunk) {
  const out = [];
  for (const m of htmlChunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = strip(m[1]);
    if (t.length < 40 || t.length > 500) continue;
    if (/^(source:|notes:|figure \d|about us )/i.test(t)) continue;
    if (BROCHURE.test(t)) continue;
    out.push(t);
  }
  return out;
}

function paragraphs(html) {
  const blog = html.lastIndexOf("blogDate");
  const source = blog > 0 ? html.slice(Math.max(0, blog - 6000), blog) : html;
  const escaped = source
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"');
  const fromJson = paragraphsFrom(escaped);
  const fromHtml = paragraphsFrom(html);
  return fromJson.length >= 2 ? fromJson : fromHtml;
}

function quotesFrom(paras) {
  const quotes = [];
  for (const p of paras) {
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      const line = sentence.trim();
      if (line.length < 40 || line.length > 320) continue;
      if (BROCHURE.test(line)) continue;
      if (!quotes.includes(line)) quotes.push(line);
      if (quotes.length === 2) return quotes;
    }
  }
  return quotes;
}

function has(text, re) {
  return re.test(text);
}

/**
 * A component is set only by a phrase the note actually uses.
 * Two conflicting phrases leave the cell blank.
 */
function readComponents(text) {
  const hits = {
    liquidity: [],
    rates: [],
    growth: [],
    inflation: [],
    risk: [],
  };
  const add = (axis, word) => {
    if (!hits[axis].includes(word)) hits[axis].push(word);
  };

  if (has(text, /competition for capital/i)) add("liquidity", "Leaning tight");
  if (has(text, /financial conditions (are|remain) loose/i)) add("liquidity", "Leaning easy");

  if (has(text, /higher for longer/i)) add("rates", "Leaning tight");
  if (has(text, /mild restraint/i)) add("rates", "Leaning tight");
  if (has(text, /shallow tightening/i)) add("rates", "Leaning tight");
  if (has(text, /one (further|more).{0,40}(hike|increase)/i)) add("rates", "Leaning tight");
  if (has(text, /one or two more.{0,40}(hike|hikes)/i)) add("rates", "Leaning tight");
  if (has(text, /not a rate-hike cycle/i)) add("rates", "Neutral");
  if (has(text, /tightening may be overstated/i)) add("rates", "Leaning tight");

  if (has(text, /resilient growth|growth remains firm|firm economic growth/i)) {
    add("growth", "Leaning strong");
  }
  if (has(text, /little change in the growth outlook/i)) add("growth", "Leaning strong");
  if (has(text, /\bstrong growth\b/i)) add("growth", "Strong");

  if (has(text, /sticky inflation/i)) add("inflation", "Leaning hot");
  if (has(text, /underlying inflation pressures remain moderate/i)) add("inflation", "Mid");
  if (has(text, /wage pressures.{0,40}elevated|inflation.{0,30}elevated/i)) {
    add("inflation", "Leaning hot");
  }

  if (has(text, /\brisk-on\b|\bpro-risk\b/i)) add("risk", "Risk-on");
  if (has(text, /\brisk-off\b/i)) add("risk", "Risk-off");
  if (has(text, /constructive on equities|remain constructive|equities withstand|not be a problem for risk assets/i)) {
    add("risk", "Risk-on");
  }

  const out = {};
  for (const axis of AXES) {
    out[axis] = hits[axis].length === 1 && WORDS[axis].includes(hits[axis][0]) ? hits[axis][0] : null;
  }
  return out;
}

function family(word) {
  const w = String(word || "").toLowerCase();
  if (["tight", "leaning tight", "tightening"].includes(w)) return "tight";
  if (["easy", "leaning easy", "easing"].includes(w)) return "easy";
  if (["hot", "leaning hot"].includes(w)) return "hot";
  if (["cold", "leaning cold"].includes(w)) return "cold";
  if (["strong", "leaning strong"].includes(w)) return "strong";
  if (["soft", "leaning soft"].includes(w)) return "soft";
  if (["risk-on", "leaning risk-on"].includes(w)) return "risk-on";
  if (["risk-off", "leaning risk-off"].includes(w)) return "risk-off";
  if (["neutral", "mid"].includes(w)) return "mid";
  return "";
}

function sameSide(a, b) {
  const fa = family(a);
  return Boolean(fa) && fa === family(b);
}

function buildVs(components, regime) {
  const lights = regime?.lights || {};
  const equities = regime?.meaning?.favor?.items?.find((i) => i.id === "stocks");
  const named = AXES.filter((id) => components[id]);
  if (!named.length) {
    return {
      vs: "quiet",
      vsClause: "They did not read Liquidity, Rates, Growth, Inflation, or Risk.",
    };
  }
  const bits = named.map((id) => {
    const ours = lights[id]?.word;
    const theirs = components[id];
    if (ours && sameSide(ours, theirs)) return `${label(id)} matches (${theirs}).`;
    if (ours) return `Their ${label(id)} is ${theirs}; ours is ${ours}.`;
    return `Their ${label(id)} is ${theirs}.`;
  });
  if (components.risk === "Risk-on" && equities?.stance === "out") {
    bits.push("They stay with equities, which are out.");
  }
  const clashes = named.filter((id) => lights[id]?.word && !sameSide(lights[id].word, components[id]));
  const vs = clashes.length ? "challenge" : named.length >= 3 ? "agree" : "lean";
  return { vs, vsClause: bits.join(" ") };
}

function label(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function buildScorecard(houses, regime) {
  const lights = regime?.lights || {};
  const equities = regime?.meaning?.favor?.items?.find((i) => i.id === "stocks");
  const treasuries = regime?.meaning?.favor?.items?.find((i) => i.id === "treasuries");
  const agrees = [];
  const challenged = [];
  for (const id of AXES) {
    const ours = lights[id]?.word;
    if (!ours) continue;
    const who = houses.filter((h) => h[id] && sameSide(h[id], ours)).map((h) => shortName(h));
    const against = houses.filter((h) => h[id] && !sameSide(h[id], ours)).map((h) => shortName(h));
    if (who.length) agrees.push(`${label(id)} ${ours}: ${who.join(", ")}.`);
    if (against.length) {
      challenged.push(
        `${label(id)} is ${ours}. ${against
          .map((name) => {
            const h = houses.find((x) => shortName(x) === name);
            return `${name} says ${h[id]}`;
          })
          .join("; ")}.`
      );
    }
  }
  if (equities?.stance === "out") {
    const pro = houses.filter((h) => h.risk === "Risk-on").map((h) => shortName(h));
    if (pro.length) challenged.push(`Equities are out. ${pro.join(", ")} stay risk-on.`);
  }
  if (treasuries?.stance === "in") {
    challenged.push("The long end is in. A house that will not own it is a challenge, not a match.");
  }
  const recentCut = shiftIso(todayIso(), -45);
  const pool = houses.some((h) => h.date && h.date >= recentCut)
    ? houses.filter((h) => h.date && h.date >= recentCut)
    : houses;
  let closest = null;
  let best = 0;
  for (const h of pool) {
    const n = AXES.filter((id) => h[id] && lights[id]?.word && sameSide(h[id], lights[id].word)).length;
    if (n > best) {
      best = n;
      closest = h;
    }
  }
  return {
    agrees,
    challenged,
    closest: closest
      ? {
          name: shortName(closest),
          clause: `${best} of the five match. The card is still their note, not our score.`,
        }
      : { name: "—", clause: "No house matched a component today." },
    falsifier:
      "A cool inflation print that kills the next hike while stocks and the long end bid together — or a further jump in long yields that takes earnings with it.",
  };
}

function shortName(h) {
  if (h.id === "gsam") return "Goldman Sachs AM";
  if (h.id === "twentytwov") return "22V";
  if (h.id === "ubs") return "UBS";
  if (h.id === "blackrock") return "BlackRock";
  if (h.id === "citi") return "Citi";
  if (h.id === "pimco") return "PIMCO";
  if (h.id === "barclays") return "Barclays";
  if (h.id === "jpm") return "JPMorgan AM";
  if (h.id === "apollo") return "Apollo";
  return h.name;
}

function cardFromNote(house, note, regime) {
  const quotes = quotesFrom(note.paragraphs || []);
  if (quotes.length < 2) {
    throw new Error("fewer than two lines on the page");
  }
  const plain = (note.paragraphs || []).join(" ");
  const components = readComponents(plain);
  const { vs, vsClause } = buildVs(components, regime);
  return {
    ...house,
    date: note.date,
    title: note.title,
    url: note.url,
    ...components,
    assets: null,
    vs,
    vsClause,
    quote: quotes[0].slice(0, 90),
    quotes,
  };
}

async function noteFromArticle(url, date, title) {
  const html = await getText(url);
  const paragraphsOnPage = paragraphs(html);
  return { date, title: strip(title), url, paragraphs: paragraphsOnPage };
}

async function discoverApollo() {
  const index = "https://www.apollo.com/wealth/insights-news/insights/daily-spark";
  const html = await getText(index);
  const m = html.match(
    /blog-detail-info-date">([^<]+)<\/p>[\s\S]*?href="(\/wealth\/insights-news\/insights\/daily-spark\/[^"]+)"[^>]*>([^<]+)/
  );
  if (!m) throw new Error("apollo index had no note");
  const date = parseDate(m[1]);
  const url = new URL(m[2], "https://www.apollo.com").href;
  return noteFromArticle(url, date, m[3]);
}

async function discoverUbs() {
  const start = new Date(`${todayIso()}T12:00:00Z`);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const date = `${yyyy}-${mm}-${dd}`;
    const url = `https://www.ubs.com/global/en/wealthmanagement/insights/chief-investment-office/house-view/daily/2026/latest-${dd}${mm}${yyyy}.html`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) continue;
    const htmlNote = await res.text();
    const title = strip((htmlNote.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ""])[1]) || "UBS CIO daily";
    return { date, title, url, paragraphs: paragraphs(htmlNote) };
  }
  throw new Error("ubs daily not found");
}

async function discoverBlackrock() {
  const page =
    "https://www.blackrock.com/corporate/insights/blackrock-investment-institute/global-weekly-commentary";
  const html = await getText(page);
  const title = strip((html.match(/name="articleTitle" content="([^"]+)"/) || [, ""])[1]);
  const pdf = html.match(/\/gls-download\/literature\/market-commentary\/weekly-investment-commentary-en-us-(\d{8})-[^"\\]+\.pdf/);
  if (!title || !pdf) throw new Error("blackrock weekly had no title or date");
  const date = parseDate(pdf[1]);
  const url = `https://www.blackrock.com${pdf[0]}`;
  return { date, title, url, paragraphs: paragraphs(html) };
}

async function discoverGsam() {
  const url = "https://am.gs.com/en-us/advisors/insights/article/market-pulse";
  const html = await getText(url);
  const dated = html.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/);
  const date = dated ? parseDate(dated[1]) : null;
  const title = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, "Market Pulse"])[1]) || "Market Pulse";
  if (!date) throw new Error("gsam pulse had no date");
  return { date, title, url, paragraphs: paragraphs(html) };
}

async function discoverCiti(card) {
  const start = new Date(`${todayIso()}T12:00:00Z`);
  for (let i = 0; i < 21; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const date = `${y}-${m}-${day}`;
    if (card?.date && date <= card.date) return null;
    const url = `https://www.docs.citi.com/WealthOCIO/${y}${m}${day}_CIO_Bulletin.pdf`;
    if (await headOk(url)) {
      console.log(`  citi  newer bulletin ${date} is a PDF — card left`);
      return null;
    }
  }
  return null;
}

async function discover22v() {
  const html = await getText("https://22vresearch.com/");
  const date = parseDate((html.match(/research-card_date">\s*([^<]+)/) || [, ""])[1]);
  const url = (html.match(/href="(https:\/\/22vresearch\.com\/20\d{2}\/\d{2}\/\d{2}\/[^"]+)"/) || [, ""])[1];
  const title = strip((html.match(/research-card_name">\s*([^<]+)/) || [, ""])[1]);
  if (!date || !url || !title) throw new Error("22v homepage had no note");
  return noteFromArticle(url, date, title);
}

async function discoverPimco() {
  // The insights index is drawn in the browser, so a fetch cannot see a new note.
  console.log("  pimco  index is not a dated list — card left");
  return null;
}

async function discoverBarclays() {
  const html = await getText("https://privatebank.barclays.com/insights/");
  const link = html.match(/href="(\/insights\/market-perspectives-[^"]+\/)"/i);
  if (!link) throw new Error("barclays had no market perspectives");
  const url = new URL(link[1], "https://privatebank.barclays.com").href;
  const page = await getText(url);
  const title = strip((page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, "Market Perspectives"])[1]);
  const date = parseDate((page.match(/\b(\d{1,2}\s+[A-Za-z]+\s+20\d{2}|[A-Za-z]+\s+\d{1,2},\s+20\d{2})\b/) || [, ""])[1]);
  if (!date) throw new Error("barclays perspectives had no date");
  return { date, title, url, paragraphs: paragraphs(page) };
}

async function discoverJpm() {
  const url =
    "https://am.jpmorgan.com/us/en/asset-management/institutional/insights/portfolio-insights/asset-class-views/asset-allocation/";
  const html = await getText(url);
  const title = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ""])[1]);
  const published = html.match(/"datePublished":"(20\d{2}-\d{2}-\d{2})/);
  const date = published ? published[1] : null;
  if (!date || !title) throw new Error("jpm allocation had no date");
  return { date, title, url, paragraphs: paragraphs(html) };
}

const DISCOVER = {
  apollo: discoverApollo,
  ubs: discoverUbs,
  blackrock: discoverBlackrock,
  gsam: discoverGsam,
  citi: discoverCiti,
  twentytwov: discover22v,
  pimco: discoverPimco,
  barclays: discoverBarclays,
  jpm: discoverJpm,
};

async function main() {
  const peers = JSON.parse(await fs.readFile(PEERS, "utf8"));
  const regime = JSON.parse(await fs.readFile(REGIME, "utf8"));
  let moved = 0;

  for (const house of peers.houses) {
    const discover = DISCOVER[house.id];
    if (!discover) {
      console.log(`  ${house.id}  no watch`);
      continue;
    }
    try {
      const note = await discover(house);
      if (!note) {
        console.log(`  ${house.id}  quiet`);
        continue;
      }
      if (!note.date || (house.date && note.date <= house.date)) {
        console.log(`  ${house.id}  quiet  ${note.date || "no date"}`);
        continue;
      }
      const prev = house.date;
      const next = cardFromNote(house, note, regime);
      Object.assign(house, next);
      moved += 1;
      console.log(`  ${house.id}  ${prev} → ${note.date}  ${note.title}`);
    } catch (err) {
      console.error(`  ${house.id}  FAIL  ${err.message || err}`);
    }
  }

  const scorecard = buildScorecard(peers.houses, regime);
  const scoreChanged = JSON.stringify(scorecard) !== JSON.stringify(peers.scorecard);
  if (!moved && !scoreChanged) {
    console.log("quiet — no house page moved, and the comparison is unchanged.");
    return;
  }
  if (moved) peers.placed = todayIso();
  peers.scorecard = scorecard;
  for (const house of peers.houses) {
    if (!house.date) continue;
    const { vs, vsClause } = buildVs(house, regime);
    house.vs = vs;
    house.vsClause = vsClause;
  }

  if (DRY) {
    console.log(DRY ? `dry-run — ${moved} card(s) would change` : "");
    return;
  }
  await fs.writeFile(PEERS, JSON.stringify(peers, null, 2) + "\n", "utf8");
  console.log(`wrote ${path.relative(ROOT, PEERS)} — ${moved} card(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
