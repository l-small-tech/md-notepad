//! Windows-only OCR over the cleaned scan raster, via `Windows.Media.Ocr` —
//! the on-device WinRT engine that ships with Windows 10/11. This is what
//! keeps the phase-7 "desktop reports unavailable" path honest on the one
//! desktop OS that actually has a system recognizer: no network, no model
//! download, no new crate beyond `windows` (already in the tree via tauri).
//!
//! Contract notes:
//! - Input is the PNG the scan pipeline composed (black ink on white), so the
//!   engine sees maximum contrast. Boxes come back in the pixel space of that
//!   image; when the engine's `MaxImageDimension` forces a downscale, the
//!   boxes are mapped back to the caller's pixels before returning.
//! - `Windows.Media.Ocr` reports NO per-line confidence. The frontend records
//!   `null` — an honest absence, never an invented number.
//! - The engine is a printed-text model: fine on block capitals, weak on
//!   cursive. That is the deal on this platform and the metadata names the
//!   engine so a consumer can weigh it.
//! - WinRT needs an initialized apartment; commands hop onto a blocking
//!   thread and `RoInitialize` there rather than trusting the IPC thread.

use base64::Engine as _;
use serde::Serialize;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

#[derive(Serialize)]
pub struct OcrLineOut {
    pub text: String,
    /// Always `None` on Windows — the engine does not report one.
    pub confidence: Option<f64>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
pub struct OcrOut {
    pub engine: String,
    pub lines: Vec<OcrLineOut>,
}

fn ensure_winrt() {
    // S_FALSE (already initialized) and RPC_E_CHANGED_MODE (the thread is an
    // STA) are both fine: in either case WinRT calls will proceed.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

fn decode_to_bitmap(png: &[u8]) -> windows::core::Result<(SoftwareBitmap, f64)> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(png)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    writer.DetachStream()?;
    stream.Seek(0)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let width = decoder.PixelWidth()?;
    let height = decoder.PixelHeight()?;
    let max = OcrEngine::MaxImageDimension()?;
    let long_edge = width.max(height);

    if long_edge <= max {
        let bitmap = decoder
            .GetSoftwareBitmapConvertedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Premultiplied,
            )?
            .get()?;
        return Ok((bitmap, 1.0));
    }

    // The scan's Detailed preset (3600 px) can exceed the engine cap (2600 on
    // every Windows build seen so far): downscale with Fant and report the
    // factor so line boxes map back to the caller's pixels.
    let scale = max as f64 / long_edge as f64;
    let transform = BitmapTransform::new()?;
    transform.SetScaledWidth((width as f64 * scale).round().max(1.0) as u32)?;
    transform.SetScaledHeight((height as f64 * scale).round().max(1.0) as u32)?;
    transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .get()?;
    Ok((bitmap, scale))
}

fn recognize_png(png: &[u8]) -> windows::core::Result<Vec<OcrLineOut>> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let (bitmap, scale) = decode_to_bitmap(png)?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;

    let mut lines = Vec::new();
    for line in result.Lines()? {
        let text = line.Text()?.to_string();
        if text.trim().is_empty() {
            continue;
        }
        // The line box is the union of its word boxes, back in source pixels.
        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;
        for word in line.Words()? {
            let rect = word.BoundingRect()?;
            min_x = min_x.min(rect.X as f64);
            min_y = min_y.min(rect.Y as f64);
            max_x = max_x.max((rect.X + rect.Width) as f64);
            max_y = max_y.max((rect.Y + rect.Height) as f64);
        }
        if min_x > max_x {
            continue;
        }
        lines.push(OcrLineOut {
            text,
            confidence: None,
            x: min_x / scale,
            y: min_y / scale,
            width: (max_x - min_x) / scale,
            height: (max_y - min_y) / scale,
        });
    }
    Ok(lines)
}

// NOTE: an `InkAnalyzer` (OS handwriting engine) command lived here briefly
// and was removed after offline probing against a real board's traced
// strokes: centerline skeletons carry none of the pen dynamics the engine
// depends on, and it returned confident junk at every scale and grouping.
// Evidence in whiteboard-plan.md phase 7 — bring new evidence before
// reintroducing it.

/// True when a user-profile OCR language pack is installed. `TryCreate…`
/// returns a null engine (surfaced as Err by windows-rs) when none is.
#[tauri::command]
pub async fn ocr_image_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        ensure_winrt();
        OcrEngine::TryCreateFromUserProfileLanguages().is_ok()
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn ocr_image_recognize(png_base64: String) -> Result<OcrOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_winrt();
        let png = base64::engine::general_purpose::STANDARD
            .decode(png_base64.as_bytes())
            .map_err(|e| format!("BAD_BASE64: {e}"))?;
        let lines = recognize_png(&png).map_err(|e| format!("OCR_FAILED: {e}"))?;
        Ok(OcrOut {
            engine: "windows-ocr".to_string(),
            lines,
        })
    })
    .await
    .map_err(|e| format!("OCR_JOIN: {e}"))?
}
