#!/usr/bin/env node
// W1 in a browser (docs/acpi-x86-64-multicore-plan.zh-CN.md): headless
// Chrome loads tests/parallel/browser_test.html from a local server. With
// COOP/COEP headers the page is cross-origin isolated and the cores run in
// vCPU module workers (source tree and bundles); without them "auto" keeps
// the cores cooperative and says why. BROWSER_CHROME selects the browser.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const chrome = process.env.BROWSER_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const assembled = spawnSync("nasm", ["-f", "bin", "-o", root + "build/parallel-litmus.bin", root + "tests/parallel/litmus.asm"], { encoding: "utf8" });
if(assembled.status !== 0) throw new Error(assembled.stderr);

function run(query, isolated)
{
    return new Promise((resolve, reject) => {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-parallel-"));
        let browser, timer;
        const server = http.createServer((req, res) => {
            if(req.method === "POST" && req.url === "/__result")
            {
                let body = "";
                req.on("data", data => { body += data; });
                req.on("end", () => { res.end("OK"); finish(body); });
                return;
            }
            const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
            if(!file.startsWith(root)) { res.writeHead(403).end(); return; }
            fs.readFile(file, (error, data) => {
                if(error) { res.writeHead(404).end(); return; }
                if(isolated)
                {
                    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                }
                res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" :
                    /\.(js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
                if(file.endsWith(".html")) data = Buffer.concat([data, Buffer.from(`<script>
                    new MutationObserver((_, observer) => {
                        const text = document.getElementById("result").textContent;
                        if(!/^(PASS|FAIL)/.test(text)) return;
                        observer.disconnect();
                        fetch("/__result", { method: "POST", body: text + "\\n" + document.getElementById("log").textContent });
                    }).observe(document.body, { subtree: true, childList: true, characterData: true });
                </script>`)]);
                res.end(data);
            });
        });
        const finish = text => {
            clearTimeout(timer);
            browser?.kill();
            server.close();
            // (Chrome may still be writing its profile)
            try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch(e) { /* left in the temporary directory */ }
            (text.startsWith("PASS") ? resolve : reject)(text);
        };
        server.listen(0, "127.0.0.1", () => {
            const url = `http://127.0.0.1:${server.address().port}/tests/parallel/browser_test.html?${query}`;
            browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
            browser.on("error", error => finish("FAIL " + error));
            timer = setTimeout(() => finish("FAIL timeout"), 240000);
        });
    });
}

for(const [query, isolated] of [["expect=parallel", true], ["expect=parallel&build=bundle", true],
    ["expect=cooperative&cores=2&rounds=1000", false]])
{
    const result = await run(query, isolated);
    console.log(`${query}${isolated ? " (COOP/COEP)" : " (not isolated)"}: ${result.split("\n")[0]}`);
}
console.log("parallel browser tests passed");
