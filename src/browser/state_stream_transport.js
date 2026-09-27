import { STATE_STREAM_CHUNK_SIZE, state_stream_source } from "../state.js";

// Exactly one request may be in flight. No RAM, whole snapshot, or unbounded
// queue is cloned across the CPU Worker boundary.
export function state_stream_client(port)
{
    let pending = null, sequence = 0;
    port.onmessage = event => {
        const message = event.data;
        if(!pending || message["id"] !== pending.id) return;
        const current = pending;
        pending = null;
        if(message["error"]) current.reject(new Error(message["error"]));
        else current.resolve(message["bytes"]);
    };
    port.onmessageerror = () => {
        if(pending) { pending.reject(new Error("Snapshot message could not be decoded")); pending = null; }
    };
    const request = (message, transfer) => new Promise((resolve, reject) => {
        if(pending) { reject(new Error("Concurrent snapshot chunk request")); return; }
        const id = ++sequence;
        pending = { id, resolve, reject };
        try { port.postMessage({ "id": id, ...message }, transfer); }
        catch(error) { pending = null; reject(error); }
    });
    return {
        "write": bytes => request({ "kind": "write", "bytes": bytes }, [bytes.buffer]),
        "read": (offset, length) => request({ "kind": "read", "offset": offset, "length": length }, []),
        "close": () => {
            if(pending) pending.reject(new Error("Snapshot stream closed"));
            pending = null;
            port.close();
        },
    };
}

export function state_stream_server(port, kind, value)
{
    const source = kind === "restore" ? state_stream_source(value) : null;
    let busy = false, closed = false;
    port.onmessage = async event => {
        const message = event.data, id = message["id"];
        try
        {
            if(busy || closed) throw new Error("Concurrent or closed snapshot stream");
            busy = true;
            if(kind === "save")
            {
                const bytes = message["bytes"];
                if(message["kind"] !== "write" || !(bytes instanceof Uint8Array) || bytes.length > STATE_STREAM_CHUNK_SIZE)
                    throw new Error("Invalid snapshot write request");
                await value(bytes);
                if(!closed) port.postMessage({ "id": id });
            }
            else
            {
                const offset = message["offset"], length = message["length"];
                if(message["kind"] !== "read" || !Number.isSafeInteger(offset) || offset < 0 ||
                    !Number.isInteger(length) || length < 0 || length > STATE_STREAM_CHUNK_SIZE || offset + length > source["size"])
                    throw new Error("Invalid snapshot read request");
                const result = await source["read"](offset, length);
                if(!(result instanceof Uint8Array) || result.length !== length) throw new Error("Short snapshot read");
                // User-owned views must not be detached by transport.
                const bytes = result.slice();
                if(!closed) port.postMessage({ "id": id, "bytes": bytes }, [bytes.buffer]);
            }
        }
        catch(error)
        {
            if(!closed) port.postMessage({ "id": id, "error": String(error?.message || error) });
        }
        finally { busy = false; }
    };
    return { "size": source?.["size"] || 0, "close": () => { closed = true; port.close(); } };
}
