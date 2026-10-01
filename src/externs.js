var global = {};
var process = { hrtime: function() {} };

/**
 * The bundle's own URL, defined by the output wrapper of libv86.mjs
 * (import.meta.url, which Closure cannot compile)
 * @type {string|undefined}
 */
var V86_BUNDLE_URL;

/**
 * @param {string} name
 * @param {function()} processor
 */
var registerProcessor = function(name, processor) {};

const sampleRate = 0;

var WabtModule = {
    readWasm: function(buf, opt) {},
    generateNames: function() {},
    applyNames: function() {},
    toText: function() {},
};
var cs = {
    Capstone: function() {},
    ARCH_X86: 0,
    MODE_16: 0,
    MODE_32: 0,
    disasm: { bytes: "", mnemonic: "", op_str: "", },
};

const Buffer = {
    allocUnsafe : function(length) {},
};
