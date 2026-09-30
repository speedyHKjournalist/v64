// Optional browser adapter. Load after v86_network_bridge.js and the executors.
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
    function installV86GLGraphicsAdapter(emulator, options) {
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
            emulator.remove_listener("v86gl-pci-frame", bridge.frameListener);
            emulator.remove_listener("emulator-loaded", bridge.loadedListener);
            cleanup = (async () => {
                await bridge.pendingRestore.catch(() => {});
                await disposeExecutors();
                bridge.pendingBatches = [];
                bridge.glJournal = [];
                await bridge.graphicsJournal.destroy();
                bridge.preparedCheckpoint = null;
                bridge.graphicsJournalBytes = 0;
                bridge.legacyCheckpoint = new Uint8Array(0);
                const pci = bridge.pciStateDevice;
                if (pci && pci.__v86glStateBridge === bridge) {
                    pci.get_state = bridge.originalGetState;
                    pci.set_state = bridge.originalSetState;
                    delete pci.__v86glStateBridge;
                }
                // The compositor keeps drawing the screen for as long as it exists
            })();
            return cleanup;
        };
        bridge.hideLayers(true);
        bridge.ready = initialize();
        return bridge;
    }

    global.installV86GLGraphicsAdapter = installV86GLGraphicsAdapter;
    if (typeof module !== "undefined" && module.exports)
        module.exports = { installV86GLGraphicsAdapter };
})(typeof globalThis !== "undefined" ? globalThis : this);
