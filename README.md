# paperclipai-plugin-telegram

A Telegram bot for [Paperclip](https://github.com/paperclipai/paperclip).
Get pinged when stuff happens in your Paperclip, reply to add a comment,
tap a button to approve things, and run a bunch of slash commands
without leaving the chat.

## Set it up

```bash
git clone https://github.com/NoeFabris/paperclipai-plugin-telegram.git
cd paperclipai-plugin-telegram
npm install
paperclipai plugin install "$(pwd)"
```

It's on npm too: `paperclipai plugin install paperclipai-plugin-telegram`.

You'll need to be signed in to your Paperclip — either run
`paperclipai auth login` first, or install through the Paperclip web UI.

### Make a bot

1. Open [@BotFather](https://t.me/BotFather), say `/newbot`, give it a
   name, save the token it spits out.
2. Send any message to your new bot — bots can't reach you until you
   talk to them first.
3. Grab the chat id you want messages to land in:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'
   ```

### Tell the plugin about it

In the plugin's settings page in Paperclip, fill in:

| Field | Required | What it is |
| --- | :---: | --- |
| `botToken` | ✓ | From BotFather |
| `defaultChatId` | ✓ | Where messages should go |
| `paperclipPublicUrl` |   | Your Paperclip URL (e.g. `https://paperclip.example.com`). Needed for deep links, slash commands, and inline buttons |
| `paperclipApiToken` |   | A Paperclip bearer token for *you*. Once it's set, the bot can do things on your behalf — approve, mark done, create issues, the lot |
| `digestChatId` |   | Chat for the scheduled daily digest. Falls back to `defaultChatId`. |
| `digestTopicId` |   | Forum topic for the digest. Falls back to `defaultTopicId`. |

Everything else (per-event on/off switches, per-category chat routing,
allow-lists, default company, webhook secret) lives in
`dist/manifest.js` if you want to dig.

## What you can do

Type `/help` in the bot to see this list right inside Telegram.

### Switching workspaces

| Command | What it does |
| --- | --- |
| `/workspaces` (or `/companies`) | Lists your companies. Each row is a tap-to-switch button. |
| `/use <name>` | Same thing from the keyboard, if you'd rather type |
| `/connect <name>` | Bind *this chat* to a workspace. Beats `/use` — useful for a chat dedicated to one company. |

Each person gets their own active workspace. **Heads up:** notifications
fire for *every* workspace regardless — your active one only changes
which company the commands look at. Every notification header tells you
which workspace it came from (e.g. `· 🏢 Helpy`). The resolution order
inside any chat is: per-chat `/connect` → per-user `/use` →
`defaultCompanyId` → first visible company.

### Looking around

| Command | What it does |
| --- | --- |
| `/status` | Plugin version, bot info, live counts (open issues, agents, pending approvals) |
| `/issues` | Latest issues. Each one has 👁 Open / ✅ Done / 🔁 Reopen / 💬 Comment buttons |
| `/open <id>` | One issue in detail (works with `REA-123` or the UUID) |
| `/approvals` | What's waiting for you to approve |
| `/agents` | Who's idle, who's running, who's blocked |
| `/digest` | On-demand 24h summary for the active workspace (closed/new issues, open approvals, busy agents). Also runs daily on a schedule — see below. |
| `/help` | This list, in the chat |

### Doing things

| Command | What it does |
| --- | --- |
| `/new <title>` | Create an issue in your active workspace |
| `/comment <id> <text>` | Add a comment to an issue |
| `/done <id>` | Mark an issue done |
| `/reopen <id>` | Bring a closed issue back to `todo` |
| `/approve <id>` | Approve an approval — full UUID or 8-char prefix |
| `/reject <id>` | Reject an approval — full UUID or 8-char prefix |
| `/pause <agent>` | Pause an agent |
| `/resume <agent>` | Resume them |

### Routing per project

In a forum-style supergroup you can split notifications into per-project
topics without touching the manifest:

| Command | What it does |
| --- | --- |
| `/topics list` | Show current project → topic mappings for this chat |
| `/topics add <project> <topicId>` | Route a project's events into a specific forum topic |
| `/topics remove <project>` | Drop a single mapping |
| `/topics clear` | Drop them all |

`<project>` accepts a project UUID or a name (case-insensitive). Mappings
live in plugin state and apply *to this chat only* — when an event
carries a `payload.projectId` that matches a mapping for the chat it's
routed to, the topic override kicks in. Per-category routing
(`routing.issues.chatId`, …) still decides which chat receives the
event; `/topics` only changes the forum topic within it.

### Daily digest

The plugin declares a scheduled job (`telegram-daily-digest`, cron
`0 9 * * *`) that posts a per-workspace summary to `digestChatId`
(falls back to `defaultChatId`, with `digestTopicId` for the forum
topic). Run `/digest` to fire one on-demand for your active workspace.

### Tapping buttons

Every tap updates the message it came from — no separate "approved!"
ping, no stale buttons. Approving an approval edits the original
message in place ("✅ Approved by …") and collapses the row to a single
"Open in Paperclip" button. Marking an issue done or reopening it
re-renders the issue list (or the `/open` detail) so the row reflects
the new status. Pausing an agent re-renders the agent list.

| Where they show up | Buttons |
| --- | --- |
| Approval notifications | ✅ Approve · ❌ Reject · 💬 Comment (needs `paperclipApiToken`) |
| `/approvals` rows | Same three per row |
| `/issues` rows | 👁 Open · ✅ Done / 🔁 Reopen · 💬 Comment |
| `/open` detail | 👁 Open · ✅ Done / 🔁 Reopen · 💬 Comment |
| `/agents` rows | ⏸ Pause / ▶️ Resume |
| `/workspaces` rows | One per workspace — tap to switch active |
| Any notification | 👁 Open in Paperclip |

When you decide an approval from Telegram, the plugin also suppresses
the duplicate `approval.decided` notification it would otherwise emit
to its routed chat — you already saw the decision land in the message
you just tapped.

### Replying to notifications

Just hit reply on any issue or approval notification — whatever you
type lands as a comment on that thing. No need to copy IDs around.

> One caveat: photos, voice notes, files won't go through (Paperclip
> doesn't have a plugin upload endpoint yet). Only the text becomes the
> comment.

## What you get pinged about (by default)

- Issue marked done
- Approval requested or decided
- Agent run failed
- Budget incident opened

Everything else has a toggle — issue created, status changed (any
transition), new comments, agent runs starting / finishing / cancelled,
budget incidents resolved, goals. Flip them on in plugin config under
`events.*`.

You can also send different event classes to different chats or forum
topics. Routing keys: `issues`, `comments`, `approvals`, `agentRuns`,
`errors`, `budgets`, `goals` — each takes `{chatId, topicId}` and falls
back to your defaults if you leave it blank.

## A quick note on the tokens

The Telegram bot token and the Paperclip API token sit in plain text in
your plugin config. Anyone with plugin-config access can read them, so
keep that to people you trust.

## Hacking on it

```bash
npm install
npm test
```

Edit `dist/manifest.js` and `dist/worker.js` directly — there's no
build step. The host watches `dist/` and reloads the worker when
files change.

## License

MIT — see [LICENSE](./LICENSE).
