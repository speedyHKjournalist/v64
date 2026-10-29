// The error-scope half of a GPUDevice, for the fake devices: a validation
// error goes to the innermost open validation scope, or, with none open, to
// the uncapturederror listeners.
"use strict";

function errorScopes() {
    const scopes = [];
    const listeners = [];
    return {
        pushErrorScope(filter) { scopes.push({ filter, error: null }); },
        popErrorScope() {
            if (!scopes.length) return Promise.reject(new Error("popErrorScope without an open scope"));
            return Promise.resolve(scopes.pop().error);
        },
        addEventListener(type, listener) {
            if (type === "uncapturederror") listeners.push(listener);
        },
        // What a real device does with a validation error
        rejectWith(message) {
            const error = { message };
            for (let i = scopes.length - 1; i >= 0; --i) {
                if (scopes[i].filter !== "validation") continue;
                if (!scopes[i].error) scopes[i].error = error;
                return;
            }
            for (const listener of listeners) listener({ error, preventDefault() {} });
        },
        openScopes: () => scopes.length,
    };
}

module.exports = { errorScopes };
