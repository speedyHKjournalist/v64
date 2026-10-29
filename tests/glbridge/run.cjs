#!/usr/bin/env node
"use strict";
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
let failures = 0;
for (const file of readdirSync(__dirname).sort()) {
    if (!file.endsWith("_test.js") || file.includes("_perf_") || file.includes("_corpus_")) continue;
    const result = spawnSync(process.execPath, [join(__dirname, file)], { encoding: "utf8", timeout: 120000 });
    // A file that exits 0 without saying what passed has not shown it ran
    // anything; a SKIP is a failure unless the run allows it (a local run
    // without naga, GLBRIDGE_ALLOW_NO_NAGA=1)
    const stdout = result.stdout || "";
    const skipped = /^SKIP:/m.test(stdout);
    const summary = /\b(pass(ed)?|ok|validated)\b/i.test(stdout.trim().split("\n").pop() || "");
    const ok = result.status === 0 && (skipped ? process.env.GLBRIDGE_ALLOW_NO_NAGA === "1" : summary);
    console.log(`${skipped && ok ? "SKIP" : ok ? "PASS" : "FAIL"} ${file}`);
    if (!ok) {
        failures++;
        if (result.status === 0) console.error(skipped ? "  skipped" : "  printed no summary line");
        console.error(result.stdout, result.stderr, result.error || "");
    }
}
process.exitCode = failures ? 1 : 0;
