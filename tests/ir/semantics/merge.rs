use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        region::lift_cpu_cfg_uncoalesced as lift_cpu_cfg,
    },
    hir::{Op, Terminator},
    ids::StateId,
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
fn region(bytes: &[u8]) -> crate::ir::hir::Region {
    lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8).unwrap()
}
fn only_merge() -> PassConfig {
    PassConfig {
        debug: Default::default(),
        disabled: 0,
        prune: false,
        merge: true,
        phis: false,
        copy: false,
        flags: false,
        state_sync: false,
        helper_state: false,
        fold: false,
        gvn: false,
        dce: false,
        rounds: 1,
    }
}
#[test]
fn straight_blocks_merge_with_precise_polls() {
    for bytes in [
        vec![0x40, 0x49, 0x75, 0xFC],
        vec![0xE3, 3, 0x40, 0xEB, 1, 0x48, 0x90],
        vec![0xEB, 2, 0x40, 0x90, 0x49, 0x75, 0xFB],
        vec![0x40, 0x89, 0x06],
    ] {
        let mut r = region(&bytes);
        let before = r.blocks.len();
        let old_boundaries: Vec<_> = r.blocks.iter().filter_map(|b| b.entry_state).collect();
        let stats = run(&mut r, only_merge()).unwrap();
        assert!(stats.merged > 0);
        assert_eq!(r.blocks.len() + stats.merged, before);
        let mut new_boundaries: Vec<_> = r.blocks.iter().filter_map(|b| b.entry_state).collect();
        for b in &r.blocks {
            for i in &b.instructions {
                let inst = &r.instructions[i.index()];
                if inst.op == Op::PollBudget {
                    new_boundaries.push(inst.state.unwrap());
                }
            }
        }
        new_boundaries.sort();
        let mut expected = old_boundaries;
        expected.sort();
        assert_eq!(
            new_boundaries, expected,
            "every removed recovery point survives once"
        );
        verify(&r).unwrap();
        let mir = lower(&r).unwrap();
        assert_eq!(mir.control.polls.iter().flatten().count(), stats.merged);
        assert!(emit_cpu(&mir, 1).is_ok());
        assert_eq!(run(&mut r, only_merge()).unwrap().merged, 0, "fixed point");
    }
    let mut r = region(&[0xEB, 0xFE]);
    assert_eq!(
        run(&mut r, only_merge()).unwrap().merged,
        0,
        "retain loop header with multiple predecessors"
    );
    let mut r = region(&[0x40, 0x49]);
    assert_eq!(
        run(
            &mut r,
            PassConfig {
                prune: false,
                merge: false,
                ..only_merge()
            }
        )
        .unwrap()
        .merged,
        0
    );
    assert_eq!(r.blocks.len(), 3);
}
#[test]
fn poll_plans_reject_stale_states_and_costs() {
    let mut r = region(&[0x40, 0x49]);
    run(&mut r, only_merge()).unwrap();
    assert_eq!(r.blocks.len(), 1);
    let poll = *r.blocks[0]
        .instructions
        .iter()
        .find(|id| r.instructions[id.index()].op == Op::PollBudget)
        .unwrap();
    for mutation in 0..4 {
        let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
        match mutation {
            0 => mir.control.polls[poll.index()].as_mut().unwrap().cost = 0,
            1 => mir.control.polls[poll.index()].as_mut().unwrap().cost = 2,
            2 => mir.control.polls[poll.index()].as_mut().unwrap().recovery = StateId(u32::MAX),
            _ => mir.control.polls[poll.index()] = None,
        }
        assert!(mir.finish().is_err());
    }
    let mut bad = r.clone();
    bad.instructions[poll.index()].state = None;
    assert!(verify(&bad).is_err());
    let mut bad = r.clone();
    bad.instructions[poll.index()].args.clear();
    assert!(verify(&bad).is_err());
    // A poll snapshot must dominate its check, even when the referenced value is
    // only needed on the early exit and the block's final state is valid.
    let Terminator::Exit(exit) = r.blocks[0].terminator.clone().unwrap()
    else {
        panic!()
    };
    r.instructions[poll.index()].state = Some(exit);
    assert!(verify(&r).is_err());
}
