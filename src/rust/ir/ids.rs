macro_rules! id {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(pub u32);
        impl $name {
            pub fn index(self) -> usize { self.0 as usize }
        }
    };
}
id!(ValueId);
id!(BlockId);
id!(InstId);
id!(StateId);
id!(HelperId);
pub fn arena_index(n: usize) -> u32 { u32::try_from(n).expect("IR arena exceeds u32") }
