#!/usr/bin/env node
// The region pipeline is frozen (docs/jit-unification-plan.md P7.6): it only
// gets bug fixes until it is deleted (M11), and a commit that touches its own
// code says so with `region-fix-only` in its message. The shared parts stay
// open: the decoding catalogue (ir/frontend/decode.rs, encodings.rs), the x87
// leaves (ir/backend/wasm/x87.rs, ir/x87.rs) and everything outside this list.
//
// Checks the commits in BASE..HEAD (BASE: --base, default the merge base with
// master) and the uncommitted changes, which pass only with REGION_FIX_ONLY=1
// (a reminder to write the tag in the commit message).
//
// Usage: tools/check_region_freeze.mjs [--base REV]

import { spawnSync } from "node:child_process";

const FROZEN = [
    /^src\/rust\/ir\/hir\.rs$/,
    /^src\/rust\/ir\/mir(\.rs$|\/)/,
    /^src\/rust\/ir\/passes\//,
    /^src\/rust\/ir\/lowering\.rs$/,
    /^src\/rust\/ir\/backend\/(locals|scalar|simd|structure)\.rs$/,
    /^src\/rust\/ir\/frontend\/(?!(decode|encodings)\.rs$)[^/]+\.rs$/,
    /^src\/rust\/ir\/runtime\/(compile|region|promotion)\.rs$/,
];
const TAG = "region-fix-only";

function git(...args)
{
    const r = spawnSync("git", args, { encoding: "utf8" });
    if(r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr.trim());
    return r.stdout.trim();
}

const frozen = paths => paths.filter(p => FROZEN.some(re => re.test(p)));

const args = process.argv.slice(2);
const base_index = args.indexOf("--base");
const base = base_index >= 0 ? args[base_index + 1] : git("merge-base", "HEAD", "master");

const problems = [];
for(const commit of git("rev-list", "--no-merges", `${base}..HEAD`).split("\n").filter(Boolean))
{
    const touched = frozen(git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n"));
    if(touched.length && !git("log", "-1", "--format=%B", commit).includes(TAG))
    {
        problems.push(`${commit.slice(0, 10)} "${git("log", "-1", "--format=%s", commit)}" touches ${touched.join(", ")} without ${TAG}`);
    }
}

const uncommitted = frozen([...new Set([...git("diff", "--name-only", "HEAD").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n")])]);
if(uncommitted.length && process.env.REGION_FIX_ONLY !== "1")
{
    problems.push(`uncommitted changes to ${uncommitted.join(", ")}: a bug fix only, committed with ${TAG} in the message (set REGION_FIX_ONLY=1 to pass)`);
}

if(problems.length)
{
    console.error("region freeze (docs/jit-unification-plan.md P7.6):\n  " + problems.join("\n  "));
    process.exit(1);
}
console.log(`region freeze: ok (${base.slice(0, 10)}..HEAD${uncommitted.length ? ", uncommitted region fix" : ""})`);
