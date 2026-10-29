// The naga binary the WGSL validation tests run (naga-cli 30). Without it they
// would validate nothing, so its absence fails the test -- CI installs it --
// unless GLBRIDGE_ALLOW_NO_NAGA=1 says a local run may go without.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function findNaga() {
    for (const variable of ["NAGA", "D9_NAGA", "GL_NAGA"])
        if (process.env[variable]) return process.env[variable];
    if (spawnSync("naga", ["--version"], { encoding: "utf8" }).status === 0) return "naga";
    const cargo = path.join(os.homedir(), ".cargo", "bin", "naga");
    return fs.existsSync(cargo) ? cargo : null;
}

// The naga to use, or null when a local run is allowed to go without; exits
// the test with a failure otherwise
function requireNaga(test) {
    const naga = findNaga();
    if (naga) return naga;
    if (process.env.GLBRIDGE_ALLOW_NO_NAGA === "1") {
        console.log("SKIP: " + test + ": no naga (GLBRIDGE_ALLOW_NO_NAGA=1)");
        return null;
    }
    console.error(test + ": no naga binary -- `cargo install naga-cli --version 30.0.0`, " +
        "or set NAGA, or GLBRIDGE_ALLOW_NO_NAGA=1 to skip WGSL validation locally");
    process.exit(1);
}

module.exports = { findNaga, requireNaga };
