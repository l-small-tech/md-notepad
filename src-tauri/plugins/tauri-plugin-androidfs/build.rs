// No JS-facing commands: the app calls this plugin from Rust via the
// AndroidfsExt trait (run_mobile_plugin), so no invoke permissions are needed.
// The build step still runs to register the Android library project (android_path)
// so `tauri android build` wires the Kotlin plugin into gen/android's gradle.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
