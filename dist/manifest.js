/**
 * Manifest for paperclipai-plugin-telegram.
 *
 * Required capabilities are derived from features in use:
 *   - events.subscribe — receive domain events from the host
 *   - http.outbound    — call api.telegram.org and (optionally) the
 *                        Paperclip REST API for approve/reject actions
 *   - issues.read      — fetch issue details for deep-link rendering and
 *                        bot-command listings
 *   - webhooks.receive — host routes POST /api/plugins/:pluginId/webhooks/telegram
 *                        to the plugin's onWebhook handler
 *
 * Notes on schema design:
 *   - No field carries `format: "secret-ref"`. The Telegram bot token and
 *     (optional) Paperclip API token are stored as plain strings. This is a
 *     deliberate choice: the host's plugin-config save path rejects any
 *     UUID-shaped secret-ref string, and `ctx.secrets.resolve()` is
 *     currently disabled at the host. Plain-string storage keeps both paths
 *     dormant. Tokens are sensitive — operators should grant plugin access
 *     to trusted board members only.
 */

const chatTarget = {
  type: "object",
  additionalProperties: false,
  properties: {
    chatId: {
      type: "string",
      title: "Chat ID",
      description: "Numeric chat id (positive=user, negative=group), or @channelusername. Leave blank to fall back to defaultChatId.",
    },
    topicId: {
      type: "integer",
      title: "Forum topic ID",
      description: "Forum topic (message_thread_id) inside a supergroup. Leave blank for non-forum chats.",
    },
  },
};

const eventToggle = (defaultOn, title) => ({
  type: "boolean",
  default: defaultOn,
  title,
});

export default {
  id: "paperclipai.telegram",
  apiVersion: 1,
  version: "0.6.0",
  displayName: "Telegram",
  description:
    "Telegram bot integration for Paperclip: push notifications for issues, approvals, agent runs, comments, budgets, goals; deep links into the Paperclip UI; optional inline approve/reject buttons; bot commands over a webhook.",
  author: "NoeFabris",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "webhooks.receive",
    "plugin.state.read",
    "plugin.state.write",
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agents.read",
    "agents.pause",
    "agents.resume",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  webhooks: [
    {
      endpointKey: "telegram",
      displayName: "Telegram bot updates",
      description:
        "Receives Telegram bot updates (commands and callback queries) when this plugin's webhook URL is registered with the Bot API.",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["botToken", "defaultChatId"],
    properties: {
      // Schema marker — never set in actual config. Its sole purpose is to
      // anchor the host's plugin-config secret-ref extractor onto an explicit
      // field (this one), preventing the no-schema fallback that walks the
      // entire config for UUID-shaped strings. Our other fields hold legitimate
      // UUIDs (e.g. defaultCompanyId) which would otherwise trip the host's
      // secret-ref kill switch with a misleading 422.
      _secretRefAnchor: {
        type: "string",
        format: "secret-ref",
        title: "internal — leave blank",
        description: "Internal marker. Do not set.",
      },
      botToken: {
        type: "string",
        title: "Bot token",
        description:
          "Telegram bot token from @BotFather (e.g. 123456789:AA…). Stored as plain text on this Paperclip instance.",
        minLength: 20,
      },
      defaultChatId: {
        type: "string",
        title: "Default chat ID",
        description:
          "Used for any event that has no specific routing override. Numeric chat id or @channelusername.",
        minLength: 1,
      },
      defaultTopicId: {
        type: "integer",
        title: "Default forum topic ID",
        description:
          "Optional forum topic for the default chat. Per-route topics override this.",
      },
      paperclipPublicUrl: {
        type: "string",
        title: "Paperclip public URL",
        description:
          "Public origin used to build 'View in Paperclip' deep links (e.g. https://paperclip.example.com). Leave blank to disable deep-link buttons.",
      },
      paperclipApiToken: {
        type: "string",
        title: "Paperclip API token (optional)",
        description:
          "Board-user bearer token. When set, approval notifications include Approve / Reject inline buttons that act on your behalf via the Paperclip REST API. When blank, only deep-link buttons are shown.",
      },
      defaultCompanyId: {
        type: "string",
        title: "Default company UUID (optional)",
        description:
          "Company used by bot commands like /new, /issues, /agents, /approvals when none is specified. Falls back to the first company the plugin can see.",
      },
      defaultProjectId: {
        type: "string",
        title: "Default project UUID (optional)",
        description:
          "Project that /new issues are filed into. Falls back to the first project in the default company.",
      },
      parseMode: {
        type: "string",
        enum: ["HTML", "MarkdownV2"],
        default: "HTML",
        title: "Message parse mode",
      },
      bodyPreviewMaxLength: {
        type: "integer",
        default: 280,
        minimum: 0,
        maximum: 2000,
        title: "Body preview max length",
        description:
          "Maximum characters of description / comment / error body included in messages. 0 to disable previews.",
      },
      webhookSecretToken: {
        type: "string",
        title: "Webhook secret token (optional)",
        description:
          "If set, the plugin instructs Telegram to attach this in X-Telegram-Bot-Api-Secret-Token on inbound webhooks, and verifies it. Recommended for bot-command / inline-button use.",
      },
      enableCommands: {
        type: "boolean",
        default: true,
        title: "Enable bot commands",
        description:
          "Handle /help, /status, /issues, /approvals when the bot is messaged.",
      },
      routing: {
        type: "object",
        title: "Per-type chat routing",
        additionalProperties: false,
        description:
          "Optional per-category overrides. Each entry sets where a class of events is sent. Empty entries fall back to defaultChatId / defaultTopicId.",
        properties: {
          issues: { ...chatTarget, title: "Issue events" },
          approvals: { ...chatTarget, title: "Approval events" },
          agentRuns: { ...chatTarget, title: "Agent run events" },
          errors: { ...chatTarget, title: "Errors (agent.run.failed)" },
          comments: { ...chatTarget, title: "Issue comments" },
          budgets: { ...chatTarget, title: "Budget incidents" },
          goals: { ...chatTarget, title: "Goal updates" },
        },
      },
      allowlist: {
        type: "object",
        title: "Allowlists",
        additionalProperties: false,
        description:
          "Restrict which events get forwarded. An empty array means 'allow all'. Lists are AND-combined per filter category and OR-combined within each category.",
        properties: {
          companyIds: {
            type: "array",
            items: { type: "string" },
            default: [],
            title: "Company UUIDs",
          },
          projectIds: {
            type: "array",
            items: { type: "string" },
            default: [],
            title: "Project UUIDs",
          },
          agentIds: {
            type: "array",
            items: { type: "string" },
            default: [],
            title: "Agent UUIDs",
          },
          telegramUserIds: {
            type: "array",
            items: { type: "integer" },
            default: [],
            title: "Telegram user IDs (inbound)",
            description:
              "Only these Telegram users may issue commands / press callback buttons. Empty array = allow any user that can reach the bot.",
          },
        },
      },
      events: {
        type: "object",
        title: "Per-event toggles",
        additionalProperties: false,
        properties: {
          issueCreated: eventToggle(false, "Issue created"),
          issueDone: eventToggle(true, "Issue done (status → done)"),
          issueStatusChanged: eventToggle(
            false,
            "Issue status changed (any transition, chatty)"
          ),
          issueCommentCreated: eventToggle(false, "Issue comment created"),
          approvalCreated: eventToggle(true, "Approval requested"),
          approvalDecided: eventToggle(true, "Approval decided"),
          agentRunStarted: eventToggle(false, "Agent run started"),
          agentRunFinished: eventToggle(false, "Agent run finished"),
          agentRunFailed: eventToggle(true, "Agent run failed"),
          agentRunCancelled: eventToggle(false, "Agent run cancelled"),
          budgetIncidentOpened: eventToggle(true, "Budget incident opened"),
          budgetIncidentResolved: eventToggle(
            false,
            "Budget incident resolved"
          ),
          goalCreated: eventToggle(false, "Goal created"),
          goalUpdated: eventToggle(false, "Goal updated"),
        },
      },
    },
  },
};
