//! Explicit SSA copy/identity propagation for IR-10.
//!
//! This is intentionally separate from literal folding so it can be toggled,
//! counted and differentially tested on its own. The underlying bounded planner
//! is shared with scalar canonicalization and rewrites StateMaps/CFG uses
//! atomically.
use super::scalar;
use crate::ir::hir::Region;

pub const DEFAULT_WORK_LIMIT: usize = scalar::DEFAULT_WORK_LIMIT;

#[derive(Default, Debug, Clone, Copy, Eq, PartialEq)]
pub struct Stats {
    pub propagated: usize,
}

pub fn run(region: &mut Region, work_limit: usize) -> Result<Stats, String> {
    let stats = scalar::run_copies(region, work_limit)?;
    Ok(Stats {
        propagated: stats.aliases,
    })
}
