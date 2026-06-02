# paperclipai-plugin-telegram

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that bridges
your instance to a Telegram bot:

- pushes rich notifications for issues, approvals, comments, agent runs,
  budgets, and goals into one or more Telegram chats (with optional forum
  topic routing);
- shows deep-link "View in Paperclip" buttons on every actionable
  notification;
- accepts bot commands like `/issues` and `/status` over a webhook;
- optionally enables inline **Approve** / **Reject** buttons on approval
  notifications, acting on your behalf via the Paperclip REST API.

## Features at a glance

| Capability                              | Default | Configurable |
| --------------------------------------- | :-----: | :----------: |
| Issue created                           |  off    | ✓            |
| Issue done (status → done)              |  on     | ✓            |
| Issue status changed (any transition)   |  off    | ✓            |
| Issue comment created                   |  off    | ✓            |
| Approval requested                      |  on     | ✓            |
| Approval decided                        |  on     | ✓            |
| Agent run started / finished / cancelled|  off    | ✓            |
| Agent run failed                        |  on     | ✓            |
| Budget incident opened / resolved       |  on/off | ✓            |
| Goal created / updated                  |  off    | ✓            |
| Per-event-class chat routing            |   —     | ✓            |
| Company / project / agent allowlists    |   —     | ✓            |
| Inbound bot commands                    |  on     | ✓            |
| Inline approve/reject buttons           |  off    | opt-in (token)|

## Installation

```bash
# 1. Clone the repo somewhere outside the Paperclip checkout
git clone https://github.com/NoeFabris/paperclipai-plugin-telegram.git ~/dev/paperclip-plugins/paperclipai-plugin-telegram
cd ~/dev/paperclip-plugins/paperclipai-plugin-telegram
npm install

# 2. Run the smoke test (optional)
npm test

# 3. Install into your running Paperclip instance
paperclipai plugin install $(pwd)
```

`paperclipai plugin install` requires CLI auth (`paperclipai auth login`)
or you can install via the Paperclip web UI. After install, open the plugin
settings page and fill in the configuration.

The plugin is also installable as an npm package:

```bash
paperclipai plugin install paperclipai-plugin-telegram
```

## Bot setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, follow the prompts.
2. Save the token printed by BotFather.
3. Send any message to the new bot from your account (Telegram bots can't
   contact you until you initiate the chat).
4. Read the chat id you want messages to land in:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat'
   ```
   Use `chat.id` (a positive number for direct messages, negative for
   groups, `-100…` for supergroups). For forum-type supergroup topics, also
   note `message_thread_id` — set it as the topic id in the plugin config.

## Configuration

All fields live in the plugin's instance configuration (no separate
secret store — see "Token handling" below).

| Field                  | Type    | Required | Description                                                                                  |
| ---------------------- | ------- | :------: | -------------------------------------------------------------------------------------------- |
| `botToken`             | string  | ✓        | Bot token from @BotFather.                                                                   |
| `defaultChatId`        | string  | ✓        | Fallback chat for every event without a specific routing override.                           |
| `defaultTopicId`       | integer |          | Default forum topic for `defaultChatId`.                                                     |
| `paperclipPublicUrl`   | string  |          | Origin of your Paperclip instance, e.g. `https://paperclip.example.com`. Required for deep-link buttons, bot commands, and inline approve/reject. |
| `paperclipApiToken`    | string  |          | Board-user bearer token. When set, approval notifications include **Approve** / **Reject** inline buttons that act on your behalf via the Paperclip REST API. |
| `webhookSecretToken`   | string  |          | Optional shared secret. When set, the plugin asks Telegram to attach it to inbound webhooks and verifies it. Recommended when commands or callback buttons are enabled. |
| `parseMode`            | enum    |          | `HTML` (default) or `MarkdownV2`.                                                            |
| `bodyPreviewMaxLength` | integer |          | Truncate description / comment bodies in messages. Default 280; set to 0 to disable.         |
| `enableCommands`       | boolean |          | Enable inbound bot commands. Default `true`.                                                 |
| `defaultCompanyId`     | string  |          | Company UUID used by `/status` / `/issues` / `/new` / `/agents` / `/approvals`. Falls back to the first visible company. |
| `defaultProjectId`     | string  |          | Project UUID where `/new` files issues. Falls back to the first project; company-level if none exists. |
| `routing.<category>`   | object  |          | Per-event-class overrides — see below.                                                       |
| `allowlist.*`          | arrays  |          | Restrict which companies/projects/agents are forwarded, and which Telegram users may issue commands or press buttons. |
| `events.*`             | booleans|          | Per-event toggles.                                                                           |

### Routing categories

Each entry is `{ chatId, topicId }`; both are optional. Empty entries fall
back to `defaultChatId` / `defaultTopicId`.

- `routing.issues` — `issue.created`, `issue.updated`
- `routing.comments` — `issue.comment.created`
- `routing.approvals` — `approval.created`, `approval.decided`
- `routing.agentRuns` — `agent.run.started`, `agent.run.finished`, `agent.run.cancelled`
- `routing.errors` — `agent.run.failed`
- `routing.budgets` — `budget.incident.opened`, `budget.incident.resolved`
- `routing.goals` — `goal.created`, `goal.updated`

### Allowlists

- `allowlist.companyIds` — only forward events for these company UUIDs.
  Empty = all companies the plugin can see.
- `allowlist.projectIds`, `allowlist.agentIds` — same idea.
- `allowlist.telegramUserIds` — only these Telegram users may run commands
  or press inline buttons. Empty = anyone the bot can reach.

## Bot commands

When `enableCommands` is on and the bot has a webhook URL (i.e.
`paperclipPublicUrl` is configured), the plugin registers these slash
commands. All commands that touch instance data require
`paperclipApiToken` to be set (they use the Paperclip REST API on your
behalf because webhook handlers do not get a company-scoped invocation
context from the host).

**Workspaces (multi-company)**

The plugin can speak to every company the configured API token can see.
Each Telegram user has their own active workspace, persisted in plugin
state and resolved in this order: per-user active → `defaultCompanyId`
config → first visible.

- `/workspaces` (alias `/companies`) — list companies with an inline
  button per row. Tap a row to switch active workspace; the message
  updates in-place to reflect the new active.
- `/use <name or partial id>` — same effect from the keyboard.

**Notifications are workspace-independent**: events from every company
the plugin can see fire notifications regardless of which workspace any
user has marked active. Each notification header is tagged with its
source workspace (e.g. `✅ Issue done · 🏢 ReadyAF`). The operator-level
`allowlist.companyIds` still applies if you want to suppress an entire
company.

**Read**

- `/help` — list available commands.
- `/status` — plugin version, bot identity, mutation-API status, and live
  counts (open issues, agents, pending approvals).
- `/issues` — recent issues from the active workspace. Each row carries
  inline buttons: **👁 Open** (deep link), **✅ Done** / **🔁 Reopen**
  (PATCH `/issues/:id`), and **💬 Comment** (sends a force-reply prompt;
  your reply becomes the comment body).
- `/open <identifier or UUID>` — show a single issue (e.g. `/open PCL-42`)
  with status, priority, body preview, and an "Open in Paperclip" button.
- `/approvals` — list pending approvals with deep links.
- `/agents` — list agents in the default company with status icons.

**Write**

- `/new <title>` — create an issue in the default project (falls back to
  company-level if no project is configured).
- `/comment <issue id or identifier> <text>` — add a comment to an issue.
- `/done <id>` — mark an issue done.
- `/reopen <id>` — reopen a closed issue (sets status back to `todo`).
- `/pause <agent id or name>` — pause an agent.
- `/resume <agent id or name>` — resume a paused agent.

**Reply → comment**

Replying to any issue or approval notification in Telegram posts the reply
text as a comment on the source entity. The plugin records the
(chatId, messageId) → entity mapping in plugin state when it sends a
notification with an entity reference, then looks it up on inbound reply.

- Works for `issue.created`, `issue.updated`, `issue.comment.created`,
  `approval.created`, `approval.decided` notifications, plus replies to
  the `/comment` confirmation, `/new` confirmation, and `/open` output.
- Replies that quote a message the plugin no longer tracks (e.g. older
  notifications from before this feature shipped) get a one-shot hint
  pointing to `/comment <id> …`.
- Media attachments (photos, files, voice notes) on replies are not
  currently uploaded; only the reply text becomes the comment body.

Default company resolution: `defaultCompanyId` if set, otherwise the first
company the API returns. Default project resolution: `defaultProjectId` if
set, otherwise the first project — and `projectId` is omitted entirely
when no project exists, so company-level issues still work.

## Inline approve / reject (optional)

If `paperclipApiToken` is set in plugin config, approval notifications
include `Approve` / `Reject` inline buttons in addition to the
"View in Paperclip" deep link. Pressing one calls:

```
POST {paperclipPublicUrl}/api/approvals/{id}/{approve|reject}
Authorization: Bearer {paperclipApiToken}
{"decisionNote":"Via Telegram by …"}
```

The button's outcome is shown in the Telegram callback popup, and the
original notification is annotated with the decider's name.

If `paperclipApiToken` is **not** set, approval notifications still appear
but with only the "View in Paperclip" deep-link button — clicking it takes
you to the Paperclip UI where you can decide there.

## Token handling

The Telegram bot token and (optional) Paperclip API token are stored as
**plain strings** in plugin config. They are not piped through a
secret-reference system. Two implications:

1. Any operator with access to the plugin config can read both tokens.
   Grant plugin-config access to trusted users only.
2. The plugin does not declare the `secrets.read-ref` capability and never
   calls `ctx.secrets.resolve()`, so it stays compatible with hosts where
   plugin secret references are temporarily disabled.

If you rotate either token, update the value in plugin config and the
running worker picks up the new value on the next `onConfigChanged`
delivery (no reinstall required).

## Event payloads — what's shown in each message

Notifications draw from the host's activity-log payload for the event.
The plugin gracefully omits any field that is missing from a given event:

- **Issue events** — identifier, title, status (with arrow for transitions
  when the host included `_previous`), priority, assignee, optional body
  preview.
- **Approval events** — approval type, linked agent (when applicable),
  number of related issues, decision note on `approval.decided`.
- **Agent run events** — agent / run / issue identifiers and (for failures)
  an error preview.
- **Comments** — issue identifier, author, body preview.

A status transition into `done` is detected by comparing the new status
against `_previous.status`. Code paths that emit `issue.updated` without
`_previous.status` are silently skipped to avoid duplicate "done"
notifications.

## Troubleshooting

- *"Webhook entrypoint not found"* on install — make sure `npm install`
  was run before `paperclipai plugin install <path>`.
- Bot commands not responding — confirm `paperclipPublicUrl` is reachable
  from Telegram's servers and `enableCommands` is `true`. Check the plugin
  logs for `telegram webhook registered`.
- Approve / reject button returns "requires `paperclipApiToken`" — set the
  token in plugin config and save.
- 422 on save — the config contains a UUID-shaped string. The plugin uses
  no UUID fields itself; check that `defaultChatId` or routing chat ids
  aren't UUIDs (Telegram chat ids are integers, not UUIDs).

## Development

```bash
npm install
npm test
```

Edit `dist/manifest.js` and `dist/worker.js` directly; there is no build
step. The host watches `dist/` for local-path installs and restarts the
worker on rebuild.

## License

MIT — see [LICENSE](./LICENSE).
