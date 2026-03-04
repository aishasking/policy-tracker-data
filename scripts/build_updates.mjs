// scripts/build_updates.mjs
// Reliable daily policy feed: CMS RSS + FDA RSS + (optional) Federal Register if not blocked.
// Output format: { generated_at, updates: [...] }

import fs from "node:fs";
import crypto from "node:crypto";

const MAX_PER_FEED = 20;         // how many from each source
const MAX_TOTAL = 60;            // overall cap
const LOOKBACK_DAYS = 21;        // keep only last N days

// ✅ CMS RSS feeds are documented by CMS. Pick a stable feed URL from CMS RSS page if you want a different one. :contentReference[oaicite:2]{index=2}
const CMS_RSS_URL = "https://www.cms.gov/about-cms/contact/newsroom/rss";

// ✅ FDA RSS feeds: use a *specific* RSS XML feed URL (not the directory page). FDA publishes RSS feed list. :contentReference[oaicite:3]{index=3}
const FDA_PRESS_RSS_URL = "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases.xml";
const FDA_MEDWATCH_RSS_URL = "https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program/medwatch-rss-feed";

// ⚠️ Federal Register often rate-limits / blocks automated access. If it works for you, great. If it’s blocked, we just skip it. :contentReference[oaicite:4]{index=4}
const FEDREG_URL =
  "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest";

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function withinLookback(yyyy_mm_dd) {
  const now = new Date();
  const d = new Date(yyyy_mm_dd + "T00:00:00Z");
  const diffDays = Math.floor((now - d) / 86400000);
  return diffDays >= 0 && diffDays <= LOOKBACK_DAYS;
}

function categoryFromText(title = "", summary = "") {
  const t = (title + " " + summary).toLowerCase();
  if (t.includes("fda") || t.includes("medwatch") || t.includes("drug") || t.includes("device")) return "FDA";
  if (t.includes("cms") || t.includes("medicare") || t.includes("medicaid") || t.includes("star ratings")) return "CMS";
  if (t.includes("cdc") || t.includes("mmwr") || t.includes("immunization")) return "CDC";
  return "LEGIS";
}

function priorityFromText(title = "", summary = "") {
  const t = (title + " " + summary).toLowerCase();
  if (
    t.includes("final rule") ||
    t.includes("finalizes") ||
    t.includes("enforcement") ||
    t.includes("civil monetary") ||
    t.includes("penalt") ||
    t.includes("suspend") ||
    t.includes("terminate")
  ) return "high";
  if (t.includes("proposed") || t.includes("draft") || t.includes("request for information") || t.includes("rfi")) return "medium";
  return "low";
}

// Minimal RSS parser (works for most standard RSS feeds)
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item\b[^>]*>/i).slice(1);
  for (const blk of blocks) {
    const itemXml = (blk.split(/<\/item>/i)[0] || "").trim();
    const title =
      (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i)?.[1] ||
        itemXml.match(/<title>(.*?)<\/title>/i)?.[1] ||
        "").trim();
    const link = (itemXml.match(/<link>(.*?)<\/link>/i)?.[1] || "").trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/i)?.[1] || "").trim();
    const desc =
      (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i)?.[1] ||
        itemXml.match(/<description>(.*?)<\/description>/i)?.[1] ||
        "").trim();

    if (!title || !link) continue;
    items.push({ title, link, pubDate, description: stripHtml(desc) });
  }
  return items;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": "policy-tracker-bot/1.0",
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "policy-tracker-bot/1.0", accept: "application/json" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return r.json();
}

async function loadRssFeed(url, sourceName, defaultCategory) {
  const xml = await fetchText(url);
  if (!xml.toLowerCase().includes("<item")) {
    throw new Error(`${sourceName} did not return RSS items`);
  }
  const items = parseRss(xml).slice(0, MAX_PER_FEED);

  return items.map((it) => {
    const date = normalizeDate(it.pubDate || new Date().toISOString());
    const summary = (it.description || "").slice(0, 420);
    const category = defaultCategory || categoryFromText(it.title, summary);

    return {
      id: sha1(`${sourceName}:${it.link}`),
      category,
      date,
      title: it.title,
      summary: summary || `${sourceName} update.`,
      tags: [sourceName],
      priority: priorityFromText(it.title, summary),
      source: sourceName,
      url: it.link,
    };
  });
}

async function loadFederalRegister() {
  const data = await fetchJson(FEDREG_URL);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, MAX_PER_FEED).map((d) => {
    const title = d.title || "Federal Register document";
    const url = d.html_url || d.pdf_url || "";
    const date = normalizeDate(d.publication_date || d.public_inspection_date || new Date().toISOString());
    const summary = stripHtml(d.abstract || "").slice(0, 420);
    const category = categoryFromText(title, summary);
    return {
      id: sha1(`FederalRegister:${d.document_number || url || title}`),
      category,
      date,
      title,
      summary: summary || "Federal Register document (no abstract provided).",
      tags: ["Federal Register"],
      priority: priorityFromText(title, summary),
      source: "Federal Register",
      url,
    };
  });
}

async function main() {
  const now = new Date();

  const all = [];

  // CMS
  try {
    all.push(...(await loadRssFeed(CMS_RSS_URL, "CMS", "CMS")));
  } catch (e) {
    console.error("CMS feed error:", e.message);
  }

  // FDA Press Releases
  try {
    all.push(...(await loadRssFeed(FDA_PRESS_RSS_URL, "FDA", "FDA")));
  } catch (e) {
    console.error("FDA Press feed error:", e.message);
  }

  // FDA MedWatch (this URL is an FDA page that displays RSS/XML per FDA; if it fails, skip) :contentReference[oaicite:5]{index=5}
  try {
    all.push(...(await loadRssFeed(FDA_MEDWATCH_RSS_URL, "FDA MedWatch", "FDA")));
  } catch (e) {
    console.error("FDA MedWatch feed error:", e.message);
  }

  // Federal Register (optional; may be blocked)
  try {
    all.push(...(await loadFederalRegister()));
  } catch (e) {
    console.error("Federal Register error (skipping):", e.message);
  }

  // Keep recent only, dedupe by url, sort newest first
  const byUrl = new Map();
  for (const u of all) {
    if (!u?.url) continue;
    if (!withinLookback(u.date)) continue;
    if (!byUrl.has(u.url)) byUrl.set(u.url, u);
  }

  const updates = Array.from(byUrl.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_TOTAL);

  const output = { generated_at: now.toISOString(), updates };
  fs.writeFileSync("updates.json", JSON.stringify(output, null, 2));
  console.log(`Wrote updates.json with ${updates.length} items`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
