---
name: provider-usage
description: "Inspect provider usage limits across machines and shared sources, and spend Codex or Claude usage-limit resets."
---

# Provider usage

Use `bb usage list --json` to see every account the Provider usage card shows:
its machine or shared source, usage windows, and `resetCredits`
(`available`, `usableNow`, `nextExpiresAt`).

```sh
bb usage list [--refresh] [--json]
bb usage reset <id> --yes [--json]
```

`--refresh` measures every account now instead of reusing results from the
last minute. `<id>` is the account's `id` from `bb usage list`.

A reset spends one of the account's usage-limit resets and cannot be undone.
Spend one only when the user asks for it, and only for an account whose
`usableNow` is above 0. `reset` refuses to run without `--yes`. The result is
`reset`, `nothing_to_reset` or `no_credit` (the reset is kept),
`already_redeemed`, or `failed` with the provider's message (exit code 1).
