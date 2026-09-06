//! Keep recoverable datagrams independent of the ordered state stream.
//!
//! A reliable queue overflow is a connection failure, never permission to
//! continue an ordered topology stream after silently omitting a packet.
use std::{future::pending, io};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::{mpsc, watch},
};

#[derive(Clone)]
pub(crate) struct Sender {
    reliable: mpsc::Sender<Vec<u8>>,
    datagrams: mpsc::Sender<Vec<u8>>,
    failed: watch::Sender<bool>,
}

pub(crate) struct Receiver {
    reliable: mpsc::Receiver<Vec<u8>>,
    datagrams: mpsc::Receiver<Vec<u8>>,
    pub(crate) failed: watch::Receiver<bool>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Enqueue {
    Queued,
    DatagramDropped,
    ReliableOverflow,
    Closed,
}

pub(crate) fn channel(capacity: usize) -> (Sender, Receiver) {
    let (reliable, reliable_rx) = mpsc::channel(capacity);
    let (datagrams, datagrams_rx) = mpsc::channel(capacity);
    let (failed, failed_rx) = watch::channel(false);
    (
        Sender {
            reliable,
            datagrams,
            failed,
        },
        Receiver {
            reliable: reliable_rx,
            datagrams: datagrams_rx,
            failed: failed_rx,
        },
    )
}

impl Sender {
    pub(crate) fn capacity(&self) -> usize {
        if *self.failed.borrow() || self.reliable.is_closed() {
            0
        } else {
            self.reliable.capacity()
        }
    }

    pub(crate) fn enqueue(&self, packet: Vec<u8>, unreliable: bool) -> Enqueue {
        if *self.failed.borrow() {
            return Enqueue::Closed;
        }
        let lane = if unreliable {
            &self.datagrams
        } else {
            &self.reliable
        };
        match lane.try_send(packet) {
            Ok(()) => Enqueue::Queued,
            Err(mpsc::error::TrySendError::Closed(_)) => Enqueue::Closed,
            Err(mpsc::error::TrySendError::Full(_)) if unreliable => Enqueue::DatagramDropped,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.failed.send_replace(true);
                Enqueue::ReliableOverflow
            }
        }
    }
}

/// Wake even while a network write is pending. Once failed, the enclosing
/// transport must close the session; a partially written frame cannot be reused.
pub(crate) async fn failed(signal: &mut watch::Receiver<bool>) {
    loop {
        if *signal.borrow_and_update() {
            return;
        }
        if signal.changed().await.is_err() {
            pending::<()>().await;
        }
    }
}

impl Receiver {
    /// WebSocket has one ordered transport and must serialize both lanes.
    /// Fair selection avoids starving recoverable snapshots under reliable load.
    pub(crate) async fn recv(&mut self) -> Option<Vec<u8>> {
        tokio::select! {
            packet = self.reliable.recv() => match packet {
                Some(packet) => Some(packet),
                None => self.datagrams.recv().await,
            },
            packet = self.datagrams.recv() => match packet {
                Some(packet) => Some(packet),
                None => self.reliable.recv().await,
            },
        }
    }
}

/// `datagram` returns true if it consumed the packet (sent or deliberately
/// dropped), false to request the existing reliable fallback for that packet.
/// Only the recoverable lane can use fallback; a full fallback queue drops that
/// recoverable packet without displacing or failing ordered state.
pub(crate) async fn write_webtransport<W, D, S, L>(
    stream: &mut W,
    receiver: Receiver,
    mut datagram: D,
    mut reliable_sent: S,
    mut fallback_dropped: L,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    D: FnMut(&[u8]) -> bool,
    S: FnMut(&[u8]),
    L: FnMut(&[u8]),
{
    let Receiver {
        mut reliable,
        mut datagrams,
        failed: mut failure,
    } = receiver;
    // Fallback stays separate too: oversized recoverable packets must never
    // consume capacity reserved for topology and other reliable state.
    let (fallback_tx, mut fallback_rx) = mpsc::channel(datagrams.max_capacity());
    let reliable_writer = async {
        let (mut state_open, mut fallback_open) = (true, true);
        loop {
            let packet = tokio::select! {
                biased;
                packet = reliable.recv(), if state_open => match packet {
                    Some(packet) => packet,
                    None => { state_open = false; continue; }
                },
                packet = fallback_rx.recv(), if fallback_open => match packet {
                    Some(packet) => packet,
                    None => { fallback_open = false; continue; }
                },
                else => break,
            };
            if packet.is_empty() {
                continue;
            }
            let length = u32::try_from(packet.len()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "outbound frame exceeds wire length",
                )
            })?;
            // No extra packet-sized framing copy. One task owns the stream,
            // so the prefix and body cannot interleave with another frame.
            stream.write_all(&length.to_le_bytes()).await?;
            stream.write_all(&packet).await?;
            reliable_sent(&packet);
        }
        Ok::<(), io::Error>(())
    };
    let datagram_writer = async move {
        while let Some(packet) = datagrams.recv().await {
            if packet.is_empty() || datagram(&packet) {
                continue;
            }
            if let Err(mpsc::error::TrySendError::Full(packet)) = fallback_tx.try_send(packet) {
                fallback_dropped(&packet);
            }
        }
        Ok::<(), io::Error>(())
    };
    // Join both lanes for ordinary channel closure: closing one queue must not
    // discard packets still queued in the other. Fatal overflow interrupts both.
    tokio::select! {
        biased;
        _ = failed(&mut failure) => Err(io::Error::new(io::ErrorKind::BrokenPipe, "reliable outbound queue exhausted")),
        result = async { tokio::try_join!(reliable_writer, datagram_writer)?; Ok(()) } => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn stalled_reliable_stream_does_not_block_datagrams_or_reorder_state() {
        let (tx, rx) = channel(4);
        let (mut writer, mut reader) = tokio::io::duplex(1);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let output = observed.clone();
        assert_eq!(tx.enqueue(vec![121, 10, 20], false), Enqueue::Queued);
        let task = tokio::spawn(async move {
            write_webtransport(
                &mut writer,
                rx,
                |p| {
                    output.lock().unwrap().push(p.to_vec());
                    true
                },
                |_| {},
                |_| {},
            )
            .await
        });
        // The one-byte stream cannot finish even the first frame prefix.
        for n in 0..12 {
            assert_eq!(tx.enqueue(vec![123, n], true), Enqueue::Queued);
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while observed.lock().unwrap().len() <= n as usize {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        assert_eq!(tx.enqueue(vec![122, 30], false), Enqueue::Queued);
        assert_eq!(tx.enqueue(vec![128, 40], false), Enqueue::Queued);
        drop(tx);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            bytes,
            [3, 0, 0, 0, 121, 10, 20, 2, 0, 0, 0, 122, 30, 2, 0, 0, 0, 128, 40]
        );
        assert_eq!(observed.lock().unwrap().len(), 12);
    }

    #[tokio::test]
    async fn datagram_pressure_cannot_evict_reliable_packets() {
        let (tx, mut rx) = channel(1);
        assert_eq!(tx.enqueue(vec![123, 1], true), Enqueue::Queued);
        assert_eq!(tx.enqueue(vec![123, 2], true), Enqueue::DatagramDropped);
        assert_eq!(tx.enqueue(vec![121, 3], false), Enqueue::Queued);
        assert_eq!(rx.reliable.recv().await, Some(vec![121, 3]));
        assert!(!*rx.failed.borrow());
    }

    #[tokio::test]
    async fn reliable_overflow_interrupts_a_blocked_write_and_rejects_future_packets() {
        let (tx, rx) = channel(1);
        let (mut writer, _unread) = tokio::io::duplex(1);
        assert_eq!(tx.enqueue(vec![121, 1], false), Enqueue::Queued);
        let task = tokio::spawn(async move {
            write_webtransport(&mut writer, rx, |_| true, |_| {}, |_| {}).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while tx.capacity() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(tx.enqueue(vec![122, 2], false), Enqueue::Queued);
        assert_eq!(tx.enqueue(vec![122, 3], false), Enqueue::ReliableOverflow);
        assert_eq!(tx.enqueue(vec![122, 4], false), Enqueue::Closed);
        assert_eq!(tx.enqueue(vec![123, 5], true), Enqueue::Closed);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    }

    #[tokio::test]
    async fn websocket_receiver_drains_both_queues_without_reordering_reliable_frames() {
        let (tx, mut rx) = channel(4);
        for n in 0..3 {
            assert_eq!(tx.enqueue(vec![121, n], false), Enqueue::Queued);
        }
        assert_eq!(tx.enqueue(vec![123, 9], true), Enqueue::Queued);
        drop(tx);
        let mut reliable = Vec::new();
        let mut datagrams = 0;
        while let Some(p) = rx.recv().await {
            if p[0] == 121 {
                reliable.push(p[1]);
            } else {
                datagrams += 1;
            }
        }
        assert_eq!(reliable, [0, 1, 2]);
        assert_eq!(datagrams, 1);
    }

    #[tokio::test]
    async fn full_fallback_queue_sheds_only_the_recoverable_packet() {
        let (tx, rx) = channel(1);
        let (mut writer, mut reader) = tokio::io::duplex(1);
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = dropped.clone();
        assert_eq!(tx.enqueue(vec![121, 1], false), Enqueue::Queued);
        let task = tokio::spawn(async move {
            write_webtransport(
                &mut writer,
                rx,
                |_| false,
                |_| {},
                |_| {
                    observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                },
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while tx.capacity() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(tx.enqueue(vec![122, 2], false), Enqueue::Queued);
        assert_eq!(tx.enqueue(vec![123, 3], true), Enqueue::Queued);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while tx.datagrams.capacity() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(tx.enqueue(vec![123, 4], true), Enqueue::Queued);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while dropped.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!*tx.failed.borrow());
        drop(tx);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            bytes,
            [2, 0, 0, 0, 121, 1, 2, 0, 0, 0, 122, 2, 2, 0, 0, 0, 123, 3]
        );
    }

    #[tokio::test]
    async fn real_webtransport_datagrams_progress_while_peer_stalls_reliable_reads() {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig, VarInt};
            let identity = Identity::self_signed(["localhost", "127.0.0.1"]).unwrap();
            let hash = identity.certificate_chain().as_slice()[0].hash();
            let server = Endpoint::server(
                ServerConfig::builder()
                    .with_bind_address("127.0.0.1:0".parse().unwrap())
                    .with_identity(identity)
                    .build(),
            )
            .unwrap();
            let client = Endpoint::client(
                ClientConfig::builder()
                    .with_bind_default()
                    .with_server_certificate_hashes([hash])
                    .build(),
            )
            .unwrap();
            let url = format!("https://{}/outbound-test", server.local_addr().unwrap());
            let (server_conn, client_conn) = tokio::join!(
                async { server.accept().await.await.unwrap().accept().await.unwrap() },
                async { client.connect(url).await.unwrap() },
            );
            let (mut client_send, mut client_recv) =
                client_conn.open_bi().await.unwrap().await.unwrap();
            client_send.write_all(&[1]).await.unwrap();
            let (mut server_send, mut server_recv) = server_conn.accept_bi().await.unwrap();
            server_recv.read_exact(&mut [0u8; 1]).await.unwrap();
            let (tx, rx) = channel(4);
            // Larger than QUIC's default stream receive window plus send
            // buffer; this fixture forces real flow control, not just a mock.
            let body = vec![121; 16 * 1024 * 1024];
            assert_eq!(tx.enqueue(body.clone(), false), Enqueue::Queued);
            let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed = completed.clone();
            let writer_conn = server_conn.clone();
            let task = tokio::spawn(async move {
                write_webtransport(
                    &mut server_send,
                    rx,
                    |p| {
                        writer_conn.send_datagram(p).unwrap();
                        true
                    },
                    |_| {
                        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    },
                    |_| panic!("unexpected fallback drop"),
                )
                .await
            });
            while tx.capacity() != 4 {
                tokio::task::yield_now().await;
            }
            for n in 0..8 {
                assert_eq!(tx.enqueue(vec![123, n], true), Enqueue::Queued);
                let packet = client_conn.receive_datagram().await.unwrap();
                assert_eq!(packet.payload().as_ref(), &[123, n]);
                assert_eq!(completed.load(std::sync::atomic::Ordering::SeqCst), 0);
            }
            assert_eq!(tx.enqueue(vec![122, 99], false), Enqueue::Queued);
            // Release flow control and verify every byte and the next frame.
            let mut length = [0u8; 4];
            client_recv.read_exact(&mut length).await.unwrap();
            assert_eq!(u32::from_le_bytes(length) as usize, body.len());
            let mut received = vec![0; body.len()];
            client_recv.read_exact(&mut received).await.unwrap();
            assert_eq!(received, body);
            client_recv.read_exact(&mut length).await.unwrap();
            assert_eq!(u32::from_le_bytes(length), 2);
            let mut next = [0u8; 2];
            client_recv.read_exact(&mut next).await.unwrap();
            assert_eq!(next, [122, 99]);
            drop(tx);
            task.await.unwrap().unwrap();
            client_conn.close(VarInt::from_u32(0), b"test finished");
            server_conn.close(VarInt::from_u32(0), b"test finished");
        })
        .await
        .expect("WebTransport flow-control test timed out");
    }
}
