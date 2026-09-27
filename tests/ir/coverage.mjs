// Counts of the IR lowering path per decoder form (src/rust/ir/frontend/ir-coverage.json).
// --require-complete: every valid form has an attributed lowering path.
import assert from "node:assert/strict";
import fs from "node:fs";
const catalogue = JSON.parse(fs.readFileSync("src/rust/ir/frontend/ir-coverage.json"));
assert.equal(catalogue.schema, 2, "regenerate src/rust/ir/frontend/ir-coverage.json (gen/generate_ir_decoder.js)");
assert.equal(new Set(catalogue.forms.map(f => f.key)).size, catalogue.forms.length, "duplicate coverage key");
for(const form of catalogue.forms) {
    assert(form.lowering === "Pending" || form.tests.length > 0, `missing suite attribution: ${form.key}`);
    for(const path of form.tests) assert(fs.existsSync(path), `missing coverage suite ${path}`);
}
const counts = new Map();
for(const form of catalogue.forms) counts.set(form.lowering, (counts.get(form.lowering) || 0) + 1);
const pending = counts.get("Pending") || 0;
const categories = [...counts].filter(([name]) => name !== "Pending").sort((a, b) => b[1] - a[1]);
console.log(`${catalogue.encodings} encodings; ${catalogue.forms.length} forms; ${pending} Pending; ` +
    categories.map(([name, count]) => `${count} ${name}`).join(", "));
if(process.argv.includes("--require-complete")) {
    const missing = catalogue.forms.filter(f => f.lowering === "Pending").slice(0, 10).map(f => f.key);
    assert.equal(pending, 0, `forms without an IR lowering path: ${missing.join(" ")}`);
}
