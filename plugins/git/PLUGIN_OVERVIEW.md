See each thread's git status where you work: the Diff tab, the changed-files segment above the composer, and the branch, merge base, git status, commits and uncommitted files in the Info tab.

## What you get

- The Diff tab, with uncommitted, branch, all-changes and per-commit views, Viewed marks, whitespace and file filters, and Add to chat on selected lines. `Mod+D` toggles it.
- Review comments on diff lines, saved on the server, anchored to the code so they follow it through edits, and sent to the agent as one batch. Agents read and close them with `bb git comments`.
- A changed-files segment above the composer with a merge-base picker.
- Branch, merge base, ahead/behind status, commits and uncommitted files in the Info tab.
- Live updates: views refresh after the environment's files or refs change, at most once a second, and only rows someone is watching are re-read.

## How it works

The plugin runs git in the environment's workspace on its own machine. One status read serves the Diff tab, the composer and Info. bb never wakes a sleeping machine for git status.

Use the CLI from any thread:

- `bb git status <environment-id>` prints the workspace status.
- `bb git files <environment-id> --target uncommitted` lists changed files.
- `bb git diff <environment-id> --target all` prints the diff.
- `bb git viewed mark <environment-id> --path <path>` marks a file Viewed.
- `bb git comments list` prints the open review comments for this thread's environment, and `bb git comments resolve <comment-id> --note "..."` closes one after you address it.

On this page, Show Git changes above the composer hides or shows the changed-files segment, and Show Commit button (off by default) adds Commit to the thread header.
