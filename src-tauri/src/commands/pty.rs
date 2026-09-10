//! The pty commands. All the interesting behaviour is in `crate::pty`; this
//! file owns the session registry and the wire format.
//!
//! Output transport: a Tauri [`Channel`] carrying `InvokeResponseBody::Raw`,
//! so child output crosses the IPC boundary as bytes — an `ArrayBuffer` on the
//! JS side, no base64 and no JSON array of numbers. Tauri routes raw payloads
//! of 1 KB and up through its fetch
//! channel instead of `eval`, which is exactly the size our coalescer produces
//! under load. Control messages (exit, closed) travel down the same channel as
//! JSON, so they stay ordered against the output they follow.
//!
//! A pty outlives the webview that spawned it: `pty_attach` / `pty_detach`
//! move the listener between windows (a terminal tab dragged into another
//! window), which is why the registry is app-wide state and not per-window.
//!
//! Desktop-only — see `crate::pty`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::pty::{PtyError, PtyErrorCode, PtyEvent, PtySession, SpawnOptions};

/// Every live pty in the app, keyed by the id the frontend holds.
///
/// These commands are synchronous and run on the main thread, so nothing done
/// under this lock may block: `PtySession::write` enqueues to a writer thread
/// (it errors when the queue is full rather than wait), and resize/kill are a
/// plain ioctl and a signal. Blocking here would freeze every terminal and the
/// UI, and deadlock the sink's self-reap in `pty_spawn`.
#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyRegistry {
    /// A poisoned lock means another command panicked while holding it. The
    /// map is still consistent, so recover rather than kill every terminal in
    /// the window.
    fn lock(&self) -> MutexGuard<'_, HashMap<u32, PtySession>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn with_session<T>(
        &self,
        id: u32,
        f: impl FnOnce(&mut PtySession) -> Result<T, PtyError>,
    ) -> Result<T, PtyError> {
        let mut sessions = self.lock();
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| PtyError::new(PtyErrorCode::NotFound, format!("no pty session {id}")))?;
        f(session)
    }
}

/// Control messages, tagged so the frontend can tell them from output — which
/// arrives as an `ArrayBuffer`, never an object.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PtyControl {
    Exit {
        code: u32,
    },
    Closed,
    /// Sent once per attach, after the replayed output: the frontend keeps the
    /// engine's query responses to itself until it arrives (see
    /// `PtyEvent::ReplayEnd`).
    ReplayEnd,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    options: SpawnOptions,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u32, PtyError> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Held across the spawn so a child that exits immediately cannot reap its
    // own session before it has been registered — the sink's `remove` blocks
    // on this guard until the insert below has happened.
    let mut sessions = state.lock();

    // Reap only once the pty is drained, so dropping the master can never
    // truncate the child's last words.
    let session = PtySession::spawn(&options, channel_sink(on_event), move || {
        app.state::<PtyRegistry>().lock().remove(&id);
    })?;

    sessions.insert(id, session);
    Ok(id)
}

/// Re-point a live pty at this window's channel, replaying the output it
/// buffered while detached (see `crate::pty::Relay`) so the screen comes back.
///
/// This is what makes a terminal tab dragged into another window the SAME
/// shell rather than a fresh one: the pty registry is app-wide, only the
/// listener is per-webview. `NOT_FOUND` means the session is gone (the shell
/// exited and reaped itself, or the id is from a previous run of the app) —
/// the caller spawns a new shell then. Returns the listener's epoch, which is
/// what `pty_detach` quotes back.
///
/// `cols`/`rows` are the NEW window's grid; `PtySession::attach` resizes to it
/// before replaying, which is what keeps the restored screen and its cursor
/// coherent — see the reasoning there.
#[tauri::command]
pub fn pty_attach(
    state: State<'_, PtyRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u64, PtyError> {
    state.with_session(id, |session| {
        Ok(session.attach(cols, rows, channel_sink(on_event)))
    })
}

/// Stop delivering a session's events to this window without killing the
/// shell — the releasing half of a handover. Output accumulates until
/// something attaches.
///
/// `epoch` names the attachment doing the releasing (0 for the window that
/// spawned the pty). The two halves of a handover race — the receiving window
/// usually attaches before the releasing pane has finished unmounting — so a
/// detach from a listener that has already been replaced is ignored rather
/// than silencing the window that took over.
#[tauri::command]
pub fn pty_detach(state: State<'_, PtyRegistry>, id: u32, epoch: u64) -> Result<(), PtyError> {
    state.with_session(id, |session| {
        session.detach(epoch);
        Ok(())
    })
}

/// Adapts pty events onto one webview's channel. The sink a session holds is
/// swappable, so this closure is built once per listener, not once per pty.
fn channel_sink(on_event: Channel<InvokeResponseBody>) -> impl FnMut(PtyEvent) + Send + 'static {
    move |event| {
        let body = match event {
            PtyEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
            PtyEvent::Exit(code) => control(&PtyControl::Exit { code }),
            PtyEvent::Closed => control(&PtyControl::Closed),
            PtyEvent::ReplayEnd => control(&PtyControl::ReplayEnd),
        };
        // A closed window drops the receiving end; nothing to do about it.
        let _ = on_event.send(body);
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyRegistry>, id: u32, data: Vec<u8>) -> Result<(), PtyError> {
    state.with_session(id, |session| session.write(&data))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), PtyError> {
    state.with_session(id, |session| session.resize(cols, rows))
}

/// Kills the child. The session reaps itself once the pty drains, so a caller
/// that kills a session that already exited on its own gets `NOT_FOUND` — and
/// should treat it as success.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyRegistry>, id: u32) -> Result<(), PtyError> {
    state.with_session(id, |session| session.kill())
}

fn control(message: &PtyControl) -> InvokeResponseBody {
    InvokeResponseBody::Json(
        serde_json::to_string(message).unwrap_or_else(|_| r#"{"type":"closed"}"#.to_string()),
    )
}
