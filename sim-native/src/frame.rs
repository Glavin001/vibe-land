//! Lock-free triple buffer for handing sim frames to the render thread.
//!
//! The sim thread writes the back slot and publishes it; the JS thread
//! acquires the newest published slot and reads it in place through a
//! zero-copy ArrayBuffer over all three slots. Neither side waits: the writer
//! never touches the slot the reader holds, and a reader that falls behind
//! simply skips frames.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const DIRTY: u8 = 0b100;
const INDEX: u8 = 0b011;

pub struct Shared {
    storage: Box<[u32]>,
    slot_words: usize,
    /// The published ("middle") slot index, with DIRTY set when the reader
    /// has not taken it yet.
    middle: AtomicU8,
}

impl Shared {
    /// Base pointer and length in bytes of all three slots, back to back.
    pub fn bytes(&self) -> (*mut u8, usize) {
        (self.storage.as_ptr() as *mut u8, self.storage.len() * 4)
    }

    pub fn slot_words(&self) -> usize {
        self.slot_words
    }
}

pub struct Writer {
    shared: Arc<Shared>,
    back: u8,
}

pub struct Reader {
    shared: Arc<Shared>,
    front: u8,
}

pub fn triple_buffer(slot_words: usize) -> (Arc<Shared>, Writer, Reader) {
    let shared = Arc::new(Shared {
        storage: vec![0u32; slot_words * 3].into_boxed_slice(),
        slot_words,
        middle: AtomicU8::new(1),
    });
    (
        shared.clone(),
        Writer { shared: shared.clone(), back: 2 },
        Reader { shared, front: 0 },
    )
}

impl Writer {
    /// The back slot, owned by the writer until `publish`.
    pub fn slot(&mut self) -> &mut [u32] {
        let start = self.back as usize * self.shared.slot_words;
        // SAFETY: the back slot is exclusively the writer's: the reader only
        // ever holds `front`, and `middle` is neither until swapped.
        unsafe {
            let base = self.shared.storage.as_ptr() as *mut u32;
            std::slice::from_raw_parts_mut(base.add(start), self.shared.slot_words)
        }
    }

    pub fn publish(&mut self) {
        let previous = self.shared.middle.swap(self.back | DIRTY, Ordering::AcqRel);
        self.back = previous & INDEX;
    }
}

impl Reader {
    /// Takes the newest published slot if there is one, and returns the slot
    /// the reader now holds (unchanged when nothing new was published).
    pub fn acquire(&mut self) -> usize {
        if self.shared.middle.load(Ordering::Acquire) & DIRTY != 0 {
            let previous = self.shared.middle.swap(self.front, Ordering::AcqRel);
            self.front = previous & INDEX;
        }
        self.front as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_takes_the_newest_published_frame() {
        let (_shared, mut writer, mut reader) = triple_buffer(1);
        for frame in 1..=10u32 {
            writer.slot()[0] = frame;
            writer.publish();
            if frame % 3 == 0 {
                let slot = reader.acquire();
                assert_eq!(read(&reader, slot), frame);
            }
        }
        // Written but not published: the reader gets frame 10, not 11.
        writer.slot()[0] = 11;
        let slot = reader.acquire();
        assert_eq!(read(&reader, slot), 10);
        // Nothing new: the reader keeps its slot.
        assert_eq!(reader.acquire(), slot);
    }

    fn read(reader: &Reader, slot: usize) -> u32 {
        reader.shared.storage[slot * reader.shared.slot_words]
    }
}
