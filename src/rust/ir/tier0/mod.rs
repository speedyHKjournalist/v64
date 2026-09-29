//! Tier-0: cheap page-granular compilation below the optimizing region tier.
//! See docs/ir-design.md. A page function serves every observed
//! entry of one code page and dispatches between its basic blocks without
//! returning to the CPU loop.
pub mod analysis;
pub mod emit;

use crate::ir::{
    backend::wasm::Artifact,
    lowering::CompileError,
    passes::PassStats,
    runtime::{
        compile::{CompileRequest, CompiledArtifact, ImmutableCodeSnapshot, Tier},
        entry::{CpuEntryKey, EntryContract},
    },
};

/// The pages a page function for `entries` covers: the primary page plus
/// the previous and/or next page when its code jumps or falls into them
/// (code continuing across a page boundary, as in the legacy JIT's
/// multi-page modules; calls into neighbors do not count). Returns (first
/// page linear, page count).
/// Pages one page function may cover (see compile_page).
pub const MAX_PAGES: usize = 6;

pub fn range(
    origin: &CompileRequest,
    primary: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
    code_page: impl Fn(u32) -> bool,
) -> (u32, u32) {
    let base = origin.linear.0 & !4095;
    if primary.bytes.len() != analysis::PAGE {
        return (base, 1);
    }
    let offsets: Vec<usize> = entries
        .iter()
        .map(|e| (e.linear.0 & 4095) as usize)
        .collect();
    let slots = analysis::Slots::new(vec![base], origin.cpu_entry().cs_base());
    let plan = analysis::analyze(&primary.bytes, slots, origin.default_32, &offsets, 0..4096);
    let into = |page: u32| plan.jumps.iter().any(|&t| t & !4095 == page);
    let before = into(base.wrapping_sub(4096)) && code_page(base.wrapping_sub(4096));
    let after = into(base.wrapping_add(4096)) && code_page(base.wrapping_add(4096));
    let first = if before { base.wrapping_sub(4096) } else { base };
    (first, 1 + before as u32 + after as u32)
}

/// Whether code of `entries` (in the first of the two pages of `snapshot`)
/// runs on through the second page into the page after it.
pub fn continues(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
) -> bool {
    let base = origin.linear.0 & !4095;
    if snapshot.bytes.len() != 2 * analysis::PAGE || snapshot.mappings[0].linear.0 != base {
        return false;
    }
    let offsets: Vec<usize> = entries
        .iter()
        .map(|e| (e.linear.0 & 4095) as usize)
        .collect();
    let slots = analysis::Slots::new(
        vec![base, base.wrapping_add(4096)],
        origin.cpu_entry().cs_base(),
    );
    let plan = analysis::analyze(&snapshot.bytes, slots, origin.default_32, &offsets, 0..4096);
    plan.jumps
        .iter()
        .any(|&t| t & !4095 == base.wrapping_add(8192))
}

/// Whether code from `entries` (linear addresses; those in the page of the
/// one-page `snapshot` count) runs on into the next page: a cluster function
/// taking the page as a partner then takes that one too, as a range would.
pub fn runs_on(
    snapshot: &ImmutableCodeSnapshot,
    cs_base: u32,
    default_32: bool,
    entries: &[u32],
) -> bool {
    let Some(base) = snapshot.mappings.first().map(|m| m.linear.0)
    else {
        return false;
    };
    let offsets: Vec<usize> = entries
        .iter()
        .filter(|&&e| e & !4095 == base)
        .map(|&e| (e & 4095) as usize)
        .collect();
    if snapshot.bytes.len() != analysis::PAGE || offsets.is_empty() {
        return false;
    }
    let slots = analysis::Slots::new(vec![base], cs_base);
    let plan = analysis::analyze(&snapshot.bytes, slots, default_32, &offsets, 0..4096);
    plan.jumps
        .iter()
        .any(|&t| t & !4095 == base.wrapping_add(4096))
}

/// Compile a page function for `entries` (primary first, all in one page)
/// from a snapshot of one to three consecutive pages containing it; `extra`
/// are further block starts (offsets from the snapshot's first page), such as
/// the targets that made neighbor pages part of it. Entries that do not start
/// a decodable block are not served.
pub fn compile_page(
    origin: &CompileRequest,
    snapshot: &ImmutableCodeSnapshot,
    entries: &[CpuEntryKey],
    // Block starts of the other pages (linear addresses), such as the entries
    // of pages this one calls often (a cluster function).
    extra: &[u32],
) -> Result<CompiledArtifact, CompileError> {
    let pages = snapshot.mappings.len();
    let Some(first) = snapshot.mappings.first().map(|m| m.linear)
    else {
        return Err(CompileError::InvalidIr("empty tier-0 snapshot".into()));
    };
    let primary = origin.linear.0 & !4095;
    let cs_base = origin.cpu_entry().cs_base();
    let slots = analysis::Slots::new(
        snapshot.mappings.iter().map(|m| m.linear.0).collect(),
        cs_base,
    );
    if !(1..=MAX_PAGES).contains(&pages)
        || snapshot.bytes.len() != pages * analysis::PAGE
        || slots.pages.len() != pages
        || snapshot.mappings.iter().enumerate().any(|(k, m)| {
            m.linear.0 != slots.pages[k]
                || !snapshot.dependencies.iter().any(|d| d.page == m.physical)
        })
        || slots.offset(primary).is_none()
    {
        return Err(CompileError::InvalidIr(
            "invalid tier-0 page snapshot".into(),
        ));
    }
    let base = first;
    if entries.is_empty()
        || entries.len() > 256
        || entries.iter().any(|e| {
            e.linear.0 & !4095 != primary
                || e.cs_base() != origin.cpu_entry().cs_base()
                || e.default_32 != origin.default_32
        })
    {
        return Err(CompileError::InvalidIr(
            "invalid tier-0 page entries".into(),
        ));
    }
    let offset_of = |e: &CpuEntryKey| slots.offset(e.linear.0).unwrap();
    let mut offsets: Vec<usize> = entries.iter().map(offset_of).collect();
    let own = offset_of(&entries[0]) & !(analysis::PAGE - 1);
    if pages > 1 {
        // The primary page's own branches into the other pages seed their
        // blocks, then the given entries of those pages.
        let alone = analysis::analyze(
            &snapshot.bytes[own..][..analysis::PAGE],
            analysis::Slots::new(vec![primary], cs_base),
            origin.default_32,
            &entries
                .iter()
                .map(|e| (e.linear.0 & 4095) as usize)
                .collect::<Vec<_>>(),
            0..analysis::PAGE,
        );
        offsets.extend(
            alone
                .external
                .iter()
                .chain(extra)
                .filter_map(|&t| slots.offset(t)),
        );
    }
    let plan = analysis::analyze(
        &snapshot.bytes,
        slots.clone(),
        origin.default_32,
        &offsets,
        own..own + analysis::PAGE,
    );
    let served: Vec<CpuEntryKey> = entries
        .iter()
        .copied()
        .filter(|e| plan.block_at[offset_of(e)].is_some())
        .collect();
    if served.is_empty() {
        return Err(CompileError::Unsupported("no decodable tier-0 entry"));
    }
    let seeded = analysis::seeds(&plan, &served.iter().map(offset_of).collect::<Vec<_>>());
    let page_seeds = served
        .iter()
        .zip(seeded)
        .filter(|(_, seed)| *seed)
        .map(|(e, _)| *e)
        .collect();
    // Specialize for the current state when it is flat 32-bit code of this
    // page's mode; the page function checks it on entry.
    let state = unsafe { *crate::cpu::global_pointers::state_flags };
    let flat =
        state.has_flat_segmentation() && state.ssize_32() && state.is_32() == origin.default_32;
    let mem8 = unsafe { crate::cpu::memory::mem8 as u32 };
    let hosts: Vec<u32> = snapshot
        .mappings
        .iter()
        .map(|m| mem8.wrapping_add(m.physical.0))
        .collect();
    let code = emit::emit_page(&plan, &served, flat, &hosts);
    super::runtime::tier0::note_compiled(
        code.instructions,
        code.templated,
        code.bytes.len(),
        pages,
    );
    let page_blocks = (0..pages)
        .map(|page| {
            std::array::from_fn(|word| {
                (0..64).fold(0u64, |bits, bit| {
                    bits | (plan.block_at[page * analysis::PAGE + word * 64 + bit].is_some() as u64)
                        << bit
                })
            })
        })
        .collect();
    Ok(CompiledArtifact {
        key: origin.key,
        tier: Tier::One,
        dependencies: snapshot.dependencies.clone(),
        code: Artifact {
            bytes: code.bytes,
            locals: code.locals,
            structured_cfg: false,
            structured_backedges: 0,
            structured_edges: 0,
            generic_dispatch_edges: 0,
            budget_batch_blocks: 0,
        },
        passes: PassStats::default(),
        mir_folds: 0,
        guest_bytes: snapshot.bytes.len(),
        mappings: snapshot.mappings.clone(),
        entry: EntryContract::Cpu(served[0]),
        fused_sources: vec![],
        fused_edges: vec![],
        alternate_entries: served[1..].to_vec(),
        source_origin: Some(base),
        page_blocks: Some(page_blocks),
        page_seeds,
    })
}
