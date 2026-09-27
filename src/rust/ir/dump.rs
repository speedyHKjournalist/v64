use super::hir::Region;
use std::fmt::Write;
pub fn text(region: &Region) -> String {
    let mut out = format!("entries {:?}\n", region.entries);
    for (b, block) in region.blocks.iter().enumerate() {
        writeln!(
            &mut out,
            "b{b}({:?}): recovery={:?}",
            block.params, block.entry_state
        )
        .unwrap();
        for id in &block.instructions {
            let inst = &region.instructions[id.index()];
            writeln!(
                &mut out,
                "  {:?} = {:?} {:?} state={:?} trap_after_fault={} unmasked_word_store={}",
                inst.results,
                inst.op,
                inst.args,
                (inst.state, inst.commit),
                inst.trap_after_fault,
                inst.unmasked_word_store
            )
            .unwrap();
        }
        writeln!(&mut out, "  {:?}", block.terminator).unwrap();
    }
    for (i, state) in region.states.iter().enumerate() {
        writeln!(&mut out, "state{i}: {state:?}").unwrap();
    }
    out
}

/// Shows the selected physical action and cold-edge ABI alongside its recovery map.
pub fn mir(region: &super::mir::MirRegion) -> String {
    let mut out = format!(
        "machine values {:?}\nlocals {:?}\n",
        region.value_types, region.allocation.local_types
    );
    writeln!(
        &mut out,
        "lowered entries {:?} dynamic_counts={}",
        region.control.entries, region.control.dynamic_counts
    )
    .unwrap();
    out.push_str("lowered plans:\n");
    for (b, block) in region.control.blocks.iter().enumerate() {
        writeln!(
            &mut out,
            "b{b}: recovery={:?} budget_cost={}",
            block.recovery, block.budget_cost
        )
        .unwrap();
        for id in &block.instructions {
            if let Some(proof) = region.ram_forwarding(*id) {
                writeln!(&mut out, "  i{}: guarded_ram_read={proof:?}", id.0).unwrap();
            }
            if let Some(plan) = &region.control.polls[id.index()] {
                writeln!(&mut out, "  i{}: {plan:#?}", id.0).unwrap();
            }
            else if let Some(plan) = &region.memory[id.index()] {
                writeln!(&mut out, "  i{}: {plan:#?}", id.0).unwrap();
            }
            else if let Some(plan) = &region.effects[id.index()] {
                writeln!(&mut out, "  i{}: {plan:#?}", id.0).unwrap();
            }
            else if let Some(plan) = &region.calls[id.index()] {
                writeln!(&mut out, "  i{}: {plan:#?}", id.0).unwrap();
            }
            else if let Some(plan) = &region.values[id.index()] {
                writeln!(&mut out, "  i{}: {plan:#?}", id.0).unwrap();
            }
        }
        writeln!(&mut out, "  {:?}", block.terminator).unwrap();
    }
    for (id, state) in region.states.iter().enumerate() {
        writeln!(&mut out, "materialize state{id}: {state:#?}").unwrap();
    }
    out
}
