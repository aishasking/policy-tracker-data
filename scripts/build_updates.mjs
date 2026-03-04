// scripts/build_updates.mjs
import fs from "node:fs";

function pickCategory(title = "") {
  const t = title.toLowerCase();
  if (t.includes("cms") || t.includes("medicare") || t.includes("medicaid")) return "CMS";
  if (t.includes("fda")) return "FDA";
  if (t.includes("cdc") || t.includes("mmwr")) return "CDC";
  if (t.includes("senate") || t.includes("house") || t.includes("bill") || t.includes("act")) return "LEGIS";
  return "LEGIS";
}

function priorityFromTitle(title = "") {
  const t = title.toLowerCase();
  if (t.includes("final") || t.includes("enforcement") || t.includes("penalt") || t.includes("rule")) return "high";
  if (t.includes("proposed") || t.includes("draft") || t.includes("guidance")) return "medium";
  return "low";
}

// This is a starter generator.
// Today it just writes a simple demo payload with "last updated".
// Next step is swapping in real RSS/API pulls.
const now = new Date();
const isoDate = now.toISOString().slice(0, 10);

const updates = [
  {
    id: 1,
    category: "CMS",
    date: isoDate,
    title: `Daily refresh test (${isoDate})`,
    summary: "If you can see this date change each day, your automation is working.",
    tags: ["Automation", "Test"],
    priority: "low",
  },
];

const output = {
  generated_at: now.toISOString(),
  updates,
};

fs.writeFileSync("updates.json", JSON.stringify(output, null, 2));
console.log("Wrote updates.json");
