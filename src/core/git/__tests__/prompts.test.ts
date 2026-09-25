import { describe, expect, test } from 'vitest';
import { WORKTREES_DIRECTIVE } from '../../workspace-module-texts';
import { conflictPrompt, KEEP_BOTH_SIDES_RULE } from '../prompts';

describe('conflictPrompt', () => {
  test('the worktree prompt, verbatim', () => {
    expect(
      conflictPrompt({
        mainRoot: 'C:/repo',
        checkoutPath: 'C:/repo/worktrees/git-tab',
        into: 'feat/git-tab',
        from: 'development',
        files: ['src/ui/App.tsx', 'src/core/types.ts'],
      }),
    ).toBe(`# Resolve merge conflicts

Working directory: C:/repo/worktrees/git-tab (a linked worktree of C:/repo)

A \`git merge\` of \`development\` into \`feat/git-tab\` stopped on conflicts in these 2 files:

- src/ui/App.tsx
- src/core/types.ts

Do this:

1. Open each file above and resolve every \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` block, keeping both sides' behavior (the other change is another agent's intentional work). Read enough surrounding code to merge the intent of both changes, not just the lines.
2. Change nothing outside the conflict blocks, and do not reformat the rest of the file.
3. When every marker is gone, re-verify: run the project's build and tests and fix anything the merge broke.
4. Run \`git add -- <file>\` for each resolved file.
5. Do NOT commit, and do not run \`git merge --abort\`, \`git reset\`, \`git checkout\` or \`git stash\`. The user reviews the result and continues the merge from their editor.

Report which files you resolved and anything you were unsure about.

Merge-context: C:/repo/worktrees/git-tab into=feat/git-tab from=development
`);
  });

  test('the main checkout is named as such and one file reads singular', () => {
    const text = conflictPrompt({
      mainRoot: 'C:\\repo',
      checkoutPath: 'c:/repo/',
      into: 'development',
      from: 'feat/x',
      files: ['README.md'],
    });
    expect(text).toContain('Working directory: c:/repo/ (the main checkout)');
    expect(text).toContain('stopped on conflicts in this file:\n\n- README.md\n');
    expect(text.endsWith('Merge-context: c:/repo/ into=development from=feat/x\n')).toBe(true);
  });

  test('quotes the worktree directive rule word for word', () => {
    expect(WORKTREES_DIRECTIVE).toContain(KEEP_BOTH_SIDES_RULE);
  });
});
