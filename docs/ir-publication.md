# Transactional asynchronous JIT publication foundation

> Historical: this describes the legacy JIT's publication bridge, which has been
> removed from the core together with the legacy code generator (IR is the only
> compiler), as were `jit-publication-tests` and `jit-capacity-tests`. IR publication, failure handling and
> table capacity are covered by `make ir-cache-tests`
> (`tests/ir/differential/cache.mjs`) and `make ir-auto-tests`.

The actual Rust-to-JS JIT publication bridge now validates a task before installing
its function in the Wasm table and reclaims reservations after browser failures.
This hardens the shared online infrastructure while production still emits legacy
JIT modules. Experimental IR artifacts are not installed through it yet.

Each generated module receives a nonzero, monotonically increasing u64 ticket,
transmitted as two exact u32 words. The serial survives cache clears, restore and
`rust_init` within the same Wasm instance; exhaustion stops new compilation rather
than wrapping. A ticket uniquely identifies a reservation even if slot, physical
entry and cached mode flags are reused. Public validation/finish/failure callbacks
compare full-width slot/flags fields before narrowing to internal types.

JS copies the emitted bytes immediately. The asynchronous continuation captures
its Wasm wrapper, exports and table identities. It rejects a replaced instance,
then calls `codegen_finalize_validate` with ticket/slot/start/flags before any
non-null table write. The existing `CompilingWritten` dependency notification
rejects code changed during compilation. Only a validated current task may enter
`codegen_finalize_finished`; publication metadata becomes visible after installation.
Duplicate or mismatched callbacks cannot consume or clear a newer reservation.
Missing function exports, actual Wasm validation rejection, instantiation errors
and table installation errors use `codegen_finalize_failed` to release only the
matching task. The profiling wrapper forwards both words and does not attribute
an old callback to a newer task in the same slot.

All completion paths run after the generating Rust frame has returned, including
synchronous browser instantiation errors. Deferring those errors to a microtask
avoids reentering the JIT mutex held by the generator. Validation, table installation
and metadata publication then run without yielding on the owning JS thread.

Cache clear/reset/restore immediately retires the pending reservation, so a new
job can reuse its slot while the old browser promise is still outstanding. Old
results are rejected by the ticket check. Ordinary writes keep their existing
pending-write state until completion and never briefly install invalid code.
This uses the existing dependency notification paths; it is not a claim that the
full IR physical-page/version/alias/mode dependency graph is implemented.

Failures are counted and remembered for the physical root, cached state flags and
all code dependencies. Unchanged failed code is not repeatedly instantiated on
hot entries. A write to any dependency or a cache clear removes that suppression.
The FIFO retains at most 128 failed tasks, bounding metadata; evicted records may
be retried. `jit_publication_stat` exposes failure/rejection counts and remembered
failure count without enabling profiling. Existing compiled modules survive a
failed replacement; only its reserved slot is released.

`make jit-publication-tests` runs real CPU/Wasm integration in debug and release,
controlling 159 browser instantiations in each build. It checks written code,
cache cancellation with immediate same-slot/same-address reuse, stale/duplicate/
forged callbacks (including high-bit slot/flags aliases), actual compiled execution,
asynchronous and synchronous browser/table/missing-export failures, bounded retry suppression, secondary-page
invalidation, snapshot restore, instance replacement, immutable byte copies and
u64 low-word wrap/exhaustion. The cross-page fixture explicitly disables one-page
Tier 1 selection and warms the secondary entry so both pages are dependencies.
Failed replacement is also checked against an already published module: its
function is retained and actual JIT execution counters prove it still runs.
`jit_test_publication_serial` and release force-compilation access exist only in
the dedicated `jit-invariants` test build. Normal release does not export them.
The existing 899-slot pressure/eviction/alias/SMC/restore test also passes, and the
performance recorder has ticket-forwarding and stale-measurement checks.

JS and CPU Wasm artifacts must be rebuilt together after this bridge ABI change.
It does not alter guest snapshot formats or select IR for production. Full IR
publication keys/artifacts, cache/link ownership, quiescent reclamation, mode
specialization, cancellation scheduling, comprehensive write-path auditing and
IR Tier integration remain required by IR-12 and the overall implementation plan.
