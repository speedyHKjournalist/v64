#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import url from "node:url";
import { spawnSync } from "node:child_process";
import wabt from "../../build/libwabt.cjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const libwabt = await wabt();

const TEST_NAME = process.env.TEST_NAME;

const LOG_LEVEL = 0;
const MIN_MEMORY_OFFSET = 4096;

const GIT_DIFF_FLAGS = ["--no-index", "--patience", "--color=always"];

const TEST_DIR = path.join(__dirname, "tests");
const BUILD_DIR = path.join(TEST_DIR, "build");

function run_all()
{
    const asm_files = fs.readdirSync(TEST_DIR).filter(filename => filename.endsWith(".asm"));

    const files = asm_files.map(asm_file => {
        const name = asm_file.slice(0, -4);
        return {
            name,
            expect_file: path.relative(".", path.join(TEST_DIR, name + ".wast")),
            actual_file: path.relative(".", path.join(BUILD_DIR, name + ".actual.wast")),
            actual_wasm: path.relative(".", path.join(BUILD_DIR, name + ".wasm")),
            asm_file: path.join(TEST_DIR, name + ".asm"),
            executable_file: path.join(BUILD_DIR, name + ".bin"),
        };
    }).filter(({ name }) => !TEST_NAME || name === TEST_NAME);

    next_test(0);

    function next_test(i)
    {
        if(files[i])
        {
            run_test(files[i], () => next_test(i + 1));
        }
    }
}

// Remove parts that may not be stable between multiple runs
function normalise_wast(wast)
{
    return wast.replace(/offset=(\d+)/g, function(match, offset)
        {
            offset = Number(offset);

            if(offset >= MIN_MEMORY_OFFSET)
            {
                return "offset={normalised output}";
            }
            else
            {
                return match;
            }
        }).replace(/memory \$[\w\.]+ \d+/g, "memory {normalised output}");
}

function run_test({ name, executable_file, expect_file, actual_file, actual_wasm, asm_file }, onfinished)
{
    const emulator = new V86({
        autostart: false,
        memory_size: 2 * 1024 * 1024,
        log_level: LOG_LEVEL,
    });

    const executable = fs.readFileSync(executable_file);
    const asm = fs.readFileSync(asm_file);

    const is_32 = asm.includes("BITS 32\n");

    emulator.add_listener("emulator-loaded", async function()
        {
            const cpu = emulator.v86.cpu;
            const exports = cpu.wm.exports;

            const START_ADDRESS = 0x1000;

            cpu.is_32[0] = +is_32;
            cpu.stack_size_32[0] = +is_32;
            cpu.segment_offsets[1] = 0;
            cpu.instruction_pointer[0] = START_ADDRESS;
            cpu.mem8.set(executable, START_ADDRESS);
            cpu.update_state_flags();

            // One optimized Tier-2 region with structured control flow over the
            // program (a region covers at most 1920 bytes), with the automatic
            // policy's default budgets.
            const id = exports["ir_compile_live"](Math.min(executable.length, 1920), 2, 1, 1, 256, 64);
            if(!id)
            {
                console.error(`${name}.asm: IR compilation failed with error ${exports["ir_live_error"]()}`);
                process.exit(1);
            }
            const wasm = new Uint8Array(exports["memory"].buffer,
                exports["ir_live_info"](id, 0) >>> 0, exports["ir_live_info"](id, 1) >>> 0).slice();
            exports["ir_live_release"](id);
            await emulator.destroy();

            const wast = normalise_wast(disassemble_wasm(wasm));
            fs.writeFileSync(actual_file, wast);
            fs.writeFileSync(actual_wasm, wasm);

            if(!fs.existsSync(expect_file))
            {
                // enhanced workflow: If file doesn't exist yet print full diff
                var expect_file_for_diff = "/dev/null";
            }
            else
            {
                expect_file_for_diff = expect_file;
            }

            const result = spawnSync("git",
                [].concat(
                    "diff",
                    GIT_DIFF_FLAGS,
                    expect_file_for_diff,
                    actual_file
                ),
                { encoding: "utf8" });

            if(result.status)
            {
                console.log(result.stdout);
                console.log(result.stderr);

                if(process.argv.includes("--accept-all"))
                {
                    console.log(`Running: cp ${actual_file} ${expect_file}`);
                    fs.copyFileSync(actual_file, expect_file);
                }
                else
                {
                    const failure_message = `${name}.asm failed:
The IR compiler produced different code. If you believe this change is intentional,
verify the diff above and run the following command to accept the change:

    cp ${actual_file} ${expect_file}

When done, re-run this test to confirm that all expect-tests pass.

Hint: Use tests/expect/run.js --accept-all to accept all changes (use git diff to verify).
`;

                    console.log(failure_message);

                    process.exit(1);
                }
            }
            else
            {
                console.log("%s ok", name);
                assert(!result.stdout);
                assert(!result.stderr);
            }

            onfinished();
        });
}

function disassemble_wasm(wasm)
{
    // Need to make a small copy otherwise libwabt goes nuts trying to copy
    // the whole underlying buffer
    wasm = wasm.slice();

    try
    {
        // IR modules use SIMD (SSE/MMX lanes) and multi-value blocks.
        var module = libwabt.readWasm(wasm, { readDebugNames: false, simd: true, multi_value: true });
        module.generateNames();
        module.applyNames();
        return module.toText({ foldExprs: true, inlineExport: true });
    }
    catch(e)
    {
        console.error("Error while running libwabt: " + e.toString());
        console.error("Did you forget an ending hlt instruction?\n");
        throw e;
    }
    finally
    {
        module && module.destroy();
    }
}

run_all();
