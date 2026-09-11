//! Whisper model files: the pinned manifest, where they live, and the
//! download / verify / delete commands.
//!
//! Every model is a ggml file from `ggerganov/whisper.cpp` on Hugging Face,
//! pinned here by size and SHA-256 (copied from the repository's LFS
//! pointers). A download streams to `<file>.part` while hashing, and only a
//! matching digest renames it into place — so a file that exists IS a
//! verified file. A mismatch deletes the part; an interrupted download keeps
//! it, and the next attempt resumes with a `Range` request after hashing what
//! is already there. One download at a time.
//!
//! The network is touched only inside `whisper_model_download`, and only
//! because the user clicked Download.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::engine::EngineState;
use super::{WhisperError, WhisperResult};

/// One downloadable model.
pub struct ModelSpec {
    /// Manifest id and the middle of the file name (`ggml-<id>.bin`).
    pub id: &'static str,
    pub label: &'static str,
    pub bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    pub sha256: &'static str,
    /// Detects the spoken language itself; `.en` models are English-only.
    pub multilingual: bool,
    /// A q5 quantized variant.
    pub quantized: bool,
}

impl ModelSpec {
    pub fn file(&self) -> String {
        format!("ggml-{}.bin", self.id)
    }

    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            self.file()
        )
    }

    /// Whisper's language hint: `.en` models are told "en"; the rest auto-detect.
    pub fn language(&self) -> Option<&'static str> {
        if self.multilingual {
            None
        } else {
            Some("en")
        }
    }
}

/// The models the Settings dialog offers. Digests are from the Hugging Face
/// LFS pointers (`…/raw/main/<file>`) as of 2026-09-10.
pub const MANIFEST: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny.en",
        label: "Tiny (English)",
        bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        multilingual: false,
        quantized: false,
    },
    ModelSpec {
        id: "tiny.en-q5_1",
        label: "Tiny (English, quantized)",
        bytes: 32_166_155,
        sha256: "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b",
        multilingual: false,
        quantized: true,
    },
    ModelSpec {
        id: "base.en",
        label: "Base (English)",
        bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        multilingual: false,
        quantized: false,
    },
    ModelSpec {
        id: "base.en-q5_1",
        label: "Base (English, quantized)",
        bytes: 59_721_011,
        sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
        multilingual: false,
        quantized: true,
    },
    ModelSpec {
        id: "small.en",
        label: "Small (English)",
        bytes: 487_614_201,
        sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
        multilingual: false,
        quantized: false,
    },
    ModelSpec {
        id: "small.en-q5_1",
        label: "Small (English, quantized)",
        bytes: 190_098_681,
        sha256: "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30",
        multilingual: false,
        quantized: true,
    },
    ModelSpec {
        id: "medium.en",
        label: "Medium (English)",
        bytes: 1_533_774_781,
        sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
        multilingual: false,
        quantized: false,
    },
    ModelSpec {
        id: "medium.en-q5_0",
        label: "Medium (English, quantized)",
        bytes: 539_225_533,
        sha256: "76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0",
        multilingual: false,
        quantized: true,
    },
    ModelSpec {
        id: "large-v3-turbo",
        label: "Large v3 Turbo (any language)",
        bytes: 1_624_555_275,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        multilingual: true,
        quantized: false,
    },
    ModelSpec {
        id: "large-v3-turbo-q5_0",
        label: "Large v3 Turbo (any language, quantized)",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        multilingual: true,
        quantized: true,
    },
];

/// The manifest entry for an id.
pub fn spec(id: &str) -> WhisperResult<&'static ModelSpec> {
    MANIFEST
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| WhisperError::UnknownModel(id.to_string()))
}

/// `<app_data_dir>/whisper` — the only place this feature writes.
pub fn model_dir(app: &AppHandle) -> WhisperResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("whisper"))
        .map_err(|e| WhisperError::Io(std::io::Error::other(e.to_string())))
}

pub fn model_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(spec.file())
}

fn part_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(format!("{}.part", spec.file()))
}

/// A manifest entry joined with its on-disk state (mirrors `WhisperModelStatus`
/// in src/core/whisper-models.ts).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub file: String,
    pub label: &'static str,
    pub bytes: u64,
    pub multilingual: bool,
    pub quantized: bool,
    pub installed: bool,
    pub partial_bytes: u64,
}

/// The manifest as it stands in `dir`. A file is "installed" when the
/// verified file is present; `.part` bytes are what a resume would keep.
pub fn statuses(dir: &Path) -> Vec<ModelStatus> {
    MANIFEST
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            file: m.file(),
            label: m.label,
            bytes: m.bytes,
            multilingual: m.multilingual,
            quantized: m.quantized,
            installed: model_path(dir, m).is_file(),
            partial_bytes: fs::metadata(part_path(dir, m))
                .map(|meta| meta.len())
                .unwrap_or(0),
        })
        .collect()
}

/* ---- the part writer (testable without HTTP) --------------------------- */

/// Streams a download into `<file>.part` while hashing it, and turns the
/// part into the final file only on a matching digest.
pub struct PartWriter {
    part: PathBuf,
    file: File,
    hasher: Sha256,
    written: u64,
}

impl PartWriter {
    /// Open the part for appending. Whatever is already there is hashed
    /// first, so a resumed download continues the digest where it left off.
    pub fn open(part: &Path) -> std::io::Result<Self> {
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        if let Ok(mut existing) = File::open(part) {
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = existing.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                written += n as u64;
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(part)?;
        Ok(Self {
            part: part.to_path_buf(),
            file,
            hasher,
            written,
        })
    }

    /// Throw the part away and start over (the server ignored our Range).
    pub fn restart(self) -> std::io::Result<Self> {
        let part = self.part.clone();
        drop(self);
        let _ = fs::remove_file(&part);
        Self::open(&part)
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn write(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        self.file.write_all(chunk)?;
        self.hasher.update(chunk);
        self.written += chunk.len() as u64;
        Ok(())
    }

    /// fsync, compare the digest, and rename into place — or delete the part
    /// and report `DownloadCorrupt` so a bad file never lingers as a resume.
    pub fn finish(self, final_path: &Path, expected_sha256: &str) -> WhisperResult<()> {
        self.file.sync_all()?;
        drop(self.file);
        let digest = hex(&self.hasher.finalize());
        if !digest.eq_ignore_ascii_case(expected_sha256) {
            let _ = fs::remove_file(&self.part);
            return Err(WhisperError::DownloadCorrupt);
        }
        // A stale final file (a previous install of the same model) may sit
        // there; Windows refuses to rename over it.
        if final_path.exists() {
            fs::remove_file(final_path)?;
        }
        fs::rename(&self.part, final_path)?;
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/* ---- commands ----------------------------------------------------------- */

/// The one download allowed at a time, and its cancel flag.
#[derive(Default)]
pub struct DownloadState {
    active: Mutex<Option<String>>,
    cancel: AtomicBool,
}

/// Holds the download slot; releases it however the download ends — a panic
/// in the async task (the future is dropped) must not wedge the slot into
/// "busy" for the rest of the session.
struct SlotGuard<'a>(&'a DownloadState);

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// reqwest is built with `rustls-no-provider` (the updater's choice), so the
/// process needs a crypto provider installed before the first client. The
/// updater installs ring only when it runs; a download may come first.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// What the frontend's progress channel receives. The command itself
/// resolves on success and rejects on failure or cancellation.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { received: u64, total: u64 },
    Verifying,
}

/// The manifest joined with what is on disk.
#[tauri::command]
pub async fn whisper_models_list(app: AppHandle) -> WhisperResult<Vec<ModelStatus>> {
    let dir = model_dir(&app)?;
    Ok(statuses(&dir))
}

/// Where the model files live, for the Settings dialog's "Open folder".
#[tauri::command]
pub async fn whisper_model_dir(app: AppHandle) -> WhisperResult<String> {
    let dir = model_dir(&app)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Download (or resume) one model. Progress arrives on `on_progress` at most
/// every ~200 ms; rejects `WHISPER_DOWNLOAD_BUSY` while another runs.
#[tauri::command]
pub async fn whisper_model_download(
    app: AppHandle,
    state: State<'_, DownloadState>,
    id: String,
    on_progress: Channel<DownloadEvent>,
) -> WhisperResult<()> {
    let spec = spec(&id)?;
    {
        let mut active = state.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return Err(WhisperError::DownloadBusy);
        }
        *active = Some(id.clone());
    }
    let _slot = SlotGuard(&state);
    state.cancel.store(false, Ordering::SeqCst);
    download(&app, spec, &state.cancel, &on_progress).await
}

/// Stop the running download at the next chunk. The part stays for a resume.
#[tauri::command]
pub async fn whisper_model_cancel(state: State<'_, DownloadState>) -> WhisperResult<()> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Remove a model file (and any part), unloading it if it is the loaded one.
#[tauri::command]
pub async fn whisper_model_delete(
    app: AppHandle,
    engine: State<'_, EngineState>,
    id: String,
) -> WhisperResult<()> {
    let spec = spec(&id)?;
    let dir = model_dir(&app)?;
    let path = model_path(&dir, spec);
    engine.unload_if(&path);
    remove_if_exists(&path)?;
    remove_if_exists(&part_path(&dir, spec))?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

const PROGRESS_EVERY: Duration = Duration::from_millis(200);

async fn download(
    app: &AppHandle,
    spec: &'static ModelSpec,
    cancel: &AtomicBool,
    progress: &Channel<DownloadEvent>,
) -> WhisperResult<()> {
    let dir = model_dir(app)?;
    fs::create_dir_all(&dir)?;
    let part = part_path(&dir, spec);
    let final_path = model_path(&dir, spec);

    // Hashing a large leftover part is real work — off the async runtime.
    let open_part = part.clone();
    let mut writer = tauri::async_runtime::spawn_blocking(move || PartWriter::open(&open_part))
        .await
        .map_err(|e| WhisperError::DownloadFailed(e.to_string()))??;

    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .user_agent(concat!("md-notepad/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| WhisperError::DownloadFailed(e.to_string()))?;
    let mut request = client.get(spec.url());
    if writer.written() > 0 {
        request = request.header(reqwest::header::RANGE, range_header(writer.written()));
    }
    let response = request
        .send()
        .await
        .map_err(|e| WhisperError::DownloadFailed(e.to_string()))?;

    match response.status().as_u16() {
        // Resumed where we asked.
        206 => {}
        // The server sent the whole file (no Range, or it ignored ours).
        200 => {
            if writer.written() > 0 {
                writer = writer.restart()?;
            }
        }
        // Our part is already as long as (or longer than) the file: it can
        // only be verified, never continued. Start over.
        416 => {
            drop(writer.restart()?);
            return Box::pin(download(app, spec, cancel, progress)).await;
        }
        status => {
            return Err(WhisperError::DownloadFailed(format!("HTTP {status}")));
        }
    }

    let total = spec.bytes;
    let mut stream = response.bytes_stream();
    let mut last = Instant::now();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(WhisperError::DownloadCancelled);
        }
        let chunk = chunk.map_err(|e| WhisperError::DownloadFailed(e.to_string()))?;
        writer.write(&chunk)?;
        if last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            let _ = progress.send(DownloadEvent::Progress {
                received: writer.written(),
                total,
            });
        }
    }
    let _ = progress.send(DownloadEvent::Progress {
        received: writer.written(),
        total,
    });
    let _ = progress.send(DownloadEvent::Verifying);

    tauri::async_runtime::spawn_blocking(move || writer.finish(&final_path, spec.sha256))
        .await
        .map_err(|e| WhisperError::DownloadFailed(e.to_string()))?
}

/// `bytes=<offset>-`: continue from what the part already holds.
pub fn range_header(offset: u64) -> String {
    format!("bytes={offset}-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn sha256_hex(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    #[test]
    fn manifest_is_well_formed() {
        let mut ids = HashSet::new();
        for m in MANIFEST {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.sha256.len(), 64, "{}: digest length", m.id);
            assert!(
                m.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: digest hex",
                m.id
            );
            assert!(m.bytes > 1_000_000, "{}: size", m.id);
            assert_eq!(m.file(), format!("ggml-{}.bin", m.id));
            assert!(m.url().ends_with(&m.file()));
            assert_eq!(m.quantized, m.id.contains("-q"), "{}: quantized flag", m.id);
            assert_eq!(m.multilingual, !m.id.contains(".en"), "{}: language", m.id);
        }
        assert!(spec("small.en").is_ok());
        assert!(matches!(
            spec("huge.xx"),
            Err(WhisperError::UnknownModel(id)) if id == "huge.xx"
        ));
        assert_eq!(spec("small.en").unwrap().language(), Some("en"));
        assert_eq!(spec("large-v3-turbo").unwrap().language(), None);
    }

    #[test]
    fn matching_digest_renames_part_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("ggml-x.bin.part");
        let final_path = dir.path().join("ggml-x.bin");
        let payload = b"hello whisper".repeat(1000);

        let mut w = PartWriter::open(&part).unwrap();
        w.write(&payload[..500]).unwrap();
        w.write(&payload[500..]).unwrap();
        assert_eq!(w.written(), payload.len() as u64);
        w.finish(&final_path, &sha256_hex(&payload)).unwrap();

        assert!(!part.exists());
        assert_eq!(fs::read(&final_path).unwrap(), payload);
    }

    #[test]
    fn mismatching_digest_deletes_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("ggml-x.bin.part");
        let final_path = dir.path().join("ggml-x.bin");

        let mut w = PartWriter::open(&part).unwrap();
        w.write(b"not the bytes you pinned").unwrap();
        let err = w.finish(&final_path, &"0".repeat(64)).unwrap_err();
        assert!(matches!(err, WhisperError::DownloadCorrupt));
        assert!(!part.exists());
        assert!(!final_path.exists());
    }

    #[test]
    fn a_reopened_part_resumes_the_digest_and_asks_for_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("ggml-x.bin.part");
        let final_path = dir.path().join("ggml-x.bin");
        let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();

        let mut w = PartWriter::open(&part).unwrap();
        w.write(&payload[..40_000]).unwrap();
        drop(w); // "connection lost"

        let mut w = PartWriter::open(&part).unwrap();
        assert_eq!(w.written(), 40_000);
        assert_eq!(range_header(w.written()), "bytes=40000-");
        w.write(&payload[40_000..]).unwrap();
        w.finish(&final_path, &sha256_hex(&payload)).unwrap();
        assert_eq!(fs::read(&final_path).unwrap(), payload);
    }

    #[test]
    fn restart_throws_the_part_away() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("ggml-x.bin.part");
        let mut w = PartWriter::open(&part).unwrap();
        w.write(b"stale").unwrap();
        let w = w.restart().unwrap();
        assert_eq!(w.written(), 0);
        assert_eq!(fs::metadata(&part).unwrap().len(), 0);
    }

    #[test]
    fn finish_replaces_a_stale_final_file() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("ggml-x.bin.part");
        let final_path = dir.path().join("ggml-x.bin");
        fs::write(&final_path, b"old").unwrap();
        let mut w = PartWriter::open(&part).unwrap();
        w.write(b"new").unwrap();
        w.finish(&final_path, &sha256_hex(b"new")).unwrap();
        assert_eq!(fs::read(&final_path).unwrap(), b"new");
    }

    #[test]
    fn statuses_reflect_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let small = spec("small.en").unwrap();
        fs::write(model_path(dir.path(), small), b"x").unwrap();
        fs::write(part_path(dir.path(), spec("base.en").unwrap()), b"12345").unwrap();

        let list = statuses(dir.path());
        assert_eq!(list.len(), MANIFEST.len());
        let by_id = |id: &str| list.iter().find(|s| s.id == id).unwrap();
        assert!(by_id("small.en").installed);
        assert_eq!(by_id("small.en").partial_bytes, 0);
        assert!(!by_id("base.en").installed);
        assert_eq!(by_id("base.en").partial_bytes, 5);
        assert!(!by_id("tiny.en").installed);
        assert_eq!(by_id("tiny.en").file, "ggml-tiny.en.bin");
    }

    #[test]
    fn download_events_serialize_tagged() {
        let json = serde_json::to_value(DownloadEvent::Progress {
            received: 1,
            total: 2,
        })
        .unwrap();
        assert_eq!(json["kind"], "progress");
        assert_eq!(json["received"], 1);
        let json = serde_json::to_value(DownloadEvent::Verifying).unwrap();
        assert_eq!(json["kind"], "verifying");
    }
}
