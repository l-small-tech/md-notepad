//! Offline voice-note transcription with whisper.cpp (desktop only).
//!
//! Two halves, each its own file:
//! - `models` — the pinned model manifest (Hugging Face files + SHA-256
//!   digests), where they live on disk, and the download / verify / delete
//!   commands. Nothing is fetched unless the user clicks Download.
//! - `engine` — the loaded `WhisperContext` (one per session, reloaded when
//!   the chosen file changes) and the `whisper_transcribe` command, which
//!   takes raw f32 PCM as the request body and answers with the transcript.
//!
//! Audio never touches disk: the frontend captures PCM into memory, sends it
//! over the binary IPC channel, and it is dropped once transcribed. Rust knows
//! nothing about notes or lines (rule I5) — it turns samples into text.
//!
//! Errors cross IPC as `{ code, message }` like `FsError`; the TS mirror of
//! the codes lives in `src/ipc/commands.ts` — keep both in sync.

pub mod engine;
pub mod models;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum WhisperError {
    #[error("unknown whisper model: {0}")]
    UnknownModel(String),
    #[error("whisper model not downloaded: {0}")]
    NoModel(String),
    #[error("whisper model file is corrupt: {0}")]
    ModelCorrupt(String),
    #[error("whisper model could not be loaded: {0}")]
    LoadFailed(String),
    #[error("transcription failed: {0}")]
    Failed(String),
    #[error("download failed: {0}")]
    DownloadFailed(String),
    #[error("downloaded file did not match its digest")]
    DownloadCorrupt,
    #[error("download cancelled")]
    DownloadCancelled,
    #[error("another download is already running")]
    DownloadBusy,
    #[error("invalid data: {0}")]
    InvalidData(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl WhisperError {
    pub fn code(&self) -> &'static str {
        match self {
            WhisperError::UnknownModel(_) => "WHISPER_UNKNOWN_MODEL",
            WhisperError::NoModel(_) => "WHISPER_NO_MODEL",
            WhisperError::ModelCorrupt(_) => "WHISPER_MODEL_CORRUPT",
            WhisperError::LoadFailed(_) => "WHISPER_LOAD_FAILED",
            WhisperError::Failed(_) => "WHISPER_FAILED",
            WhisperError::DownloadFailed(_) => "WHISPER_DOWNLOAD_FAILED",
            WhisperError::DownloadCorrupt => "WHISPER_DOWNLOAD_CORRUPT",
            WhisperError::DownloadCancelled => "WHISPER_DOWNLOAD_CANCELLED",
            WhisperError::DownloadBusy => "WHISPER_DOWNLOAD_BUSY",
            WhisperError::InvalidData(_) => "INVALID_DATA",
            WhisperError::Io(_) => "IO",
        }
    }
}

impl Serialize for WhisperError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("WhisperError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type WhisperResult<T> = Result<T, WhisperError>;

#[cfg(test)]
mod tests {
    use super::WhisperError;

    #[test]
    fn errors_serialize_as_code_and_message() {
        let json = serde_json::to_value(WhisperError::NoModel("small.en".into())).unwrap();
        assert_eq!(json["code"], "WHISPER_NO_MODEL");
        assert!(json["message"].as_str().unwrap().contains("small.en"));
        let json = serde_json::to_value(WhisperError::DownloadCorrupt).unwrap();
        assert_eq!(json["code"], "WHISPER_DOWNLOAD_CORRUPT");
    }
}
