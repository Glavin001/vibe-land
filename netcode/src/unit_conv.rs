use std::f32::consts::TAU;

pub fn meters_to_mm(value: f32) -> i32 {
    (value * 1000.0).round() as i32
}

pub fn mm_to_meters(value: i32) -> f32 {
    value as f32 / 1000.0
}

pub fn meters_to_cms_i16(value: f32) -> i16 {
    (value.clamp(-327.67, 327.67) * 100.0).round() as i16
}

pub fn cms_to_mps(value: i16) -> f32 {
    value as f32 / 100.0
}

pub fn angle_to_i16(angle_rad: f32) -> i16 {
    let normalized = angle_rad.rem_euclid(TAU) / TAU;
    let u16_val = (normalized * 65535.0).round() as u16;
    u16_val as i16
}

pub fn i16_to_angle(encoded: i16) -> f32 {
    (encoded as u16 as f32 / 65535.0) * TAU
}

pub fn f32_to_snorm16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

pub fn snorm16_to_f32(value: i16) -> f32 {
    (value as f32 / 32767.0).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meters_mm_roundtrip() {
        let original = 5.123_f32;
        let mm = meters_to_mm(original);
        let back = mm_to_meters(mm);
        assert!((back - original).abs() < 0.001);
    }

    #[test]
    fn angle_roundtrip() {
        let original = 1.5_f32;
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        assert!((decoded - original).abs() < 0.01);
    }

    #[test]
    fn angle_negative_wraps() {
        let original = -1.0_f32;
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        let expected = original.rem_euclid(TAU);
        assert!((decoded - expected).abs() < 0.01);
    }

    #[test]
    fn snorm16_roundtrip() {
        let original = 0.5_f32;
        let encoded = f32_to_snorm16(original);
        let decoded = snorm16_to_f32(encoded);
        assert!((decoded - original).abs() < 0.001);
    }

    #[test]
    fn cms_mps_roundtrip() {
        let mps = 3.25_f32;
        let cms = meters_to_cms_i16(mps);
        let back = cms_to_mps(cms);
        assert!((back - mps).abs() < 0.02);
    }
}
