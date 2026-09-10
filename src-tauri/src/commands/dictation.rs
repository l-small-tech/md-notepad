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
//!   the Android bridge; `src/ui/voice-comments.ts` maps them to messages.
//! - WinRT needs an initialized apartment; every command hops onto a blocking
//!   thread and `ensure_winrt` there (shared with `ocr.rs`).

use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

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

/// How long a dictation may sit silent before Windows ends it on its own. The
/// two-tap UI means the user decides when a note is done, so this is only a
/// backstop against a session left running forever. (TimeSpan = 100 ns ticks.)
const AUTO_STOP_SILENCE: TimeSpan = TimeSpan {
    Duration: 10 * 60 * 10_000_000,
};
/// Upper bound on waiting for the session's `Completed` event.
const MAX_SESSION: Duration = Duration::from_secs(15 * 60);

/// The session in flight, so `stt_stop` (a separate IPC call) can end it.
static ACTIVE: Mutex<Option<SpeechContinuousRecognitionSession>> = Mutex::new(None);

fn active() -> MutexGuard<'static, Option<SpeechContinuousRecognitionSession>> {
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

/// Run one continuous dictation session to completion; returns the transcript.
fn dictate() -> Result<String, String> {
    ensure_winrt();
    if active().is_some() {
        return Err("STT_BUSY".to_string());
    }
    let recognizer = SpeechRecognizer::new().map_err(|_| "STT_UNAVAILABLE".to_string())?;
    // No constraints added = the default free-dictation grammar.
    let compiled = recognizer
        .CompileConstraintsAsync()
        .and_then(|op| op.get())
        .map_err(|e| hr_error(&e))?;
    let compiled_status = compiled.Status().map_err(|e| hr_error(&e))?;
    if compiled_status != SpeechRecognitionResultStatus::Success {
        let _ = recognizer.Close();
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

    let (done_tx, done_rx) = mpsc::channel::<SpeechRecognitionResultStatus>();
    let done_token = session
        .Completed(&TypedEventHandler::new(
            move |_: Ref<SpeechContinuousRecognitionSession>,
                  args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
                let status = match args.as_ref() {
                    Some(args) => args.Status()?,
                    None => SpeechRecognitionResultStatus::Unknown,
                };
                let _ = done_tx.send(status);
                Ok(())
            },
        ))
        .map_err(|e| hr_error(&e))?;

    *active() = Some(session.clone());
    let started = session.StartAsync().and_then(|action| action.get());
    let status = match started {
        Ok(()) => done_rx
            .recv_timeout(MAX_SESSION)
            .unwrap_or(SpeechRecognitionResultStatus::TimeoutExceeded),
        Err(e) => {
            *active() = None;
            let _ = session.RemoveResultGenerated(result_token);
            let _ = session.RemoveCompleted(done_token);
            let _ = recognizer.Close();
            return Err(hr_error(&e));
        }
    };

    *active() = None;
    let _ = session.RemoveResultGenerated(result_token);
    let _ = session.RemoveCompleted(done_token);
    let _ = recognizer.Close();

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

/// End the session in flight; its final phrase still lands in `stt_start`'s result.
#[tauri::command]
pub async fn stt_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        ensure_winrt();
        let session = active().clone();
        if let Some(session) = session {
            session
                .StopAsync()
                .and_then(|action| action.get())
                .map_err(|e| hr_error(&e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("STT_JOIN: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{join_phrases, status_error, SpeechRecognitionResultStatus as S};

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
}
