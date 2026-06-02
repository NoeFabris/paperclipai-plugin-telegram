# paperclipai-plugin-telegram

A Telegram bot for [Paperclip](https://github.com/paperclipai/paperclip).
Push notifications, reply to comment, tap to approve, full command
surface.

## Install

```bash
git clone https://github.com/NoeFabris/paperclipai-plugin-telegram.git
cd paperclipai-plugin-telegram
npm install
paperclipai plugin install "$(pwd)"
```

Or from npm: `paperclipai plugin install paperclipai-plugin-telegram`.
Install needs CLI board-user auth (`paperclipai auth login`) or use the
Paperclip web UI's plugin installer.

## Bot setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token.
2. Send any message to your new bot (Telegram won't deliver to users who
   haven't initiated the chat).
3. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'
   ```

## Configure

Open the plugin's settings page in Paperclip and set at minimum:

| Field | Required | Meaning |
| --- | :---: | --- |
| `botToken` | ✓ | From @BotFather |
| `defaultChatId` | ✓ | Where notifications land |
| `paperclipPublicUrl` |   | Your instance origin (e.g. `https://paperclip.example.com`). Needed for deep links, the inbound webhook, bot commands, and inline action buttons |
| `paperclipApiToken` |   | Board-user bearer token. Unlocks every write command, `/issues` action buttons, and inline Approve / Reject |

All other fields (per-event toggles, per-category chat routing,
allowlists, default company / project, webhook secret) are documented in
`dist/manifest.js`.

## Commands

`/help` shows this list inside Telegram.

### Workspaces

| Command | What |
| --- | --- |
| `/workspaces` (alias `/companies`) | List companies; tap a row to switch active |
| `/use <name or id>` | Switch active workspace from the keyboard |

Active workspace is per Telegram user. **Notifications fire across all
workspaces**; each notification header is tagged with its source
workspace (e.g. `· 🏢 ReadyAF`). The operator-level `allowlist.companyIds`
config is the only thing that suppresses an entire company.

### Reading

| Command | What |
| --- | --- |
| `/status` | Plugin version, bot identity, live counts (open issues, agents, pending approvals) |
| `/issues` | Recent issues. Each row carries action buttons — see below |
| `/open <id or identifier>` | Show one issue with status, priority, body preview, and a deep-link button |
| `/approvals` | Pending approvals with deep links |
| `/agents` | Agents and their status icons |
| `/help` | This list |

### Writing

| Command | What |
| --- | --- |
| `/new <title>` | Create an issue in the active workspace (default project, or company-level if no project exists) |
| `/comment <id> <text>` | Add a comment to an issue |
| `/done <id>` | Mark issue done |
| `/reopen <id>` | Reopen a closed issue (sets status back to `todo`) |
| `/pause <agent id or name>` | Pause an agent |
| `/resume <agent id or name>` | Resume a paused agent |

### Inline buttons

| Where | Buttons |
| --- | --- |
| Approval notifications | ✅ Approve · ❌ Reject (needs `paperclipApiToken`) |
| `/issues` rows | 👁 Open · ✅ Done / 🔁 Reopen · 💬 Comment |
| `/workspaces` rows | One per workspace, tap to switch |
| All notifications | 👁 Open in Paperclip deep link |

### Reply → comment

Replying to any issue or approval notification (or the bot's 💬 Comment
prompt) posts the reply as a comment on the source entity. Media
attachments are not uploaded — only the reply text becomes the comment
body.

## What's notified by default

Issue done, approval requested, approval decided, agent run failed,
budget incident opened. Every event has its own toggle under `events.*`
in plugin config. Other available events: issue created, issue
status-changed (any transition), issue comment created, agent run
started / finished / cancelled, budget incident resolved, goal created /
updated.

Per-event-class chat routing keys: `issues`, `comments`, `approvals`,
`agentRuns`, `errors`, `budgets`, `goals`. Each takes `{chatId,
topicId}`; empty entries fall back to `defaultChatId` / `defaultTopicId`.

## Token handling

The bot token and the optional Paperclip API token are stored as plain
strings in plugin config — not piped through a secret-reference system.
Anyone with plugin-config access can read them; grant access to trusted
operators only.

## Development

```bash
npm install
npm test
```

Edit `dist/manifest.js` and `dist/worker.js` directly — no build step.
The host watches `dist/` and restarts the worker on rebuild for
local-path installs.

## License

MIT — see [LICENSE](./LICENSE).
