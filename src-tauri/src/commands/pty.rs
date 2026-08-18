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
    Exit { code: u32 },
    Closed,
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

    let session = PtySession::spawn(&options, move |event| {
        let reap = matches!(event, PtyEvent::Closed);
        let body = match event {
            PtyEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
            PtyEvent::Exit(code) => control(&PtyControl::Exit { code }),
            PtyEvent::Closed => control(&PtyControl::Closed),
        };
        // A closed window drops the receiving end; nothing to do about it.
        let _ = on_event.send(body);

        // Reap only once the pty is drained, so dropping the master can never
        // truncate the child's last words.
        if reap {
            app.state::<PtyRegistry>().lock().remove(&id);
        }
    })?;

    sessions.insert(id, session);
    Ok(id)
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
