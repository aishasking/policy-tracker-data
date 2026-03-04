// scripts/build_updates.mjs
// Generates updates.json from live federal sources (Federal Register + CMS RSS + FDA RSS)

import fs from "node:fs";
import crypto from "node:crypto";

// ---- CONFIG (edit these if you want) ----
const MAX_ITEMS_PER_SOURCE = 10;

// Federal Register: documents endpoint supports JSON filters. Docs: developer resources / REST API. :contentReference[oaicite:3]{index=3}
const FEDREG_URL =
  "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest";

// CMS: CMS provides multiple RSS feeds (you can swap to a specific feed later). :contentReference[oaicite:4]{index=4}
// This feed link is a placeholder—replace with the specific CMS RSS URL you choose from the CMS RSS page.
const CMS_RSS_URL = "https://www.cms.gov/about-cms/contact/newsroom/rss";

// FDA: FDA provides many RSS feeds (press releases, recalls, etc.). :contentReference[oaicite:5]{index=5}
// This is a commonly used Press Releases RSS. If it 404s, pick a feed URL from FDA’s RSS page.
const FDA_RSS_URL = "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/medwatch/rss.xml";
// ---- HELPERS ----
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function normalizeDate(dateStr) {
  // Convert ISO date/time into YYYY-MM-DD when possible
  if (!dateStr) return new Date().toISOString().slice(0, 10);
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function priorityFromText(title = "", summary = "") {
  const t = (title + " " + summary).toLowerCase();
  if (
    t.includes("final rule") ||
    t.includes("finalized") ||
    t.includes("enforcement") ||
    t.includes("civil monetary penalty") ||
    t.includes("penalt") ||
    t.includes("termination") ||
    t.includes("suspension")
  )
    return "high";
  if (t.includes("proposed") || t.includes("draft") || t.includes("request for information") || t.includes("rfi"))
    return "medium";
  return "low";
}

function tagsFromCategoryAndText(category, title = "") {
  const tags = new Set();
  if (category) tags.add(category);
  const t = title.toLowerCase();
  if (t.includes("medicare advantage") || t.includes("ma ")) tags.add("Medicare Advantage");
  if (t.includes("medicaid")) tags.add("Medicaid");
  if (t.includes("medicare")) tags.add("Medicare");
  if (t.includes("telehealth")) tags.add("Telehealth");
  if (t.includes("price transparency")) tags.add("Price Transparency");
  if (t.includes("drug") || t.includes("pharma")) tags.add("Drugs");
  if (t.includes("ai") || t.includes("machine learning")) tags.add("AI/ML");
  return Array.from(tags).slice(0, 6);
}

// Extremely small RSS parser (good enough for most RSS feeds)
function parseRssItems(xmlText) {
  const items = [];
  const itemBlocks = xmlText.split(/<item\b[^>]*>/i).slice(1);
  for (const blk of itemBlocks) {
    const itemXml = blk.split(/<\/item>/i)[0] || "";
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/i)?.[1] ||
      "").trim();
    const link = (itemXml.match(/<link>(.*?)<\/link>/i)?.[1] || "").trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/i)?.[1] || "").trim();
    const description =
      (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i)?.[1] ||
        itemXml.match(/<description>(.*?)<\/description>/i)?.[1] ||
        "").trim();

    if (!title || !link) continue;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "policy-tracker-bot/1.0" } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": "policy-tracker-bot/1.0" } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return r.text();
}

// ---- SOURCE: Federal Register ----
async function loadFederalRegister() {
  const data = await fetchJson(FEDREG_URL);
  const docs = Array.isArray(data?.results) ? data.results : [];

  return docs.slice(0, MAX_ITEMS_PER_SOURCE).map((d) => {
    const title = d.title || "Federal Register document";
    const link = d.html_url || d.pdf_url || "";
    const date = normalizeDate(d.publication_date || d.public_inspection_date);
    const summary = (d.abstract || d.excerpts || "").toString().slice(0, 400);

    // simple category mapping
    const agencies = Array.isArray(d.agencies) ? d.agencies.map((a) => a.name).join(", ") : "";
    let category = "LEGIS";
    const agenciesLower = agencies.toLowerCase();
    if (agenciesLower.includes("centers for medicare") || agenciesLower.includes("cms")) category = "CMS";
    if (agenciesLower.includes("food and drug") || agenciesLower.includes("fda")) category = "FDA";
    if (agenciesLower.includes("centers for disease") || agenciesLower.includes("cdc")) category = "CDC";

    return {
      id: sha1(`fedreg:${d.document_number || link || title}`),
      category,
      date,
      title,
      summary: summary || "Federal Register item (no abstract provided).",
      tags: tagsFromCategoryAndText(category, title),
      priority: priorityFromText(title, summary),
      source: "Federal Register",
      url: link
    };
  });
}

// ---- SOURCE: CMS RSS ----
async function loadCmsRss() {
  const xml = await fetchText(CMS_RSS_URL);
  const items = parseRssItems(xml);

  return items.slice(0, MAX_ITEMS_PER_SOURCE).map((it) => {
    const title = it.title;
    const date = normalizeDate(it.pubDate);
    const summary = (it.description || "").replace(/<[^>]+>/g, "").slice(0, 400);

    return {
      id: sha1(`cms:${it.link}`),
      category: "CMS",
      date,
      title,
      summary: summary || "CMS update.",
      tags: tagsFromCategoryAndText("CMS", title),
      priority: priorityFromText(title, summary),
      source: "CMS",
      url: it.link
    };
  });
}

// ---- SOURCE: FDA RSS ----
async function loadFdaRss() {
  // FDA has many feeds; this URL may be a landing page, not an RSS XML.
  // If this doesn't return XML with <item>, replace FDA_RSS_URL with a specific RSS feed URL from FDA’s RSS page. :contentReference[oaicite:6]{index=6}
  const txt = await fetchText(FDA_RSS_URL);
  if (!txt.toLowerCase().includes("<rss") && !txt.toLowerCase().includes("<feed")) {
    // Not XML feed; return empty with a note item
    return [
      {
        id: sha1("fda:feed-not-configured"),
        category: "FDA",
        date: new Date().toISOString().slice(0, 10),
        title: "FDA feed not yet configured",
        summary:
          "Your FDA_RSS_URL is not an RSS XML feed. Replace FDA_RSS_URL with a specific FDA RSS feed URL (e.g., Press Releases, Recalls, MedWatch).",
        tags: ["FDA", "Setup"],
        priority: "low",
        source: "FDA",
        url: "https://www.fda.gov/about-fda/contact-fda/subscribe-podcasts-and-news-feeds"
      }
    ];
  }

  const items = parseRssItems(txt);
  return items.slice(0, MAX_ITEMS_PER_SOURCE).map((it) => {
    const title = it.title;
    const date = normalizeDate(it.pubDate);
    const summary = (it.description || "").replace(/<[^>]+>/g, "").slice(0, 400);

    return {
      id: sha1(`fda:${it.link}`),
      category: "FDA",
      date,
      title,
      summary: summary || "FDA update.",
      tags: tagsFromCategoryAndText("FDA", title),
      priority: priorityFromText(title, summary),
      source: "FDA",
      url: it.link
    };
  });
}

// ---- MAIN ----
async function main() {
  const now = new Date();

  let fedreg = [];
  let cms = [];
  let fda = [];

  // Fail “softly” per source so one bad feed doesn’t kill the whole build.
  try { fedreg = await loadFederalRegister(); } catch (e) { console.error("FedReg error:", e.message); }
  try { cms = await loadCmsRss(); } catch (e) { console.error("CMS RSS error:", e.message); }
  try { fda = await loadFdaRss(); } catch (e) { console.error("FDA RSS error:", e.message); }

  // Merge + sort newest first
  const merged = [...fedreg, ...cms, ...fda]
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 50);

  const output = {
    generated_at: now.toISOString(),
    updates: merged
  };

  fs.writeFileSync("updates.json", JSON.stringify(output, null, 2));
  console.log(`Wrote updates.json with ${merged.length} items`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
