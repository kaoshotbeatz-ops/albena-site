#!/usr/bin/env node
// Generates web/src/data/controls.json from controls/nist-800-53-moderate.csv
// (plus SOC 2 mapping from controls/soc2-tsc.csv). Use --check to verify the file is current.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NIST = resolve(root, "controls/nist-800-53-moderate.csv");
const SOC2 = resolve(root, "controls/soc2-tsc.csv");
const OUT = resolve(root, "web/src/data/controls.json");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const nist = parseCsv(readFileSync(NIST, "utf8"));
const soc2Ids = new Set();
for (const r of parseCsv(readFileSync(SOC2, "utf8"))) {
  for (const id of r.nist_ids.split(";")) soc2Ids.add(id.trim());
}

const out = nist
  .filter((r) => r.applicability !== "not-applicable" && r.status)
  .map((r) => ({
    id: r.id,
    family: r.family,
    title: r.title,
    framework: ["NIST 800-53", ...(soc2Ids.has(r.id) ? ["SOC 2"] : [])],
    status: r.status,
    evidence: r.evidence,
  }));

const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) {
    console.error("web/src/data/controls.json is out of date; run: node scripts/build-controls.mjs");
    process.exit(1);
  }
  console.log(`controls.json up to date (${out.length} controls)`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${out.length} controls)`);
}
