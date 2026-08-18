//! The pty engine: spawn a child on a pseudo-terminal and pump its output.
//!
//! Deliberately free of Tauri types so the whole thing is unit-testable with a
//! plain closure as the sink (see the tests at the bottom — they run a real
//! shell). `commands/pty.rs` is the thin Tauri skin over this.
//!
//! Threading, per session:
//!
//! ```text
//!   reader ──┐ bounded channel (backpressure)
//!            ├──▶ emitter ──▶ sink   (coalesces output, orders events)
//!   waiter ──┘
//!
//!   write() ──▶ bounded channel ──▶ writer ──▶ pty
//! ```
//!
//! The reader blocks once the channel is full, which stops draining the pty,
//! which blocks the child's `write` — backpressure all the way down, so a
//! runaway `yes` cannot balloon memory.
//!
//! Writes go the other way through their own thread: `write()` only enqueues,
//! so a child that has stopped reading its input (kernel buffer full) blocks
//! the writer thread, never the caller — `commands/pty.rs` calls `write()`
//! under a registry-wide lock on the main thread, where blocking would freeze
//! every terminal and the UI with them. When the queue itself fills, `write()`
//! fails with `Io` rather than wait.
//!
//! Desktop-only: Android has no pty. `commands/mod.rs` gates the module and
//! `Cargo.toml` keeps `portable-pty` out of the mobile dependency graph.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// One read syscall's worth of bytes.
const READ_BUF: usize = 16 * 1024;
/// Upper bound on a coalesced chunk handed to the sink.
const MAX_COALESCED: usize = 64 * 1024;
/// How long the emitter waits for more bytes before flushing what it has.
/// Small enough to stay invisible to a person typing, long enough that a
/// screenful of output arrives as one message instead of forty.
const FLUSH: Duration = Duration::from_millis(4);
/// Chunks the reader may run ahead of the emitter before it blocks.
const BACKLOG: usize = 8;
/// Writes that may queue behind a child that has stopped reading before
/// `write()` starts failing instead. Each entry is one `pty_write` payload (a
/// keystroke or a paste), so this is depth, not bytes.
const WRITE_BACKLOG: usize = 256;

/// What `pty_spawn` accepts. Field names are camelCase over IPC.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub cols: u16,
    pub rows: u16,
    /// Defaults to the user's login shell.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Extra environment for the child. Applied after the terminal's own
    /// `TERM`/`COLORTERM`, so a profile can override them on purpose.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Everything a session tells the outside world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// A coalesced run of child output.
    Output(Vec<u8>),
    /// The child process finished. Output may still follow if a grandchild
    /// (say, a backgrounded process) is holding the pty open.
    Exit(u32),
    /// The pty reached EOF and every thread is done: no more events, and the
    /// session can be reaped.
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PtyErrorCode {
    /// The child could not be started (bad program, bad cwd).
    Spawn,
    /// No session with that id — already killed, or never existed.
    NotFound,
    /// The pty itself failed (write to a dead pty, resize, allocation).
    Io,
}

/// Serializes as `{ code, message }` — the same error shape every other
/// command in this app uses, so `src/ipc/commands.ts` switches on it uniformly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct PtyError {
    pub code: PtyErrorCode,
    pub message: String,
}

impl PtyError {
    pub fn new(code: PtyErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn spawn(message: impl std::fmt::Display) -> Self {
        Self::new(PtyErrorCode::Spawn, message.to_string())
    }

    fn io(message: impl std::fmt::Display) -> Self {
        Self::new(PtyErrorCode::Io, message.to_string())
    }
}

/// A live pty and the handles needed to talk to it. Dropping this closes the
/// master, which ends the reader thread.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Feeds the writer thread; dropping it (with the session) ends the thread.
    write_tx: SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl PtySession {
    /// Starts the child and the four threads that service it. `sink` is called
    /// from the emitter thread, never concurrently with itself.
    pub fn spawn<F>(options: &SpawnOptions, sink: F) -> Result<Self, PtyError>
    where
        F: FnMut(PtyEvent) + Send + 'static,
    {
        let pair = native_pty_system()
            .openpty(pty_size(options.cols, options.rows))
            .map_err(PtyError::spawn)?;

        let mut child = pair
            .slave
            .spawn_command(build_command(options))
            .map_err(PtyError::spawn)?;
        // The parent must not keep a slave handle open or the reader never
        // sees EOF after the child exits.
        drop(pair.slave);

        let master = pair.master;
        let reader = master.try_clone_reader().map_err(PtyError::io)?;
        let writer = master.take_writer().map_err(PtyError::io)?;
        let killer = child.clone_killer();

        let (tx, rx) = sync_channel::<PtyEvent>(BACKLOG);
        let exit_tx = tx.clone();
        let (write_tx, write_rx) = sync_channel::<Vec<u8>>(WRITE_BACKLOG);

        spawn_thread("pty-reader", move || read_loop(reader, tx));
        spawn_thread("pty-emitter", move || emit_loop(rx, sink));
        spawn_thread("pty-writer", move || write_loop(writer, write_rx));
        spawn_thread("pty-waiter", move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            let _ = exit_tx.send(PtyEvent::Exit(code));
        });

        Ok(Self {
            master,
            write_tx,
            killer,
        })
    }

    /// Queues `data` for the writer thread. Never blocks: a child that has
    /// stopped reading fills the kernel buffer, then the queue, and only then
    /// does this fail — with an error, not a stall (see the module docs).
    pub fn write(&self, data: &[u8]) -> Result<(), PtyError> {
        use std::sync::mpsc::TrySendError;
        match self.write_tx.try_send(data.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(PtyError::io(
                "the pty is not accepting input (child not reading?)",
            )),
            Err(TrySendError::Disconnected(_)) => Err(PtyError::io("the pty is closed")),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(PtyError::io)
    }

    /// SIGKILL-equivalent. The reader then sees EOF and the session closes.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        self.killer.kill().map_err(PtyError::io)
    }
}

/// Zero rows or columns is a valid ioctl but nonsense to every TUI, and some
/// shells divide by it. One is the floor everywhere.
fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn build_command(options: &SpawnOptions) -> CommandBuilder {
    let program = options
        .program
        .clone()
        .unwrap_or_else(crate::shell::default_shell);
    let mut cmd = CommandBuilder::new(program);
    for arg in &options.args {
        cmd.arg(arg);
    }
    if let Some(cwd) = &options.cwd {
        cmd.cwd(cwd);
    }
    // Env hygiene: claim exactly what src/term actually implements.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (key, value) in &options.env {
        cmd.env(key, value);
    }
    cmd
}

fn spawn_thread<F: FnOnce() + Send + 'static>(name: &str, body: F) {
    let _ = thread::Builder::new().name(name.to_string()).spawn(body);
}

/// Drains the write queue into the pty. Ends when the session is dropped
/// (sender gone) or the pty stops taking input for good — a blocked `write_all`
/// returns with an error once the child dies and the master is dropped.
fn write_loop(mut writer: Box<dyn Write + Send>, rx: Receiver<Vec<u8>>) {
    while let Ok(data) = rx.recv() {
        if writer
            .write_all(&data)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: SyncSender<PtyEvent>) {
    let mut buf = vec![0u8; READ_BUF];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(PtyEvent::Output(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            // A closed pty reports EIO on Linux rather than EOF; either way
            // there is nothing left to read.
            Err(_) => break,
        }
    }
}

/// Drains the channel, merging small reads into one message. Ends when every
/// sender is gone (reader at EOF, child reaped), then reports `Closed`.
fn emit_loop<F: FnMut(PtyEvent)>(rx: Receiver<PtyEvent>, mut sink: F) {
    while let Ok(event) = rx.recv() {
        let PtyEvent::Output(mut buf) = event else {
            sink(event);
            continue;
        };

        let deadline = Instant::now() + FLUSH;
        let mut trailing = None;
        while buf.len() < MAX_COALESCED {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(PtyEvent::Output(next)) => buf.extend_from_slice(&next),
                // Never reorder an exit past the output that preceded it.
                Ok(control) => {
                    trailing = Some(control);
                    break;
                }
                Err(_) => break,
            }
        }

        sink(PtyEvent::Output(buf));
        if let Some(control) = trailing {
            sink(control);
        }
    }
    sink(PtyEvent::Closed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Collects everything a session emits so tests can assert on it.
    #[derive(Clone, Default)]
    struct Sink {
        output: Arc<Mutex<Vec<u8>>>,
        events: Arc<Mutex<Vec<PtyEvent>>>,
    }

    impl Sink {
        fn sink(&self) -> impl FnMut(PtyEvent) + Send + 'static {
            let output = self.output.clone();
            let events = self.events.clone();
            move |event| {
                if let PtyEvent::Output(bytes) = &event {
                    output.lock().unwrap().extend_from_slice(bytes);
                    events.lock().unwrap().push(PtyEvent::Output(Vec::new()));
                } else {
                    events.lock().unwrap().push(event);
                }
            }
        }

        fn text(&self) -> String {
            String::from_utf8_lossy(&self.output.lock().unwrap()).to_string()
        }

        fn events(&self) -> Vec<PtyEvent> {
            self.events.lock().unwrap().clone()
        }

        /// Polls until `predicate` holds, so tests never sleep a fixed amount.
        fn wait_for(&self, what: &str, predicate: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if predicate(self) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!(
                "timed out waiting for {what}; output so far: {:?}",
                self.text()
            );
        }
    }

    #[cfg(unix)]
    fn sh(script: &str) -> SpawnOptions {
        SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            ..SpawnOptions::default()
        }
    }

    #[test]
    #[cfg(unix)]
    fn runs_a_command_and_reports_its_exit_code() {
        let sink = Sink::default();
        let _session = PtySession::spawn(&sh("echo hello; exit 3"), sink.sink()).unwrap();

        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
        assert!(sink.text().contains("hello"), "got {:?}", sink.text());
        assert!(sink.events().contains(&PtyEvent::Exit(3)));
    }

    #[test]
    #[cfg(unix)]
    fn exports_a_terminal_environment() {
        let sink = Sink::default();
        let _session = PtySession::spawn(
            &sh("printf '%s/%s\\n' \"$TERM\" \"$COLORTERM\""),
            sink.sink(),
        )
        .unwrap();

        sink.wait_for("output", |s| s.text().contains('/'));
        assert!(
            sink.text().contains("xterm-256color/truecolor"),
            "got {:?}",
            sink.text()
        );
    }

    #[test]
    #[cfg(unix)]
    fn writes_reach_the_child() {
        let sink = Sink::default();
        let session = PtySession::spawn(&sh("read line; echo \"got:$line\""), sink.sink()).unwrap();

        session.write(b"ping\n").unwrap();
        sink.wait_for("echoed line", |s| s.text().contains("got:ping"));
    }

    #[test]
    #[cfg(unix)]
    fn resize_is_visible_to_the_child() {
        let sink = Sink::default();
        // `read` holds the child until after the resize, so this cannot race.
        let session = PtySession::spawn(&sh("read _; stty size"), sink.sink()).unwrap();

        session.resize(100, 30).unwrap();
        session.write(b"\n").unwrap();
        sink.wait_for("stty output", |s| s.text().contains("30 100"));
    }

    #[test]
    #[cfg(unix)]
    fn kill_stops_a_child_that_would_never_exit() {
        let sink = Sink::default();
        let mut session = PtySession::spawn(&sh("while :; do sleep 1; done"), sink.sink()).unwrap();

        session.kill().unwrap();
        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
    }

    #[test]
    #[cfg(unix)]
    fn write_fails_fast_instead_of_blocking_when_the_child_stops_reading() {
        let sink = Sink::default();
        // Raw mode, or the line discipline discards over-long lines instead of
        // back-pressuring; -echo so the flood doesn't also come back as output.
        let mut session =
            PtySession::spawn(&sh("stty raw -echo; echo READY; sleep 30"), sink.sink()).unwrap();
        sink.wait_for("raw mode", |s| s.text().contains("READY"));

        // Fill the kernel's pty input buffer, then the write queue. The old
        // code blocked here forever (holding the app-wide registry lock).
        let chunk = vec![b'x'; 4 * 1024];
        let started = Instant::now();
        let failed = (0..2000).any(|_| session.write(&chunk).is_err());
        assert!(failed, "every write to a non-reading child succeeded");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "write blocked instead of failing fast"
        );

        session.kill().unwrap();
        sink.wait_for("close", |s| s.events().contains(&PtyEvent::Closed));
    }

    #[test]
    fn rejects_a_program_that_does_not_exist() {
        let options = SpawnOptions {
            cols: 80,
            rows: 24,
            program: Some("definitely-not-a-real-program".into()),
            ..SpawnOptions::default()
        };
        // `PtySession` holds trait objects and so isn't Debug; match rather
        // than unwrap_err.
        match PtySession::spawn(&options, |_| {}) {
            Err(error) => assert_eq!(error.code, PtyErrorCode::Spawn),
            Ok(_) => panic!("spawning a nonexistent program should fail"),
        }
    }

    /// Throughput baseline for the pty read path. Ignored by default so CI
    /// stays fast and deterministic; run it with
    /// `cargo test --lib -- --ignored --nocapture`.
    ///
    /// This measures the pty read path and the coalescer only — everything up
    /// to the sink. The IPC leg is not covered here.
    #[test]
    #[ignore = "benchmark; run with `cargo test --lib -- --ignored --nocapture`"]
    #[cfg(unix)]
    fn benchmark_throughput() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let path = std::env::temp_dir().join("md-notepad-pty-bench.txt");
        let line = format!("{}\n", "x".repeat(79));
        let mut data = String::with_capacity(10 << 20);
        while data.len() < (10 << 20) {
            data.push_str(&line);
        }
        std::fs::write(&path, &data).expect("write bench file");

        let bytes = Arc::new(AtomicUsize::new(0));
        let chunks = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));

        let (b, c, d) = (bytes.clone(), chunks.clone(), done.clone());
        let started = Instant::now();
        let _session =
            PtySession::spawn(
                &sh(&format!("cat {}", path.display())),
                move |event| match event {
                    PtyEvent::Output(buf) => {
                        b.fetch_add(buf.len(), Ordering::Relaxed);
                        c.fetch_add(1, Ordering::Relaxed);
                    }
                    PtyEvent::Closed => {
                        d.store(1, Ordering::Release);
                    }
                    PtyEvent::Exit(_) => {}
                },
            )
            .expect("spawn cat");

        while done.load(Ordering::Acquire) == 0 {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "cat never finished"
            );
            thread::sleep(Duration::from_millis(5));
        }
        let elapsed = started.elapsed();
        let total = bytes.load(Ordering::Relaxed);
        let _ = std::fs::remove_file(&path);

        println!(
            "cat 10MB: {:.1} MB/s ({} bytes in {} chunks, {:.0} KB/chunk, {:.2}s)",
            total as f64 / elapsed.as_secs_f64() / 1e6,
            total,
            chunks.load(Ordering::Relaxed),
            total as f64 / chunks.load(Ordering::Relaxed).max(1) as f64 / 1024.0,
            elapsed.as_secs_f64(),
        );
        // The pty adds \r to every \n, so the child writes more than the file.
        assert!(total >= 10 << 20);
    }

    #[test]
    fn a_collapsed_window_never_asks_for_a_zero_sized_pty() {
        assert_eq!(pty_size(0, 0).cols, 1);
        assert_eq!(pty_size(0, 0).rows, 1);
        assert_eq!(pty_size(80, 24).cols, 80);
    }
}
