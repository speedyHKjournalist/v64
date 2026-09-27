#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }
/// IR Tier-0 page functions return the linear EIP they leave for.
#[no_mangle]
pub fn call_indirect1_ret(f: fn(u16) -> i32, x: u16) -> i32 { f(x) }
