# Manual QA checklists

Execute the section for the milestone you just built, on your dev OS, in a
real `npm run tauri dev` session (release-build checks are called out
explicitly). Check every box in the milestone's PR/commit message. The full
3-OS sweep happens at M7.

Conventions: "kill" = hard-kill the process (Task Manager / `taskkill /f
/im md-notepad.exe` / `kill -9`), never a graceful quit. `notesDir` and
`sessionDir` per your platform (see root README table; session dir is the
sibling `session/` folder).

## M1 — Shell

- [ ] Launch → single tab "Untitled", caret in the editor, no console errors.
- [ ] Type `# Grocery list` → tab title becomes "Grocery list" (no `#`),
      window title "Grocery list — MD Notepad". Delete the line → back to
      "Untitled".
- [ ] Type `-> => != >= <=` → each renders as a single ligature glyph.
      Arrow keys step through the ligature's underlying characters.
- [ ] Markdown highlighting: heading, `**bold**`, `` `code` ``, link, list
      markers each styled distinctly.
- [ ] Ctrl+F opens CM6 search inside the editor; Esc closes it.
- [ ] Create 10 tabs, put distinct text + scroll positions in each, switch
      rapidly (mouse + Ctrl+Tab): cursor/selection/scroll are per-tab, no
      flicker, no cross-tab bleed.
- [ ] F2 rename to "My Ideas" → title stops following the first line;
      renaming to empty string reverts to auto-derive.
- [ ] Middle-click closes a tab; Ctrl+W closes the active tab; closing the
      last tab leaves one fresh "Untitled" (Notepad behavior).
- [ ] Mode segment: raw⇄split⇄wysiwyg switch shows the honest "coming in
      M4/M5" pane and switches back losslessly.
- [ ] OS dark mode on launch → dark theme; flip OS theme while running →
      app follows live (editor included).
- [ ] Resize window small (400×300): layout stays usable, no overflow.

## M2 — Session persistence

- [ ] Fresh start (delete notesDir + sessionDir first): type "Buy milk" in
      a new tab → within 5s `notesDir/buy-milk.md` exists with the content.
- [ ] **Kill drill**: type continuously for ~10s, kill the process
      mid-typing, relaunch → all tabs restored (order, active tab, cursor
      position), text loss ≤ ~5s of typing.
- [ ] Change the first line to "Weekend plan" → after the next flush the
      file is `weekend-plan.md`, `buy-milk.md` is gone.
- [ ] Two tabs both titled "Idea" → `idea.md` + `idea-2.md`; both survive
      restart with correct contents.
- [ ] Empty new tab, restart → tab restored, still no file in notesDir.
- [ ] Close a non-empty note tab → confirm dialog; accept → tab gone AND
      its `.md` deleted on next flush; cancel → nothing happens.
- [ ] Corrupt `session.json` (replace content with `garbage{{{`) while app
      closed → relaunch: no crash, `session.json.bad-*` created, recent
      notes reopened from notesDir.
- [ ] Delete sessionDir entirely while app closed → relaunch self-heals
      the same way.
- [ ] Blur flush: type, immediately click another window, kill the app →
      relaunch has the text (blur triggered `flushNow`).
- [ ] Graceful close (X button) mid-typing → relaunch shows the very last
      keystroke (close-requested flush).

## M3 — Files

- [ ] Ctrl+O a `.md` with LF endings → correct content; edit → dirty dot;
      Ctrl+S → dot clears; file on disk correct, endings still LF.
- [ ] Ctrl+Shift+S to a new path works; tab tracks the new file.
- [ ] Save (Ctrl+S) on a NOTE tab → Save-As dialog; after saving, the note
      file is removed from notesDir and the tab is a file tab.
- [ ] Launch from CLI: `md-notepad some.md` opens it. Second instance
      (double-click a file while running) → existing window focuses, file
      opens as a tab, no second window. Opening an already-open file
      focuses its tab instead of duplicating.
- [ ] Edit a file tab, DON'T save, kill, relaunch → edits restored, dirty
      dot shown, on-disk file untouched.
- [ ] External change: with a file tab open, modify the file in another
      editor → refocus the app → banner appears. Reload shows external
      content (dirty dot cleared). Repeat; choose Keep-mine then Ctrl+S →
      your version wins.
- [ ] Delete the file on disk while its tab is open → save recreates it;
      restore-after-kill shows the error notice, not a crash.
- [ ] Dirty file tab + close (Ctrl+W) → save/discard/cancel prompt; all
      three paths behave.

## M4 — Preview

- [ ] Kitchen-sink doc (headings, table, task list, strikethrough,
      autolink, blockquote, fenced code with language, hr, footnote):
      everything renders in GFM style; preview updates ≤300ms after
      typing pauses; no scroll jumping while typing.
- [ ] ```mermaid flowchart renders as a diagram. While typing it
      half-finished: red-bordered error box with message + source, no
      console spam; completing the code heals it live.
- [ ] Doc WITHOUT mermaid: `dist/assets` check (release build) or devtools
      network: mermaid chunk not loaded until a mermaid block exists (I8).
- [ ] Theme flip re-renders diagrams in matching colors.
- [ ] `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`,
      `[x](javascript:alert(1))` → all inert (I6).
- [ ] `https://` link click → system browser opens, app doesn't navigate;
      relative/anchor links do nothing.
- [ ] Split divider drags; layout persists while switching tabs; raw⇄split
      toggle keeps editor state (same instance, I7).

## M5 — WYSIWYG

- [ ] **Byte-identity drill**: open a heavily formatted note, switch to
      wysiwyg, scroll/click/select for 30s WITHOUT editing, switch back →
      `git diff`/file compare of the note file after flush shows ZERO
      change (I2); no dirty dot on a file tab under the same drill.
- [ ] First keystroke in wysiwyg: normalization hint appears once for that
      tab, not again; content preserved (formatting may re-shape).
- [ ] Type rapidly then IMMEDIATELY switch to raw → last keystrokes present.
- [ ] Tables: edit cells via Crepe UI; back in raw: valid GFM pipe table.
- [ ] Task list checkbox toggles → serializes `- [x]` / `- [ ]`.
- [ ] Mermaid block in wysiwyg shows as a code block (not rendered) and
      survives a wysiwyg edit elsewhere in the doc.
- [ ] Mash mod+1/2/3 for 10s while typing → no text loss, no crash, mode
      lands on the last pressed.
- [ ] First wysiwyg use loads the milkdown chunk (devtools); raw/split-only
      sessions never load it (I8).
- [ ] GFM round-trip audit performed; any dropped construct listed in root
      README known limitations.

## M6 — Settings

- [ ] Every setting: change → immediate effect → restart → persisted.
- [ ] Corrupt settings.json → defaults, no crash, file healed on next save.
- [ ] Notes-dir change with 5+ notes: "move" flow moves files, session
      intact after restart; a locked/duplicate file is reported and left
      behind gracefully.
- [ ] Ligatures OFF → `->` renders as two glyphs everywhere (editor,
      preview, wysiwyg).
- [ ] Font size mod+= / mod+- / mod+0 affects all three modes and persists.
- [ ] Word wrap toggle affects raw/split immediately.
- [ ] Perf spot-check: cold start (release build) feels ≈1s; typing in a
      1MB doc has no visible lag; idle RAM (Task Manager, all processes
      summed) < 150MB on Windows.

## M7 — Packaging & release

- [ ] `npm run tauri build` locally: installer produced, installs, runs,
      uninstalls cleanly.
- [ ] Tag drill (`v0.1.0-rc.*`): draft release contains exe + dmg + deb +
      rpm + AppImage + `latest.json` + `.sig` per updater asset +
      `SHA256SUMS`.
- [ ] `sha256sum -c` and `gh attestation verify` pass for every asset.
- [ ] Clean Windows 11 VM: SmartScreen → Run anyway → installs; `.md`
      double-click opens in MD Notepad (file association).
- [ ] Stock Ubuntu LTS: AppImage runs; deb installs.
- [ ] macOS: right-click-Open works; universal binary (check both archs if
      hardware allows).
- [ ] Updater drill: install rc.N, publish rc.N+1 → app offers update,
      installs, relaunches into N+1.
- [ ] Full M1–M6 checklist re-run on the release build of the primary OS.
