use crate::ir::{hir::Region, ids::BlockId};
#[derive(Debug)]
pub struct Cfg {
    pub predecessors: Vec<Vec<BlockId>>,
    pub reachable: Vec<bool>,
    /// Row `b` holds the blocks dominating `b`, one bit per block.
    dominators: Vec<Vec<u64>>,
}
impl Cfg {
    /// Whether block `a`'s dominator set contains `b` (b dominates a).
    #[inline]
    pub fn dominates(&self, a: usize, b: usize) -> bool {
        self.dominators[a][b / 64] & (1u64 << (b % 64)) != 0
    }
    /// Number of blocks dominating `b` (strict dominators have fewer).
    pub fn dominator_count(&self, b: usize) -> u32 {
        self.dominators[b].iter().map(|w| w.count_ones()).sum()
    }
    /// Predecessors and reachability only; no dominance.
    pub fn reachability(region: &Region) -> Result<(Vec<Vec<BlockId>>, Vec<bool>), &'static str> {
        let n = region.blocks.len();
        let mut predecessors = vec![vec![]; n];
        let mut reachable = vec![false; n];
        for (i, block) in region.blocks.iter().enumerate() {
            let term = block.terminator.as_ref().ok_or("unterminated block")?;
            for edge in term.edges() {
                let pred = predecessors
                    .get_mut(edge.target.index())
                    .ok_or("invalid edge target")?;
                pred.push(BlockId(i as u32));
            }
        }
        if region.entries.is_empty() {
            return Err("region has no entry");
        }
        let mut queue = region.entries.clone();
        while let Some(block) = queue.pop() {
            let seen = reachable.get_mut(block.index()).ok_or("invalid entry")?;
            if *seen {
                continue;
            }
            *seen = true;
            queue.extend(
                region.blocks[block.index()]
                    .terminator
                    .as_ref()
                    .unwrap()
                    .edges()
                    .iter()
                    .map(|e| e.target),
            );
        }
        Ok((predecessors, reachable))
    }
    pub fn compute(region: &Region) -> Result<Self, &'static str> {
        let (predecessors, reachable) = Self::reachability(region)?;
        let n = region.blocks.len();
        let words = n.div_ceil(64).max(1);
        let mut entry = vec![false; n];
        for e in &region.entries {
            entry[e.index()] = true;
        }
        // Synthetic root reaches every entry, even when it also has a backedge.
        // Entries and unreachable blocks dominate only themselves; every other
        // block starts at the full set and is refined in reverse postorder.
        let mut dominators = vec![vec![u64::MAX; words]; n];
        for i in 0..n {
            if n % 64 != 0 {
                dominators[i][words - 1] = (1u64 << (n % 64)) - 1;
            }
            if !reachable[i] || entry[i] {
                dominators[i].fill(0);
                dominators[i][i / 64] = 1u64 << (i % 64);
            }
        }
        let order = reverse_postorder(region, &reachable);
        let mut next = vec![0u64; words];
        loop {
            let mut changed = false;
            for &i in &order {
                if entry[i] {
                    continue;
                }
                next.fill(u64::MAX);
                for pred in predecessors[i].iter().filter(|p| reachable[p.index()]) {
                    for (w, d) in next.iter_mut().zip(&dominators[pred.index()]) {
                        *w &= d;
                    }
                }
                if n % 64 != 0 {
                    next[words - 1] &= (1u64 << (n % 64)) - 1;
                }
                next[i / 64] |= 1u64 << (i % 64);
                if next != dominators[i] {
                    dominators[i].copy_from_slice(&next);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        Ok(Self {
            predecessors,
            reachable,
            dominators,
        })
    }
}
fn reverse_postorder(region: &Region, reachable: &[bool]) -> Vec<usize> {
    let n = region.blocks.len();
    let mut state = vec![0u8; n];
    let mut post = Vec::with_capacity(n);
    for entry in &region.entries {
        if state[entry.index()] != 0 {
            continue;
        }
        let mut stack = vec![(entry.index(), 0usize)];
        state[entry.index()] = 1;
        while let Some(&mut (b, ref mut next)) = stack.last_mut() {
            let edges = region.blocks[b].terminator.as_ref().unwrap().edges();
            if let Some(edge) = edges.get(*next) {
                *next += 1;
                let t = edge.target.index();
                if state[t] == 0 {
                    state[t] = 1;
                    stack.push((t, 0));
                }
            }
            else {
                state[b] = 2;
                post.push(b);
                stack.pop();
            }
        }
    }
    post.reverse();
    post.retain(|&b| reachable[b]);
    post
}
