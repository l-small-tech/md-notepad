## Worktree workflow
For any code task, work in an isolated git worktree, not the main checkout:
1. Create: `git worktree add ../<repo>-<task> -b <task-branch>`
2. Do all work there.
3. On completion: commit, merge into `development`, then `git worktree remove` and delete the branch.
Resolve merge conflicts before removing the worktree. Never edit the main working tree directly.