//! "Is this installed?" for the frontend: where a list of program names
//! resolve on `PATH`, or that they do not.
//!
//! The Settings dialog asks this for every AI TUI agent it lists (and for the
//! package managers an install would need), so it can dim the agents the user
//! cannot launch and offer an **Install** button beside them. Desktop-only,
//! like the pty the answer is for — Android has no `PATH` worth scanning and
//! never shows those rows.
//!
//! No policy lives here: which names to ask about and what a `None` means are
//! the frontend's (src/ui/stores/tui-availability.ts). The scan itself is
//! `crate::shell::find_program`, shared with the default-shell probe.

use std::collections::HashMap;

/// Each name → its resolved path, or `None` when nothing on `PATH` (or at the
/// given path, for a name with directories) is a file by that name. Every
/// requested name is present in the answer, so the caller never has to treat
/// a missing key as a third state.
///
/// `async` so the directory walk runs off the main thread: `PATH` on a
/// developer machine is dozens of entries, and this is called with several
/// names at once.
#[tauri::command]
pub async fn find_programs(names: Vec<String>) -> HashMap<String, Option<String>> {
    resolve_all(names, |name| {
        crate::shell::find_program(name).map(|p| p.to_string_lossy().into_owned())
    })
}

/// The command's shape, with the lookup injected so a test can pin the
/// contract (every name answered, duplicates collapsed) without depending on
/// what the build machine has installed.
fn resolve_all(
    names: Vec<String>,
    find: impl Fn(&str) -> Option<String>,
) -> HashMap<String, Option<String>> {
    names
        .into_iter()
        .map(|name| {
            let found = find(&name);
            (name, found)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_all;

    #[test]
    fn answers_every_name_asked_with_none_for_the_unknown() {
        let names = vec!["npm".to_string(), "nope".to_string(), "npm".to_string()];
        let found = resolve_all(names, |name| {
            (name == "npm").then(|| "/usr/bin/npm".to_string())
        });
        assert_eq!(found.len(), 2);
        assert_eq!(found["npm"].as_deref(), Some("/usr/bin/npm"));
        assert_eq!(found["nope"], None);
    }

    /// The real lookup, end to end, for a name nothing could plausibly have.
    #[test]
    fn real_lookup_reports_a_missing_program_as_none() {
        let found = tauri::async_runtime::block_on(super::find_programs(vec![
            "definitely-not-a-program-7f3a".to_string(),
        ]));
        assert_eq!(found["definitely-not-a-program-7f3a"], None);
    }
}
