//! Occupancy mask for a thin sheet (2D cell grid in sheet UV space).

#[derive(Clone, Debug)]
pub struct SheetMask {
    pub width: u16,
    pub height: u16,
    pub cell_size: f32,
    /// Packed bits, row-major, LSB first within each byte.
    occupancy: Vec<u8>,
    reinforcement: Vec<u8>,
    pub damage: Vec<u8>,
    pub dent_depth: Vec<u8>,
    pub rev: u32,
    pub event_hash: u64,
    pub seq: u32,
}

impl SheetMask {
    pub fn new(width: u16, height: u16, cell_size: f32) -> Self {
        let cells = (width as usize) * (height as usize);
        let bytes = (cells + 7) / 8;
        let mut occupancy = vec![0xFFu8; bytes];
        // Clear unused trailing bits so hashing/comparisons are stable.
        let rem = cells % 8;
        if rem != 0 {
            let mask = (1u8 << rem) - 1;
            *occupancy.last_mut().unwrap() = mask;
        }
        Self {
            width,
            height,
            cell_size,
            occupancy,
            reinforcement: vec![0u8; bytes],
            damage: vec![0u8; cells],
            dent_depth: vec![0u8; cells],
            rev: 0,
            event_hash: 0,
            seq: 0,
        }
    }

    pub fn cell_count(&self) -> usize {
        self.width as usize * self.height as usize
    }

    #[inline]
    fn bit_index(x: u16, y: u16, width: u16) -> usize {
        y as usize * width as usize + x as usize
    }

    #[inline]
    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u16) < self.width && (y as u16) < self.height
    }

    pub fn occupied(&self, x: u16, y: u16) -> bool {
        let idx = Self::bit_index(x, y, self.width);
        let byte = self.occupancy[idx / 8];
        (byte >> (idx % 8)) & 1 == 1
    }

    pub fn set_occupied(&mut self, x: u16, y: u16, value: bool) {
        let idx = Self::bit_index(x, y, self.width);
        let bit = 1u8 << (idx % 8);
        if value {
            self.occupancy[idx / 8] |= bit;
        } else {
            self.occupancy[idx / 8] &= !bit;
        }
    }

    pub fn reinforced(&self, x: u16, y: u16) -> bool {
        let idx = Self::bit_index(x, y, self.width);
        let byte = self.reinforcement[idx / 8];
        (byte >> (idx % 8)) & 1 == 1
    }

    pub fn set_reinforced(&mut self, x: u16, y: u16, value: bool) {
        let idx = Self::bit_index(x, y, self.width);
        let bit = 1u8 << (idx % 8);
        if value {
            self.reinforcement[idx / 8] |= bit;
        } else {
            self.reinforcement[idx / 8] &= !bit;
        }
    }

    pub fn occupancy_bytes(&self) -> &[u8] {
        &self.occupancy
    }

    pub fn occupancy_count(&self) -> usize {
        let cells = self.cell_count();
        let full_bytes = cells / 8;
        let mut count = 0usize;
        for b in &self.occupancy[..full_bytes] {
            count += b.count_ones() as usize;
        }
        let rem = cells % 8;
        if rem != 0 {
            let last = self.occupancy[full_bytes];
            let mask = (1u8 << rem) - 1;
            count += (last & mask).count_ones() as usize;
        }
        count
    }

    pub fn is_fully_solid(&self) -> bool {
        let cells = self.cell_count();
        if cells == 0 {
            return true;
        }
        let full_bytes = cells / 8;
        for b in &self.occupancy[..full_bytes] {
            if *b != 0xFF {
                return false;
            }
        }
        let rem = cells % 8;
        if rem != 0 {
            let mask = (1u8 << rem) - 1;
            if self.occupancy[full_bytes] & mask != mask {
                return false;
            }
        }
        true
    }

    pub fn occupancy_ratio(&self) -> f32 {
        let total = self.cell_count().max(1);
        self.occupancy_count() as f32 / total as f32
    }

    /// Mix event bytes into the rolling desync hash (FNV-1a style).
    pub fn mix_event_hash(&mut self, bytes: &[u8]) {
        let mut h = self.event_hash;
        if h == 0 {
            h = 0xcbf29ce484222325;
        }
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        self.event_hash = h;
    }
}
