pub fn write_leb_i32(buf: &mut Vec<u8>, v: i32) { write_leb_i64(buf, v as i64); }

pub fn write_leb_i64(buf: &mut Vec<u8>, mut v: i64) {
    // https://en.wikipedia.org/wiki/LEB128#Encode_signed_integer
    loop {
        let mut byte = v as u8 & 0b0111_1111;
        v >>= 7;
        let sign = byte & (1 << 6);
        let done = v == 0 && sign == 0 || v == -1 && sign != 0;
        if !done {
            byte |= 0b1000_0000;
        }
        buf.push(byte);
        if done {
            break;
        }
    }
}

pub fn write_leb_u32(buf: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut byte = v as u8 & 0b0111_1111;
        v >>= 7;
        if v != 0 {
            byte |= 0b1000_0000;
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}
