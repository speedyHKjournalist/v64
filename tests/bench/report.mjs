#!/usr/bin/env node
// Summarize a benchmark result file, or compare two (before -> after).
//   node tests/bench/report.mjs results.json [previous.json] [--arm ir] [--markdown]
// Ratios are against the file's reference arm: the --baseline core ("baseline"),
// or "legacy" in results recorded before IR became the only backend. Without
// one, only MIPS are shown. The comparison reports the arm's own speedup
// between the two files, which is independent of that reference.
import fs from "node:fs";

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--arm"));
const arm = args.includes("--arm") ? args[args.indexOf("--arm") + 1] : "ir";
const markdown = args.includes("--markdown");
const [current, previous] = files.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
if(!current) { console.error("usage: report.mjs results.json [previous.json] [--arm ir] [--markdown]"); process.exit(2); }

const fmt = (v, digits = 2) => v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(digits);
const reference = ["baseline", "legacy"].find(name => name !== arm && current.results.some(r => r.arms?.[name]));
const rows = [];
const header = ["benchmark", "category", `${reference ?? "reference"} MIPS`, `${arm} MIPS`, "warm x", "cold x"];
if(previous) header.push(`${arm} vs prev`);
for(const r of current.results) {
    const a = r.arms?.[arm], l = reference && r.arms?.[reference];
    if(!a || r.error) { rows.push([r.name, r.category, "error", r.error || "-", "", ""]); continue; }
    const row = [r.name, r.category, fmt(l?.warm_mips, 0), fmt(a.warm_mips, 0), fmt(a.warm_ratio), fmt(a.cold_ratio)];
    if(previous) {
        const p = previous.results.find(x => x.name === r.name)?.arms?.[arm];
        row.push(p?.warm ? fmt(p.warm / a.warm) : "-");
    }
    rows.push(row);
}
const s = current.scores?.[arm];
if(markdown) {
    console.log(`| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|`);
    for(const row of rows) console.log(`| ${row.join(" | ")} |`);
}
else {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? "").length)));
    const line = cells => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
    console.log(line(header));
    for(const row of rows) console.log(line(row));
}
if(s) {
    console.log(`\n${arm} vs ${reference} (${current.revision ?? "?"}, ${current.date}): warm ${fmt(s.warm, 3)}, cold ${fmt(s.cold, 3)}`);
    for(const [c, v] of Object.entries(s.categories)) console.log(`  ${c.padEnd(9)} warm ${fmt(v.warm, 3)}  cold ${fmt(v.cold, 3)}`);
}
if(previous?.scores?.[arm]) {
    const p = previous.scores[arm];
    console.log(`previous (${previous.revision ?? "?"}): warm ${fmt(p.warm, 3)}, cold ${fmt(p.cold, 3)}`);
}
if(current.errors?.length) console.log(`\nerrors:\n  ${current.errors.join("\n  ")}`);
