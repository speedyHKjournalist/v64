// The graphics proxy as one of v86's device plugins (the graphics_proxy
// option, docs/graphics-proxy-plugin-plan.md). Its virtio device
// (v86gl_device.js) runs next to the CPU; this side renders, and the two talk
// over a channel. Load after v86gl_device.js, v86_network_bridge.js and the
// executors.
(function(global) {
    "use strict";

    /* Stop an executor's work before it is dropped; its device goes separately */
    async function retireExecutors(executors) {
        await Promise.allSettled(executors.flatMap(executor => [executor.readyPromise,
            executor.checkpointIdle ? executor.checkpointIdle() :
                executor.idle ? executor.idle() : executor.work]));
        for (const executor of executors) {
            executor.destroyed = true;
            if (executor.shaderCacheSaveTimer !== null && executor.shaderCacheSaveTimer !== undefined) {
                global.clearTimeout(executor.shaderCacheSaveTimer);
                executor.shaderCacheSaveTimer = null;
                await executor.flushPersistentShaderCache();
            }
            if (executor.shaderWorker) executor.shaderWorker.terminate();
            if (executor.shaderWorkerRequests) executor.shaderWorkerRequests.clear();
            if (executor.pending) executor.pending.length = 0;
        }
    }

    function reportUnavailable(options, error) {
        if (typeof options.onError === "function") options.onError(error);
        else console.error("[v86gl] graphics unavailable; VGA remains active", error);
    }

    /*
     * One canvas (docs/display-design.md): a compositor
     * takes over the screen canvas and shows each API's output as a window
     * layer over the guest desktop.
     *
     * options.screenCanvas is the emulator's screen canvas; options.screenBackend
     * ({ set, fallback }) hands the screen's drawing to the compositor, or back
     * to the 2D canvas if WebGPU cannot start.
     */
    function createGraphicsBridge(emulator, options) {
        options = options || {};
        const screen = options.screenCanvas;
        const backend = options.screenBackend;
        if (!screen || !backend)
            throw new Error("the graphics adapter draws through the emulator's screen canvas");
        const compositor = new global.V86WebGPUCompositor(screen);
        // before the bridge: installing an executor starts its initialization
        compositor.useHost(global.V86GPUHost.acquire(screen, options.hostOptions));
        const bridge = global.installV86GLNetworkBridge(emulator, null, { ...options, compositor });
        bridge.compositor = compositor;
        bridge.screenChanged = () => {
            if (bridge.destroyed) return;
            if (options.isGraphical && !options.isGraphical()) {
                bridge.hideLayers(true);
                bridge.d3d9SwapChainSurfaces.clear();
            }
            bridge.placeLayers();
        };
        const executors = () => [bridge.glExecutor, bridge.d3d8Executor, bridge.d3d9Executor].filter(Boolean);
        let screenTaken = false;
        const attachHost = async () => {
            await compositor.attach(global.V86GPUHost.acquire(screen, options.hostOptions));
            if (!screenTaken) {
                screenTaken = true;
                backend.set(compositor);
            }
        };
        const initializeExecutors = async () => {
            try {
                await Promise.all(executors().map(executor => executor.initialize && executor.initialize()));
            } catch (error) {
                bridge.failed = error;
                bridge.hideLayers(true);
                reportUnavailable(options, error);
            }
        };
        const initialize = async () => {
            try {
                await attachHost();
            } catch (error) {
                bridge.failed = error;
                if (!screenTaken) {
                    // No WebGPU: the screen goes back to its 2D canvas
                    screenTaken = true;
                    backend.fallback();
                }
                reportUnavailable(options, error);
                return;
            }
            await initializeExecutors();
        };
        const disposeExecutors = async () => {
            await retireExecutors(executors());
            for (const handle of Array.from(bridge.d3d9SwapChainCanvases.keys()))
                bridge.removeD3D9SwapChain(handle);
            bridge.glExecutor = bridge.d3d8Executor = bridge.d3d9Executor = null;
        };
        // A fresh device: nothing of the old timeline's GPU objects survives. The compositor moves with it and
        // the screen is drawn again from the device.
        const replaceDevice = async () => {
            const old = compositor.host;
            compositor.detach();
            if (old) {
                if (old.recovering) await old.recovering.catch(() => {});
                old.destroyed = true;
                old.deviceLostHandlers.clear();
                if (old.device && old.device.destroy) old.device.destroy();
            }
            global.V86GPUHost.reset(screen);
            compositor.useHost(global.V86GPUHost.acquire(screen, options.hostOptions));
        };
        const resetExecutors = async (restoring) => {
            ++bridge.memoryGeneration;
            bridge.suspended = true;
            bridge.restoringState = true;
            bridge.hideLayers(true);
            await disposeExecutors();
            await bridge.resetJournal();
            bridge.legacyCheckpoint = new Uint8Array(0);
            bridge.glJournal = [];
            bridge.glJournalBytes = 0;
            bridge.glJournalOverflow = false;
            if (!restoring) bridge.pendingBatches = [];
            bridge.d3d8OwnerSessionKey = bridge.d3d9OwnerSessionKey = null;
            bridge.glSurface = bridge.emptySurface();
            bridge.d3d8Surface = bridge.emptySurface();
            bridge.d3d9Surface = bridge.emptySurface();
            bridge.failed = null;
            await replaceDevice();
            bridge.installGLExecutor();
            bridge.installD3D8Executor();
            bridge.installD3D9Executor();
            try {
                await attachHost();
            } catch (error) {
                bridge.failed = error;
                reportUnavailable(options, error);
            }
            bridge.ready = bridge.failed ? Promise.resolve() : initializeExecutors();
            await bridge.ready;
            bridge.restoringState = !!restoring;
            bridge.suspended = false;
            bridge.hideLayers(true);
        };
        bridge.reset = () => resetExecutors(false);
        bridge.resetForStateRestore = () => resetExecutors(true);
        bridge.makeScreenshot = () => compositor.attached ? compositor.screenshotImage() : null;
        let cleanup;
        bridge.destroy = () => {
            if (cleanup) return cleanup;
            bridge.destroyed = true;
            ++bridge.memoryGeneration;
            bridge.hideLayers(true);
            cleanup = (async () => {
                await bridge.pendingRestore.catch(() => {});
                await disposeExecutors();
                bridge.pendingBatches = [];
                bridge.glJournal = [];
                await bridge.graphicsJournal.destroy();
                bridge.preparedCheckpoint = null;
                bridge.graphicsJournalBytes = 0;
                bridge.legacyCheckpoint = new Uint8Array(0);
                // The compositor keeps drawing the screen for as long as it exists
            })();
            return cleanup;
        };
        bridge.hideLayers(true);
        bridge.ready = initialize();
        return bridge;
    }

    /*
     * What graphics_proxy: true (or an options object) makes: the device for
     * v86's virtio_devices, and the hooks v86 calls around saves, restores,
     * resets, screen changes and screenshots. The renderer starts in start(),
     * when v86 hands over the screen and this side's end of the channel.
     */
    function V86GraphicsProxy(options) {
        options = { ...(options || {}) };
        const createDevice = global.V86VirtioDeviceFactories && global.V86VirtioDeviceFactories.v86gl;
        if (typeof createDevice !== "function")
            throw new Error("graphics_proxy: v86gl_device.js is missing; load the whole libv86-webgpu.js");
        let bridge = null;
        let channel = null;
        let available = false;
        // Bumped whenever the guest's timeline is replaced: readbacks of
        // batches from before are dropped
        let epoch = 0;

        const setAvailable = value => {
            if (!channel || available === value) return;
            available = value;
            channel.post({ type: "available", value });
        };

        const onBatch = message => {
            const batchEpoch = epoch;
            const generation = message.generation;
            bridge.pushPCIBatch({
                frameId: message.frameId,
                flags: message.flags,
                commandCount: message.commandCount,
                bytes: message.bytes,
                descAddr: message.descAddr,
                descLen: message.descLen,
                batchAddr: message.batchAddr,
                responseBase: message.responseBase,
                submitCount: message.submitCount,
                handled: false,
                isMemoryValid: () => batchEpoch === epoch && !bridge.destroyed,
                writeGuestMemory: (offset, bytes) => {
                    if (batchEpoch !== epoch) return;
                    const data = channel.remote ? new Uint8Array(bytes).slice() : bytes;
                    channel.post({ type: "write", generation, offset, bytes: data },
                        channel.remote ? [data.buffer] : undefined);
                },
            });
            channel.post({ type: "done", id: message.id });
        };

        const plugin = {
            name: "v86gl",
            // The compositor draws the whole screen (docs/display-design.md)
            wants_screen: true,
            // For diagnostics (graphics_performance.js, performance_recorder.js)
            bridge: null,
            create_device: deviceChannel => createDevice(deviceChannel),
            /*
             * context.screen: { canvas, set_backend, fallback, is_graphical };
             * context.channel: this side's end. Returns when the renderer is up
             * (or has failed and handed the screen back).
             */
            start(context) {
                const screen = context.screen;
                channel = context.channel;
                bridge = plugin.bridge = createGraphicsBridge(context.emulator, {
                    ...options,
                    screenCanvas: screen.canvas,
                    screenBackend: { set: screen.set_backend, fallback: screen.fallback },
                    isGraphical: screen.is_graphical,
                });
                channel.listen(message => {
                    if (message.type === "batch") onBatch(message);
                });
                setAvailable(true);
                return bridge.ready.then(() => setAvailable(!bridge.failed));
            },
            screen_changed() {
                bridge.screenChanged();
            },
            async prepare_save() {
                await bridge.prepareSaveState();
                return bridge.serializeCheckpoint();
            },
            release_save() {
                bridge.releaseCheckpoint();
            },
            async before_restore() {
                ++epoch;
                bridge.beginStateRestore();
                await bridge.waitForIdle(false, true);
            },
            async after_restore(checkpoint) {
                bridge.onPCIStateRestored(checkpoint);
                await bridge.finishStateRestore();
            },
            cancel_restore() {
                bridge.cancelStateRestore();
            },
            async reset() {
                ++epoch;
                await bridge.reset();
                setAvailable(!bridge.failed);
            },
            async destroy() {
                if (!bridge) return;
                setAvailable(false);
                await bridge.destroy();
            },
            screenshot() {
                return bridge ? bridge.makeScreenshot() : null;
            },
        };
        return plugin;
    }

    global.V86GraphicsProxy = V86GraphicsProxy;
    if (typeof module !== "undefined" && module.exports)
        module.exports = { V86GraphicsProxy, createGraphicsBridge };
})(typeof globalThis !== "undefined" ? globalThis : this);
