# Git

Owns git status, changed files, diffs and the Diff tab for bb environments. Bundled and enabled by default.

- `host.ts` runs git in the environment's workspace on its machine: status, diff, changed files, patches and branch options. Reads share one cache per workspace path.
- `server.ts` resolves environments, fills in the merge base the thread uses, serves the keyed `status` and `patches` reads, `files`, `diff`, `fileSide`, `branches`, `fetchRemoteBranches` (called when a branch picker opens) and the Viewed and merge-base mutations, and registers `bb git`. `server/invalidation.ts` turns the daemon's file and ref change events into one coalesced refresh per environment.
- `app.tsx` registers the Diff tab (`experimental_tab`, with a file or commit target and the `toggle-diff` command), the Info rows and sections, and the changed-files segment of the composer's thread context row. Their components live in `ui/`.
- `contract.ts` is the public contract. Core reads it with `pluginId: "bb--git"` for the Commit dialog, the composer branch chip and `bb thread show`, the way any other plugin would.

Review comments live in the same database (`server/comments.ts`). `server/comment-anchor.ts` is the pure resolver that finds a comment's code again after edits, `server/comment-service.ts` reads the files to place comments and builds the batches, and `server/comment-prompt.ts` formats the escaped context the agent receives through the `review-comments` mention provider. Both stores use one flat, append-only migration list in `server/storage.ts` (a plugin database has a single list, checked by index). Add new statements at the end only; `server/storage.test.ts` pins the hash of every index, so a reorder or an edit of an old statement fails. The CLI is `bb git comments` in `server/cli.ts`.

Viewed marks live in the plugin's own database (`server/viewed.ts`). Upgrading bb hands the marks core used to store to the plugin through its KV storage, and the plugin moves them into that database on its next load.
