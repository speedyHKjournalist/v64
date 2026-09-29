//! Wide architectural state and shared decode foundations. The public CPU
//! profile only advertises long mode after execution and OS gates pass.
pub mod state;
pub mod decode;
pub mod paging;
pub mod physical;
pub mod extended;
pub mod memory;
pub mod system;
pub mod execute;
pub mod vector;
pub mod compiler;
pub mod cache;
pub mod jac;
pub mod pagegen;
pub mod pages;
pub mod debug;
pub mod profile;
