#!/usr/bin/env node
// Build build/x64-linux/gpu-repo.tar: a local Alpine 3.24 x86_64 package
// repository with Mesa and the GPU test programs, for the x86_64 Linux guest
// tests of the display adapters (tests/x64/linux_gpu.mjs). The repository
// keeps Alpine's own signed APKINDEX, so the guest installs from it with
//
//     tar -xf /dev/sda -C /mnt/repo
//     apk add --no-network --repository /mnt/repo/main --repository /mnt/repo/community <packages>
//
//     node tools/alpine_gpu_repo.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build/x64-linux/gpu-repo");
const MIRROR = "https://dl-cdn.alpinelinux.org/alpine/v3.24";
const REPOS = ["main", "community"];

export const PACKAGES = [
    "mesa-dri-gallium", "mesa-gbm", "mesa-egl", "mesa-gl", "mesa-gles",
    "kmscube", "mesa-demos", "mesa-utils", "libdrm-tests",
    "weston", "weston-backend-drm", "weston-shell-desktop", "weston-terminal", "weston-clients",
    "seatd", "vulkan-tools",
];

/** Extract the APKINDEX member of a gzipped tar */
function apkindex(tar_gz)
{
    const tar = zlib.gunzipSync(tar_gz);
    for(let offset = 0; offset + 512 <= tar.length;)
    {
        const name = tar.subarray(offset, offset + 100).toString("latin1").replace(/\0.*$/s, "");
        const size = parseInt(tar.subarray(offset + 124, offset + 136).toString("latin1"), 8) || 0;
        if(name === "APKINDEX") return tar.subarray(offset + 512, offset + 512 + size).toString("utf8");
        offset += 512 + Math.ceil(size / 512) * 512;
        if(!name) break;
    }
    throw new Error("no APKINDEX in the index archive");
}

async function fetch_bytes(location)
{
    const response = await fetch(location);
    if(!response.ok) throw new Error(location + ": HTTP " + response.status);
    return Buffer.from(await response.arrayBuffer());
}

const packages = new Map();     // name -> { repo, version, deps, provides }
const providers = new Map();    // provided name -> package name

for(const repo of REPOS)
{
    const directory = path.join(OUT, repo, "x86_64");
    fs.mkdirSync(directory, { recursive: true });
    const index_path = path.join(directory, "APKINDEX.tar.gz");
    if(!fs.existsSync(index_path)) fs.writeFileSync(index_path, await fetch_bytes(`${MIRROR}/${repo}/x86_64/APKINDEX.tar.gz`));
    for(const record of apkindex(fs.readFileSync(index_path)).split("\n\n"))
    {
        const fields = {};
        for(const line of record.split("\n"))
        {
            if(line[1] === ":") fields[line[0]] = line.slice(2);
        }
        if(!fields.P || packages.has(fields.P)) continue;
        const entry = { repo, version: fields.V, deps: (fields.D || "").split(" ").filter(Boolean), provides: [] };
        packages.set(fields.P, entry);
        for(const provided of (fields.p || "").split(" ").filter(Boolean))
        {
            const name = provided.replace(/[<>=~].*$/, "");
            if(!providers.has(name)) providers.set(name, fields.P);
        }
    }
}

const wanted = new Set();
const missing = [];
function want(dependency)
{
    if(dependency.startsWith("!")) return;
    const name = dependency.replace(/[<>=~].*$/, "");
    const package_name = packages.has(name) ? name : providers.get(name);
    if(!package_name) { missing.push(dependency); return; }
    if(wanted.has(package_name)) return;
    wanted.add(package_name);
    for(const next of packages.get(package_name).deps) want(next);
}
for(const name of PACKAGES)
{
    if(!packages.has(name)) throw new Error("no package " + name + " in Alpine 3.24");
    want(name);
}

let bytes = 0;
for(const name of [...wanted].sort())
{
    const { repo, version } = packages.get(name);
    const file = path.join(OUT, repo, "x86_64", `${name}-${version}.apk`);
    if(!fs.existsSync(file)) fs.writeFileSync(file, await fetch_bytes(`${MIRROR}/${repo}/x86_64/${name}-${version}.apk`));
    bytes += fs.statSync(file).size;
}
console.log(`${wanted.size} packages, ${(bytes / 1048576).toFixed(1)} MiB` +
    (missing.length ? `; unresolved (provided by the base system): ${[...new Set(missing)].join(" ")}` : ""));

// A ustar image on the IDE disk (as for tests/x64/linux_boot.mjs's probes):
// the guest unpacks it with `tar -xf /dev/sda`, names intact
const image = path.join(ROOT, "build/x64-linux/gpu-repo.tar");
const result = spawnSync("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
    "-cf", image, "-C", OUT, ...REPOS], { encoding: "utf8" });
if(result.status !== 0) throw new Error("bsdtar: " + result.stderr);
console.log("Wrote " + path.relative(ROOT, image));
