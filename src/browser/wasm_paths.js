// Preserve URL query/fragment and custom core names when selecting a portable build.
export function wasm_fallback_path(primary)
{
    return primary.replace(/(?:-fallback)?\.wasm(?=[?#]|$)/, "-fallback.wasm");
}
