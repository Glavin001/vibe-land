/// Returns true if sequence number `a` is newer than `b`,
/// handling 16-bit wraparound correctly.
pub fn seq_is_newer(a: u16, b: u16) -> bool {
    let diff = a.wrapping_sub(b);
    diff != 0 && diff < 0x8000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_ordering() {
        assert!(seq_is_newer(2, 1));
        assert!(!seq_is_newer(1, 2));
        assert!(!seq_is_newer(1, 1));
    }

    #[test]
    fn wraparound() {
        assert!(seq_is_newer(2, 0xfffe));
        assert!(!seq_is_newer(0xfffe, 2));
    }

    #[test]
    fn half_range_boundary() {
        assert!(!seq_is_newer(0x8000, 0));
    }
}
