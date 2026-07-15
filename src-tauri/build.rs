fn main() {
    // Android 15+ can run with 16 KB memory pages, and Google Play now requires
    // apps to support them. Every bundled native `.so` must have its ELF LOAD
    // segments aligned to 16 KB, but the NDK r27 linker still defaults to 4 KB
    // for a plain cargo `cdylib` build (only NDK r28+ / ndk-build / CMake flip
    // the default), which fails the alignment check for `libmd_notepad_lib.so`.
    // Ask lld for a 16 KB max page size. Android only — `-z max-page-size` is an
    // ld/lld option the MSVC and Apple linkers don't understand, and the flag is
    // scoped to the cdylib so it never touches the desktop bin/rlib/staticlib.
    // https://developer.android.com/guide/practices/page-sizes
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
