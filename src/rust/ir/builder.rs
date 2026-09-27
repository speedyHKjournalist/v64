//! Sealed-block SSA construction. Each block parameter corresponds to one guest variable.
use super::{hir::*, ids::*, types::Type};
pub struct SsaBuilder {
    pub region: Region,
    types: Vec<Type>,
    defs: Vec<Vec<Option<ValueId>>>,
    predecessors: Vec<Vec<BlockId>>,
    sealed: Vec<bool>,
    variables: Vec<Vec<usize>>,
}
impl SsaBuilder {
    pub fn new(types: Vec<Type>) -> Self {
        Self {
            region: Region::default(),
            types,
            defs: vec![],
            predecessors: vec![],
            sealed: vec![],
            variables: vec![],
        }
    }
    pub fn block(&mut self, entry: bool) -> BlockId {
        let block = self.region.block(entry);
        self.defs.push(vec![None; self.types.len()]);
        self.predecessors.push(vec![]);
        self.sealed.push(false);
        self.variables.push(vec![]);
        block
    }
    pub fn write(&mut self, block: BlockId, variable: usize, value: ValueId) {
        assert_eq!(self.types[variable], self.region.values[value.index()].ty);
        self.defs[block.index()][variable] = Some(value);
    }
    fn parameter(&mut self, block: BlockId, variable: usize) -> ValueId {
        let value = self.region.param(block, self.types[variable]);
        self.variables[block.index()].push(variable);
        self.write(block, variable, value);
        value
    }
    pub fn read(&mut self, block: BlockId, variable: usize) -> Result<ValueId, &'static str> {
        if let Some(value) = self.defs[block.index()][variable] {
            return Ok(value);
        }
        if !self.sealed[block.index()] {
            return Ok(self.parameter(block, variable));
        }
        let predecessors = self.predecessors[block.index()].clone();
        let value = match predecessors.as_slice() {
            [] => return Err("entry variable has no initialization"),
            [pred] => {
                // Install a parameter first to break cycles in unreachable/self-loop CFGs.
                let provisional = self.parameter(block, variable);
                let value = self.read(*pred, variable)?;
                if value == provisional {
                    return Err("uninitialized variable cycle");
                }
                value
            },
            _ => self.parameter(block, variable),
        };
        self.write(block, variable, value);
        Ok(value)
    }
    pub fn terminate(&mut self, block: BlockId, term: Terminator) -> Result<(), &'static str> {
        for edge in term.edges() {
            if self.sealed[edge.target.index()] {
                return Err("adding predecessor to sealed block");
            }
            if !edge.args.is_empty() {
                return Err("SSA builder supplies edge arguments");
            }
        }
        for edge in term.edges() {
            self.predecessors[edge.target.index()].push(block);
        }
        self.region.terminate(block, term);
        Ok(())
    }
    pub fn seal(&mut self, block: BlockId) { self.sealed[block.index()] = true; }
    pub fn finish(mut self) -> Result<Region, &'static str> {
        self.sealed.fill(true);
        // Reading predecessor variables can create more parameters. Resolve to a fixed point.
        loop {
            let old = self.region.values.len();
            for b in 0..self.region.blocks.len() {
                for variable in self.variables[b].clone() {
                    if self.predecessors[b].is_empty() {
                        return Err("uninitialized entry parameter");
                    }
                    for pred in self.predecessors[b].clone() {
                        self.read(pred, variable)?;
                    }
                }
            }
            if old == self.region.values.len() {
                break;
            }
        }
        for b in 0..self.region.blocks.len() {
            let mut term = self.region.blocks[b]
                .terminator
                .take()
                .ok_or("unterminated block")?;
            for edge in term.edges_mut() {
                for variable in self.variables[edge.target.index()].clone() {
                    edge.args.push(self.read(BlockId(b as u32), variable)?);
                }
            }
            self.region.blocks[b].terminator = Some(term);
        }
        Ok(self.region)
    }
}
