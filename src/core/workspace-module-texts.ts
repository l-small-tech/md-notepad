/**
 * The TEXT of the built-in workspace modules: the directive each one adds to
 * AGENTS.md and the files it seeds. Kept apart from `workspace-modules.ts` so
 * the composition logic reads without pages of prose in the way.
 *
 * Directives are written for an agent, in the imperative, and stay short:
 * every line here is paid for in tokens on every run of every harness.
 */

/**
 * `.notepad/status.py` — the reference implementation of the STATUSES.md
 * protocol. Standard library only. Its slug and table rules mirror
 * `core/prompt-status.ts`; the AGENTS.md directive tells agents to use it or
 * to write an equivalent of their own.
 */
export const STATUS_SCRIPT = `#!/usr/bin/env python3
"""Record prompt progress in STATUSES.md (read by the md-notepad editor).

  python .notepad/status.py set <prompt-id> <status> [summary]
  python .notepad/status.py find <heading text>
  python .notepad/status.py list

<prompt-id> is "path/to/note.md" or "path/to/note.md#heading-slug", relative
to the workspace root. <status> is one of:
  queued  running  needs-input  done  failed

Standard library only. Replace it with anything that writes the same table.
"""
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE = os.path.join(ROOT, "STATUSES.md")
STATUSES = ("queued", "running", "needs-input", "done", "failed")
HEADER = [
    "# Statuses",
    "",
    "Prompt progress, written by agents (\`python .notepad/status.py\`). One row per prompt.",
    "",
    "| Prompt | Status | Updated | Summary |",
    "|---|---|---|---|",
]
SKIP_DIRS = {".git", ".notepad", "node_modules", "worktrees", "target", "dist"}


def slug(title):
    text = re.sub(r"[^\\w\\s-]", "", title.strip().lower())
    return re.sub(r"\\s+", "-", text)


def cell(text):
    return re.sub(r"\\s+", " ", text).replace("|", "\\\\|").strip()


def split_row(line):
    line = line.strip()
    if not line.startswith("|"):
        return None
    cells = re.split(r"(?<!\\\\)\\|", line[1:])
    if cells and cells[-1].strip() == "":
        cells.pop()
    return [c.replace("\\\\|", "|").strip() for c in cells]


def read_rows():
    rows = {}
    if os.path.exists(FILE):
        with open(FILE, encoding="utf-8") as handle:
            for line in handle:
                cells = split_row(line)
                if cells and len(cells) >= 2 and cells[1].lower() in STATUSES:
                    cells += [""] * (4 - len(cells))
                    rows.pop(cells[0], None)
                    rows[cells[0]] = cells[:4]
    return rows


def write_rows(rows):
    lines = HEADER + ["| " + " | ".join(cell(c) for c in row) + " |" for row in rows.values()]
    tmp = FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\\n") as handle:
        handle.write("\\n".join(lines) + "\\n")
    os.replace(tmp, FILE)


def headings(path):
    seen, fence = {}, None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            mark = re.match(r" {0,3}(\`{3,}|~{3,})", line)
            if mark:
                if fence is None:
                    fence = mark.group(1)[0]
                elif mark.group(1)[0] == fence:
                    fence = None
                continue
            found = None if fence else re.match(r" {0,3}#{1,6}[ \\t]+(.*?)[ \\t#]*$", line)
            if found:
                base = slug(found.group(1))
                count = seen.get(base, 0)
                seen[base] = count + 1
                yield base, base if count == 0 else "%s-%d" % (base, count)


def find(title):
    want = slug(title)
    for folder, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.lower().endswith((".md", ".markdown")) and name != "STATUSES.md":
                path = os.path.join(folder, name)
                for base, anchor in headings(path):
                    if base == want:
                        rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
                        print("%s#%s" % (rel, anchor))


def main(argv):
    if len(argv) >= 3 and argv[0] == "set" and argv[2] in STATUSES:
        rows = read_rows()
        key = argv[1].replace("\\\\", "/")
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        rows[key] = [key, argv[2], stamp, " ".join(argv[3:])]
        write_rows(rows)
    elif len(argv) >= 2 and argv[0] == "find":
        find(" ".join(argv[1:]))
    elif argv[:1] == ["list"]:
        for row in read_rows().values():
            print("  ".join(row))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
`;

export const PROMPT_STATUS_DIRECTIVE = `## Prompt status

Prompts in this workspace are markdown notes (or one heading section of a note). The user's editor shows each prompt's progress, which it reads from \`STATUSES.md\` in the workspace root. Keep that file current — it is how the user knows what you are doing.

- **Identify the prompt.** A prompt pasted from the editor ends with \`Prompt-id: path/to/note.md#heading-slug\`. Without that line, find it: \`python .notepad/status.py find "<the prompt's heading>"\`. If nothing matches, skip status reporting.
- **Report** with \`python .notepad/status.py set <prompt-id> <status> "<one-line summary>"\`:
  - \`running\` as soon as you start;
  - \`needs-input\` when you stop to ask the user something (summary = the question);
  - \`done\` when finished and verified (summary = what changed);
  - \`failed\` if you give up (summary = why).
- \`queued\` is set by the user's editor, never by you.
- Do not hand-edit \`STATUSES.md\` — the script is cheaper and keeps the table parseable. No Python? Write an equivalent in any language available (see the script's docstring for the format): one table row per prompt id, \`| id | status | YYYY-MM-DD HH:MM | summary |\`, replacing the row if it exists.
`;

export const MANIFEST_DIRECTIVE = `## File manifest

\`MANIFEST.md\` lists every file and folder that matters in this workspace with one line on what it is for. Read it before exploring — it is cheaper than listing directories. When you add, move, rename or delete a file, update its line in the same change. Generated and vendored content (build output, dependencies) gets one line for the folder, not one per file.
`;

export const MANIFEST_SEED = `# Manifest

What each file and folder here is for. Agents keep this current (see AGENTS.md).

| Path | Purpose |
|---|---|
| AGENTS.md | Instructions for AI agents working in this folder |
`;

export const CHANGELOG_DIRECTIVE = `## Changelog

\`CHANGELOG.md\` keeps an \`## [Unreleased]\` section at the top. When you finish a change the user would notice, add one short line there in the same change — what it means for them, not which files moved. Do not list refactors or internal churn. On a release, rename \`[Unreleased]\` to \`## [X.Y.Z] — YYYY-MM-DD\` and start a fresh \`[Unreleased]\` above it.
`;

export const CHANGELOG_SEED = `# Changelog

## [Unreleased]
`;

export const LESSONS_DIRECTIVE = `## Lessons learned

\`LESSONS.md\` is this workspace's memory across sessions. Read it at the start of every task. Add an entry when something cost you time that a note would have prevented: a wrong assumption about this project, a command that fails here, a correction or preference from the user. One entry = a dated heading, the fact, and how to apply it. Update or delete entries that turn out wrong; never record what the files already say.
`;

export const LESSONS_SEED = `# Lessons learned

Things agents found out the hard way. Newest first. (See AGENTS.md.)
`;

export const WORKTREES_DIRECTIVE = `## Git worktree workflow

Several agents may work here at once, so never change files on the main checkout.

1. Pull the default branch, then \`git worktree add worktrees/<slug> -b feat/<slug>\` (short kebab-case slug). \`worktrees/\` is gitignored.
2. Install dependencies inside the worktree before building. Make every change there only.
3. When finished: verify the project builds and its tests pass, commit with a concise message, and tell the user the worktree path. Leave nothing running.
4. Merge only after the user confirms: pull the default branch, merge it INTO your branch first, resolve conflicts keeping both sides' behavior (the other change is another agent's intentional work), re-verify, then merge your branch in.
5. When the user ends the task: leave the worktree directory in every shell, then \`git worktree remove worktrees/<slug>\` and \`git branch -d feat/<slug>\`. If removal fails on uncommitted changes, ask before forcing.
`;

export const EXAMPLE_PROMPT = `# Example prompt

This note is a prompt. The loop:

1. Write what you want done under a heading, like the one below.
2. Put the caret in that section and press **Copy as prompt** in the strip above the note. It shows as *Queued*.
3. Paste it into your AI agent (Claude Code, Codex, Gemini CLI…) running in a terminal opened in this folder.
4. Watch the chip: the agent marks it *Running*, then *Done*, *Needs input* or *Failed*, with a one-line summary. **Workspace status** in the command palette lists every prompt.

## Say hello

Create a file \`hello.md\` in this folder containing a short, friendly greeting and today's date.
`;
