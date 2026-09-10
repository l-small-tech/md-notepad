//! Windows-only dictation for voice notes, via `Windows.Media.SpeechRecognition`
//! — the speech engine that ships with Windows 10/11. It exposes the SAME five
//! commands (`stt_available`, `stt_permission`, `stt_request_permission`,
//! `stt_start`, `stt_stop`) as the Android SpeechRecognizer bridge in
//! `android.rs`, so the frontend drives one capture flow on both platforms.
//!
//! Contract notes:
//! - `stt_start` runs a continuous dictation session and resolves only when
//!   the session ends — normally because `stt_stop` asked it to (the second
//!   tap on the mic), which lets the engine finish the phrase in flight. The
//!   recognized phrases are joined into one transcript. Nothing is recorded
//!   to disk.
//! - Every wait is bounded. `stt_stop` only posts a message to the dictation
//!   thread and returns at once; that thread asks Windows to stop and, if
//!   Windows hasn't reported `Completed` within `STOP_GRACE`, cancels the
//!   session and returns what it heard so far. A session that never starts
//!   fails with `STT_START_TIMEOUT`. A new `stt_start` ends a leftover
//!   session instead of refusing — `STT_BUSY` only if it won't wind down.
//! - Free dictation on Windows is Microsoft's ONLINE recognizer: it only runs
//!   with Settings → Privacy & security → Speech → "Online speech
//!   recognition" turned on, and audio is sent to Microsoft while it runs.
//!   With that setting off the engine fails with `SPERR_SPEECH_PRIVACY_POLICY
//!   _NOT_ACCEPTED`, reported as `STT_PRIVACY` so the UI can say what to turn
//!   on. A denied microphone ("Let desktop apps access your microphone")
//!   surfaces as `PERMISSION_DENIED`.
//! - An unpackaged desktop app has no permission prompt to raise, so
//!   `stt_permission` / `stt_request_permission` report `true` and a denial
//!   shows up at `stt_start` instead.
//! - Errors are plain strings with the same `CODE` / `CODE:detail` shape as
//!   the Android bridge; `src/core/dictation-errors.ts` maps them to messages.
//! - WinRT needs an initialized apartment; every command hops onto a blocking
//!   thread and `ensure_winrt` there (shared with `ocr.rs`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use windows::core::{Ref, HRESULT};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs,
    SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
    SpeechRecognitionResultStatus, SpeechRecognizer,
};

use super::ocr::ensure_winrt;

/// `SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED`: "Online speech recognition" is off.
const HR_PRIVACY_POLICY: HRESULT = HRESULT(0x8004_5509_u32 as i32);
/// `E_ACCESSDENIED`: microphone access for desktop apps is turned off.
const HR_ACCESS_DENIED: HRESULT = HRESULT(0x8007_0005_u32 as i32);

/// How long a dictation may sit silent before Windows ends it on its own —
/// both before the first word (the recognizer's initial-silence timeout, ~5 s
/// by default, which would end a note while the user gathers their thoughts)
/// and between phrases. The two-tap UI means the user decides when a note is
/// done, so this is only a backstop. (TimeSpan = 100 ns ticks.)
const AUTO_STOP_SILENCE: TimeSpan = TimeSpan {
    Duration: 10 * 60 * 10_000_000,
};
/// Upper bound on a whole session.
const MAX_SESSION: Duration = Duration::from_secs(15 * 60);
/// How long `StartAsync` may take before the session is given up on.
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// After a stop request, how long Windows gets to finish the phrase in flight
/// and report `Completed` before the session is cancelled.
const STOP_GRACE: Duration = Duration::from_secs(4);

/// What wakes the dictation thread's wait loop.
enum Wake {
    /// `StartAsync` settled.
    Started(Result<(), String>),
    /// The session's `Completed` event fired.
    Completed(SpeechRecognitionResultStatus),
    /// `stt_stop` (the second tap, or closing the sheet) asked it to finish.
    Stop,
}

/// The session in flight. `stt_stop` (a separate IPC call) only posts
/// [`Wake::Stop`] through `wake`; every WinRT call on the session stays on
/// the dictation thread, so a stop can never block on Windows.
struct Active {
    id: u64,
    wake: Sender<Wake>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn active() -> MutexGuard<'static, Option<Active>> {
    // A panic while holding the lock can't leave the Option half-written.
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Map a WinRT failure onto the bridge's error vocabulary.
fn hr_error(e: &windows::core::Error) -> String {
    if e.code() == HR_PRIVACY_POLICY {
        "STT_PRIVACY".to_string()
    } else if e.code() == HR_ACCESS_DENIED {
        "PERMISSION_DENIED".to_string()
    } else {
        format!("STT_FAILED:{e}")
    }
}

/// The error code for a session/compilation status that produced no text.
fn status_error(status: SpeechRecognitionResultStatus) -> String {
    match status {
        SpeechRecognitionResultStatus::MicrophoneUnavailable => "STT_NO_MIC".to_string(),
        SpeechRecognitionResultStatus::NetworkFailure => "STT_NETWORK".to_string(),
        SpeechRecognitionResultStatus::TopicLanguageNotSupported
        | SpeechRecognitionResultStatus::GrammarLanguageMismatch => "STT_LANGUAGE".to_string(),
        SpeechRecognitionResultStatus::AudioQualityFailure => "STT_AUDIO_QUALITY".to_string(),
        SpeechRecognitionResultStatus::Success
        | SpeechRecognitionResultStatus::UserCanceled
        | SpeechRecognitionResultStatus::TimeoutExceeded
        | SpeechRecognitionResultStatus::PauseLimitExceeded => "STT_NO_MATCH".to_string(),
        other => format!("STT_ERROR:{}", other.0),
    }
}

/// Join recognized phrases into one transcript, dropping blanks.
fn join_phrases(phrases: &[String]) -> String {
    phrases
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A session left over from an abandoned capture: ask it to stop and wait for
/// it to wind down, rather than refusing the new capture with `STT_BUSY`.
fn end_previous_session() -> Result<(), String> {
    let wake = active().as_ref().map(|a| a.wake.clone());
    let Some(wake) = wake else {
        return Ok(());
    };
    let _ = wake.send(Wake::Stop);
    let until = Instant::now() + STOP_GRACE + Duration::from_secs(2);
    while Instant::now() < until {
        if active().is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("STT_BUSY".to_string())
}

/// Run one continuous dictation session to completion; returns the transcript.
fn dictate() -> Result<String, String> {
    ensure_winrt();
    end_previous_session()?;
    let recognizer = SpeechRecognizer::new().map_err(|_| "STT_UNAVAILABLE".to_string())?;
    let result = run_session(&recognizer);
    let _ = recognizer.Close();
    result
}

fn run_session(recognizer: &SpeechRecognizer) -> Result<String, String> {
    if let Ok(timeouts) = recognizer.Timeouts() {
        let _ = timeouts.SetInitialSilenceTimeout(AUTO_STOP_SILENCE);
    }
    // No constraints added = the default free-dictation grammar.
    let compiled = recognizer
        .CompileConstraintsAsync()
        .and_then(|op| op.get())
        .map_err(|e| hr_error(&e))?;
    let compiled_status = compiled.Status().map_err(|e| hr_error(&e))?;
    if compiled_status != SpeechRecognitionResultStatus::Success {
        return Err(status_error(compiled_status));
    }

    let session = recognizer
        .ContinuousRecognitionSession()
        .map_err(|e| hr_error(&e))?;
    session
        .SetAutoStopSilenceTimeout(AUTO_STOP_SILENCE)
        .map_err(|e| hr_error(&e))?;

    let phrases = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&phrases);
    let result_token = session
        .ResultGenerated(&TypedEventHandler::new(
            move |_: Ref<SpeechContinuousRecognitionSession>,
                  args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let result = args.Result()?;
                    if result.Status()? == SpeechRecognitionResultStatus::Success {
                        let text = result.Text()?.to_string();
                        sink.lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(text);
                    }
                }
                Ok(())
            },
        ))
        .map_err(|e| hr_error(&e))?;

    let (wake_tx, wake_rx) = mpsc::channel::<Wake>();
    let done_tx = wake_tx.clone();
    let done_token = session
        .Completed(&TypedEventHandler::new(
            move |_: Ref<SpeechContinuousRecognitionSession>,
                  args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
                let status = match args.as_ref() {
                    Some(args) => args.Status()?,
                    None => SpeechRecognitionResultStatus::Unknown,
                };
                let _ = done_tx.send(Wake::Completed(status));
                Ok(())
            },
        ))
        .map_err(|e| hr_error(&e))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let registered = {
        let mut slot = active();
        if slot.is_some() {
            false
        } else {
            *slot = Some(Active {
                id,
                wake: wake_tx.clone(),
            });
            true
        }
    };
    let outcome = if registered {
        wait_for_session(&session, &wake_tx, &wake_rx)
    } else {
        Err("STT_BUSY".to_string())
    };
    {
        let mut slot = active();
        if slot.as_ref().is_some_and(|a| a.id == id) {
            *slot = None;
        }
    }
    let _ = session.RemoveResultGenerated(result_token);
    let _ = session.RemoveCompleted(done_token);

    let status = outcome?;
    let transcript = join_phrases(
        &phrases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
    // Whatever was recognized before a late failure (a network drop mid-note)
    // is still the user's words — keep it rather than throw it away.
    if transcript.is_empty() {
        Err(status_error(status))
    } else {
        Ok(transcript)
    }
}

/// Start the session and wait until it completes, a stop is honoured, or a
/// timeout fires. Nothing here can block forever.
fn wait_for_session(
    session: &SpeechContinuousRecognitionSession,
    wake_tx: &Sender<Wake>,
    wake_rx: &Receiver<Wake>,
) -> Result<SpeechRecognitionResultStatus, String> {
    let begun = Instant::now();
    let start = session.StartAsync().map_err(|e| hr_error(&e))?;
    // Awaited off-thread, so a stop still gets through if it never settles.
    let started_tx = wake_tx.clone();
    std::thread::spawn(move || {
        ensure_winrt();
        let _ = started_tx.send(Wake::Started(start.get().map_err(|e| hr_error(&e))));
    });

    let mut started = false;
    let mut stop_by: Option<Instant> = None;
    loop {
        let limit = match (started, stop_by) {
            (_, Some(deadline)) => deadline,
            (false, None) => begun + START_TIMEOUT,
            (true, None) => begun + MAX_SESSION,
        };
        match wake_rx.recv_timeout(limit.saturating_duration_since(Instant::now())) {
            Ok(Wake::Started(Ok(()))) => {
                started = true;
                if stop_by.is_some() {
                    request_stop(session);
                }
            }
            Ok(Wake::Started(Err(code))) => return Err(code),
            Ok(Wake::Completed(status)) => return Ok(status),
            Ok(Wake::Stop) => {
                if stop_by.is_none() {
                    stop_by = Some(Instant::now() + STOP_GRACE);
                    if started {
                        request_stop(session);
                    }
                }
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                let _ = session.CancelAsync();
                return match (started, stop_by) {
                    // Stopped, but Windows never reported back: keep what was heard.
                    (_, Some(_)) => Ok(SpeechRecognitionResultStatus::Success),
                    (false, None) => Err("STT_START_TIMEOUT".to_string()),
                    (true, None) => Ok(SpeechRecognitionResultStatus::TimeoutExceeded),
                };
            }
        }
    }
}

/// Ask Windows to finish the phrase in flight and end the session. Not
/// awaited: `Completed` (or the stop grace) ends the wait loop.
fn request_stop(session: &SpeechContinuousRecognitionSession) {
    if session.StopAsync().is_err() {
        let _ = session.CancelAsync();
    }
}

/// Ask the session in flight (if any) to stop. Only posts a message to the
/// dictation thread, so it returns at once.
fn stop_active() {
    if let Some(a) = active().as_ref() {
        let _ = a.wake.send(Wake::Stop);
    }
}

/// Whether the Windows speech engine can be created on this machine.
#[tauri::command]
pub async fn stt_available() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ensure_winrt();
        SpeechRecognizer::new().is_ok()
    })
    .await
    .map_err(|e| format!("STT_JOIN: {e}"))
}

/// Desktop apps have no runtime microphone prompt; a denial surfaces at start.
#[tauri::command]
pub async fn stt_permission() -> Result<bool, String> {
    Ok(true)
}

/// See `stt_permission` — nothing to request on Windows.
#[tauri::command]
pub async fn stt_request_permission() -> Result<bool, String> {
    Ok(true)
}

/// Dictate until `stt_stop` (or the silence backstop); resolves the transcript.
#[tauri::command]
pub async fn stt_start() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(dictate)
        .await
        .map_err(|e| format!("STT_JOIN: {e}"))?
}

/// End the session in flight; its final phrase still lands in `stt_start`'s
/// result, which settles within `STOP_GRACE`.
#[tauri::command]
pub async fn stt_stop() -> Result<(), String> {
    stop_active();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{join_phrases, status_error, SpeechRecognitionResultStatus as S};
    use std::time::{Duration, Instant};

    #[test]
    fn phrases_join_with_single_spaces_and_skip_blanks() {
        let phrases = vec![
            " Ship the pricing change ".to_string(),
            "   ".to_string(),
            "before the demo.".to_string(),
        ];
        assert_eq!(
            join_phrases(&phrases),
            "Ship the pricing change before the demo."
        );
        assert_eq!(join_phrases(&[]), "");
    }

    #[test]
    fn empty_sessions_map_to_actionable_codes() {
        assert_eq!(status_error(S::MicrophoneUnavailable), "STT_NO_MIC");
        assert_eq!(status_error(S::NetworkFailure), "STT_NETWORK");
        assert_eq!(status_error(S::TopicLanguageNotSupported), "STT_LANGUAGE");
        assert_eq!(status_error(S::AudioQualityFailure), "STT_AUDIO_QUALITY");
        // Stopped or timed out with nothing heard = nothing to transcribe.
        assert_eq!(status_error(S::Success), "STT_NO_MATCH");
        assert_eq!(status_error(S::UserCanceled), "STT_NO_MATCH");
        assert_eq!(status_error(S::TimeoutExceeded), "STT_NO_MATCH");
        assert_eq!(status_error(S::Unknown), "STT_ERROR:6");
    }

    /// Real hardware (mic + "Online speech recognition" on); run by hand:
    /// `cargo test --lib dictation -- --ignored --nocapture --test-threads=1`.
    /// Silence past Windows' default 5 s initial-silence timeout, then a stop:
    /// the session must still be live, and the stop must settle quickly.
    #[test]
    #[ignore]
    fn live_session_outlasts_initial_silence_and_stops_promptly() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(super::dictate());
        });
        std::thread::sleep(Duration::from_secs(8));
        assert!(super::active().is_some(), "session ended on its own");
        let stopped = Instant::now();
        super::stop_active();
        let result = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("stt_start never settled after stop");
        eprintln!("result {result:?} after {:?}", stopped.elapsed());
        assert!(stopped.elapsed() < Duration::from_secs(6));
        assert!(super::active().is_none());
    }

    /// A second start while a session is live ends the first one instead of
    /// failing with STT_BUSY. Same hardware requirements as above.
    #[test]
    #[ignore]
    fn a_new_start_ends_a_leftover_session() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(super::dictate());
        });
        std::thread::sleep(Duration::from_secs(3));
        let (tx2, rx2) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx2.send(super::dictate());
        });
        let first = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("leftover session never ended");
        eprintln!("first {first:?}");
        std::thread::sleep(Duration::from_secs(2));
        assert!(super::active().is_some(), "second session didn't start");
        super::stop_active();
        let second = rx2
            .recv_timeout(Duration::from_secs(10))
            .expect("second session never settled");
        assert_ne!(second, Err("STT_BUSY".to_string()));
    }
}
