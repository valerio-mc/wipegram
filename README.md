<p align="center">
  <img src="wipegram.png" alt="wipegram" width="180">
</p>

<h1 align="center">wipegram</h1>

<p align="center">
  A fast, ephemeral terminal interface for inspecting and removing your own Telegram messages.
</p>

wipegram authenticates as you, lists your Telegram dialogs, progressively counts the messages you
authored, previews recent context, and lets you select chats for batched cleanup. Destructive actions
always require a separate confirmation step.

## Features

- Polished, keyboard-driven [OpenTUI](https://opentui.com/) interface
- Telegram-side own-message counts with bounded concurrency
- Lightweight, in-memory recent-message previews
- Local chat search and explicit multi-chat selection
- Batched deletion with explicit revoke semantics, progress, and cancellation
- Sanitized diagnostics held only in memory for live troubleshooting
- Ephemeral authentication powered by [mtcute](https://mtcute.dev/)

## Privacy

**wipegram never intentionally persists credentials or Telegram session data to disk.
Authentication state exists only for the lifetime of the process and becomes unreachable when
wipegram exits.**

mtcute runs with `MemoryStorage`; wipegram does not export sessions, write log files, or enable
verbose MTProto logging. API credentials, phone numbers, login codes, passwords, auth keys, peer
identifiers, and message content are excluded from the in-app diagnostic buffer.

JavaScript cannot promise cryptographic zeroization of immutable strings or physical RAM. wipegram's
guarantee is non-persistence, not physical-memory erasure.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- A Telegram `api_id` and `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps)
- A terminal at least 60 columns wide and 18 rows tall

## Run

```bash
bun install
bun start
```

Enter credentials in the OpenTUI. Do not pass secrets as command-line arguments. Each launch creates
a new in-memory Telegram session, so Telegram authentication is required again after exit.

## Controls

| Key | Action |
| --- | --- |
| `↑` / `↓`, `k` / `j` | Navigate chats |
| `Space` | Toggle chat selection |
| `Enter` | Refresh the highlighted preview or confirm a dialog |
| `/` | Search titles and usernames |
| `D` | Review selected messages for deletion |
| `R` | Reload dialogs and statistics |
| `Esc` | Cancel or go back |
| `?` | View sanitized in-memory diagnostics |
| `Q` | Disconnect and quit |

## Safety

Deletion is destructive. wipegram explicitly requests revocation for all participants, but Telegram
ultimately decides whether each historical message can be removed for everyone. Failed batches are
reported rather than counted as successful. Cancelling stops new batches after any request already in
flight finishes.

## Tech

[Bun](https://bun.sh/) · [TypeScript](https://www.typescriptlang.org/) ·
[mtcute](https://mtcute.dev/) · [OpenTUI](https://opentui.com/)
