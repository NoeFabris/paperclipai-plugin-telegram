/**
 * Worker for paperclipai-plugin-telegram.
 *
 * High level:
 *   - subscribe to Paperclip domain events via `ctx.events.on(...)`
 *   - format each event as a Telegram HTML message
 *   - resolve the destination (per-type chat routing + default fallback)
 *   - apply operator allowlists
 *   - send via Telegram Bot API using `ctx.http.fetch`
 *   - if a public webhook URL can be derived, register it with Telegram on
 *     startup so the bot can receive commands / callback queries
 *   - dispatch inbound webhook updates: bot commands (/help, /status,
 *     /issues) and inline-button callback queries (Approve / Reject)
 *
 * Token storage: the bot token and optional Paperclip API token live in
 * plain plugin config (no secret-ref UUIDs). This keeps the host's
 * secret-ref code paths dormant.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const TELEGRAM_API = "https://api.telegram.org";
const VERSION = "0.2.0";
const COMMAND_MAX_ISSUES = 10;
const TELEGRAM_HARD_LIMIT = 4000; // Bot API limit is 4096; keep a margin.

// Captured during setup() so onWebhook / onConfigChanged can reuse the host
// context the SDK does not pass them directly.
let pluginCtx = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMd2(value) {
  return String(value ?? "").replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

function truncate(text, max) {
  if (!text) return "";
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function clampMessage(text) {
  if (text.length <= TELEGRAM_HARD_LIMIT) return text;
  return text.slice(0, TELEGRAM_HARD_LIMIT - 1) + "…";
}

function fmtCode(text) {
  return `<code>${escapeHtml(text)}</code>`;
}

function fmtIdShort(id) {
  if (typeof id !== "string" || id.length === 0) return "";
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function statusEmoji(status) {
  switch (status) {
    case "done":
      return "✅";
    case "in_progress":
    case "active":
    case "running":
      return "🔄";
    case "blocked":
      return "🛑";
    case "todo":
      return "📋";
    case "cancelled":
      return "🚫";
    case "approved":
      return "✅";
    case "rejected":
      return "❌";
    case "revision_requested":
      return "🟠";
    default:
      return "•";
  }
}

// ---------------------------------------------------------------------------
// Config access + routing
// ---------------------------------------------------------------------------

const ROUTING_CATEGORIES = {
  "issue.created": "issues",
  "issue.updated": "issues",
  "issue.comment.created": "comments",
  "approval.created": "approvals",
  "approval.decided": "approvals",
  "agent.run.started": "agentRuns",
  "agent.run.finished": "agentRuns",
  "agent.run.cancelled": "agentRuns",
  "agent.run.failed": "errors",
  "budget.incident.opened": "budgets",
  "budget.incident.resolved": "budgets",
  "goal.created": "goals",
  "goal.updated": "goals",
};

function resolveRoute(cfg, eventType) {
  const category = ROUTING_CATEGORIES[eventType] ?? null;
  const routing = (cfg.routing && typeof cfg.routing === "object" && cfg.routing) || {};
  const override = category ? routing[category] : null;
  const chatId =
    override && typeof override.chatId === "string" && override.chatId.trim().length > 0
      ? override.chatId.trim()
      : typeof cfg.defaultChatId === "string"
      ? cfg.defaultChatId.trim()
      : "";
  const topicId =
    override && Number.isInteger(override.topicId)
      ? override.topicId
      : Number.isInteger(cfg.defaultTopicId)
      ? cfg.defaultTopicId
      : null;
  return { chatId, topicId };
}

function passesAllowlist(cfg, event) {
  const allow = cfg.allowlist || {};
  const payload = event.payload || {};
  const cids = Array.isArray(allow.companyIds) ? allow.companyIds : [];
  const pids = Array.isArray(allow.projectIds) ? allow.projectIds : [];
  const aids = Array.isArray(allow.agentIds) ? allow.agentIds : [];
  if (cids.length > 0 && event.companyId && !cids.includes(event.companyId))
    return false;
  if (pids.length > 0) {
    const pid =
      event.entityType === "project"
        ? event.entityId
        : typeof payload.projectId === "string"
        ? payload.projectId
        : null;
    if (!pid || !pids.includes(pid)) return false;
  }
  if (aids.length > 0) {
    const aid =
      event.entityType === "agent"
        ? event.entityId
        : typeof payload.agentId === "string"
        ? payload.agentId
        : null;
    if (!aid || !aids.includes(aid)) return false;
  }
  return true;
}

function eventEnabled(cfg, key, defaultOn) {
  const events = cfg.events;
  if (events == null || typeof events !== "object") return defaultOn;
  const v = events[key];
  return typeof v === "boolean" ? v : defaultOn;
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

function deepLink(cfg, kind, id) {
  if (!cfg.paperclipPublicUrl || typeof cfg.paperclipPublicUrl !== "string")
    return null;
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  if (!id) return base;
  switch (kind) {
    case "issue":
      return `${base}/issues/${encodeURIComponent(id)}`;
    case "approval":
      return `${base}/approvals/${encodeURIComponent(id)}`;
    case "agent":
      return `${base}/agents/${encodeURIComponent(id)}`;
    case "project":
      return `${base}/projects/${encodeURIComponent(id)}`;
    case "goal":
      return `${base}/goals/${encodeURIComponent(id)}`;
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

function createTelegram(ctx, token) {
  const base = `${TELEGRAM_API}/bot${token}`;
  async function rpc(method, body, init = {}) {
    // Use the worker's native fetch directly (not ctx.http.fetch) so the
    // call does not re-enter the host RPC layer from within onWebhook
    // handlers; the SDK explicitly permits this.
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let json;
    try {
      json = text ? JSON.parse(text) : { ok: false };
    } catch {
      json = { ok: false, description: text.slice(0, 200) };
    }
    if (!res.ok || !json.ok) {
      ctx.logger.warn("telegram api error", {
        method,
        status: res.status,
        description: json.description,
        sample: text.slice(0, 300),
      });
      return { ok: false, response: json, status: res.status };
    }
    return { ok: true, result: json.result };
  }

  return {
    rpc,
    sendMessage: (body) => rpc("sendMessage", body),
    editMessageReplyMarkup: (body) => rpc("editMessageReplyMarkup", body),
    editMessageText: (body) => rpc("editMessageText", body),
    answerCallbackQuery: (body) => rpc("answerCallbackQuery", body),
    setWebhook: (body) => rpc("setWebhook", body),
    deleteWebhook: (body) => rpc("deleteWebhook", body ?? {}),
    getMe: () => rpc("getMe", {}),
    setMyCommands: (body) => rpc("setMyCommands", body),
  };
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

async function dispatchMessage(ctx, cfg, eventType, html, extra = {}) {
  const route = resolveRoute(cfg, eventType);
  if (!route.chatId) {
    ctx.logger.warn("no chat routing — dropping message", { eventType });
    return;
  }
  const token = (cfg.botToken || "").trim();
  if (!token) {
    ctx.logger.warn("no botToken — dropping message", { eventType });
    return;
  }
  const tg = createTelegram(ctx, token);
  const body = {
    chat_id: route.chatId,
    text: clampMessage(html),
    parse_mode: cfg.parseMode === "MarkdownV2" ? "MarkdownV2" : "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  if (route.topicId != null) body.message_thread_id = route.topicId;
  await tg.sendMessage(body);
}

function viewButton(label, url) {
  return { text: label, url };
}

function callbackButton(label, data) {
  return { text: label, callback_data: data };
}

function buildApprovalKeyboard(cfg, approvalId) {
  const rows = [];
  const link = deepLink(cfg, "approval", approvalId);
  if (link) rows.push([viewButton("View in Paperclip ↗", link)]);
  if (cfg.paperclipApiToken && approvalId) {
    rows.push([
      callbackButton("✅ Approve", `approve:${approvalId}`),
      callbackButton("❌ Reject", `reject:${approvalId}`),
    ]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

function buildIssueKeyboard(cfg, issueId) {
  const link = deepLink(cfg, "issue", issueId);
  if (!link) return null;
  return { inline_keyboard: [[viewButton("View in Paperclip ↗", link)]] };
}

// ---------------------------------------------------------------------------
// Event formatters
// ---------------------------------------------------------------------------

function bodyPreview(cfg, text) {
  const max = Number.isInteger(cfg.bodyPreviewMaxLength)
    ? cfg.bodyPreviewMaxLength
    : 280;
  if (max <= 0 || typeof text !== "string" || text.length === 0) return null;
  return truncate(text, max);
}

function fmtIssue(prefix, event, cfg) {
  const p = event.payload || {};
  const id = p.identifier ? `<b>${escapeHtml(p.identifier)}</b>` : "";
  const title = typeof p.title === "string" && p.title ? ` ${escapeHtml(p.title)}` : "";
  const status = typeof p.status === "string" ? p.status : null;
  const priority = typeof p.priority === "string" ? p.priority : null;
  const lines = [`${prefix} ${id}${title}`.trim()];
  const meta = [];
  if (status) meta.push(`${statusEmoji(status)} ${fmtCode(status)}`);
  if (priority) meta.push(`priority ${fmtCode(priority)}`);
  if (typeof p.assigneeAgentId === "string")
    meta.push(`agent ${fmtCode(fmtIdShort(p.assigneeAgentId))}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const preview = bodyPreview(cfg, p.description);
  if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
  return lines.join("\n");
}

function fmtStatusTransition(event, cfg) {
  const p = event.payload || {};
  const prev = p._previous && typeof p._previous.status === "string" ? p._previous.status : null;
  const curr = typeof p.status === "string" ? p.status : null;
  if (!curr) return null;
  const ident = p.identifier ? `<b>${escapeHtml(p.identifier)}</b> ` : "";
  if (prev && prev !== curr) {
    return `${statusEmoji(curr)} ${ident}${fmtCode(prev)} → ${fmtCode(curr)}`;
  }
  return `${statusEmoji(curr)} ${ident}is now ${fmtCode(curr)}`;
}

function fmtApprovalCreated(event, cfg) {
  const p = event.payload || {};
  const lines = [`🟡 <b>Approval requested</b>`];
  if (typeof p.type === "string") lines.push(`type ${fmtCode(p.type)}`);
  const ctxBits = [];
  if (typeof p.linkedAgentId === "string")
    ctxBits.push(`agent ${fmtCode(fmtIdShort(p.linkedAgentId))}`);
  if (typeof p.managedResourceKey === "string")
    ctxBits.push(`key ${fmtCode(p.managedResourceKey)}`);
  if (Array.isArray(p.issueIds) && p.issueIds.length > 0)
    ctxBits.push(`${p.issueIds.length} issue(s)`);
  if (ctxBits.length > 0) lines.push(ctxBits.join(" · "));
  return lines.join("\n");
}

function fmtApprovalDecided(event, cfg) {
  const p = event.payload || {};
  const decision = typeof p.outcome === "string"
    ? p.outcome
    : typeof p.decision === "string"
    ? p.decision
    : "decided";
  const emoji = statusEmoji(decision);
  const lines = [`${emoji} <b>Approval ${escapeHtml(decision)}</b>`];
  if (typeof p.type === "string") lines.push(`type ${fmtCode(p.type)}`);
  if (typeof p.decisionNote === "string" && p.decisionNote.length > 0) {
    const preview = bodyPreview(cfg, p.decisionNote);
    if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
  }
  return lines.join("\n");
}

function fmtAgentRun(prefix, event, cfg) {
  const p = event.payload || {};
  const lines = [prefix];
  const meta = [];
  if (typeof p.agentId === "string")
    meta.push(`agent ${fmtCode(fmtIdShort(p.agentId))}`);
  if (typeof p.runId === "string")
    meta.push(`run ${fmtCode(fmtIdShort(p.runId))}`);
  if (typeof p.issueId === "string")
    meta.push(`issue ${fmtCode(fmtIdShort(p.issueId))}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const reason =
    typeof p.error === "string"
      ? p.error
      : typeof p.message === "string"
      ? p.message
      : null;
  if (reason) {
    const preview = bodyPreview(cfg, reason);
    if (preview) lines.push(`<pre>${escapeHtml(preview)}</pre>`);
  }
  return lines.join("\n");
}

function fmtComment(event, cfg) {
  const p = event.payload || {};
  const lines = [`💬 <b>New comment</b>`];
  if (typeof p.issueIdentifier === "string")
    lines.push(`on <b>${escapeHtml(p.issueIdentifier)}</b>`);
  if (typeof p.authorName === "string")
    lines.push(`by ${escapeHtml(p.authorName)}`);
  const preview = bodyPreview(cfg, p.body || p.text);
  if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
  return lines.join("\n");
}

function fmtBudget(prefix, event, cfg) {
  const p = event.payload || {};
  const lines = [prefix];
  const bits = [];
  if (typeof p.threshold === "string") bits.push(`threshold ${fmtCode(p.threshold)}`);
  if (typeof p.companyId === "string") bits.push(`company ${fmtCode(fmtIdShort(p.companyId))}`);
  if (typeof p.amountCents === "number")
    bits.push(`${(p.amountCents / 100).toFixed(2)}`);
  if (bits.length > 0) lines.push(bits.join(" · "));
  return lines.join("\n");
}

function fmtGoal(prefix, event, cfg) {
  const p = event.payload || {};
  const lines = [prefix];
  if (typeof p.title === "string") lines.push(escapeHtml(p.title));
  if (typeof p.status === "string") lines.push(`status ${fmtCode(p.status)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Webhook URL helpers
// ---------------------------------------------------------------------------

function webhookUrl(cfg) {
  if (!cfg.paperclipPublicUrl || typeof cfg.paperclipPublicUrl !== "string")
    return null;
  const pid = process.env.PAPERCLIP_PLUGIN_ID;
  if (!pid) return null;
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  return `${base}/api/plugins/${pid}/webhooks/telegram`;
}

async function ensureWebhookRegistered(ctx, cfg) {
  const url = webhookUrl(cfg);
  if (!url) {
    ctx.logger.info("paperclipPublicUrl not set — skipping webhook registration");
    return;
  }
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const secret = typeof cfg.webhookSecretToken === "string" ? cfg.webhookSecretToken.trim() : "";
  const body = {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  };
  if (secret) body.secret_token = secret;
  const r = await tg.setWebhook(body);
  if (r.ok) {
    ctx.logger.info("telegram webhook registered", { url });
  }
}

async function ensureCommandsRegistered(ctx, cfg) {
  if (!cfg.enableCommands) return;
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  await tg.setMyCommands({
    commands: [
      { command: "help", description: "Show available commands" },
      { command: "status", description: "Plugin + bot status" },
      { command: "issues", description: "List recent open issues" },
    ],
  });
}

// ---------------------------------------------------------------------------
// Webhook command handlers
// ---------------------------------------------------------------------------

function helpText() {
  return [
    "<b>Paperclip Telegram bot</b>",
    `<i>v${VERSION}</i>`,
    "",
    "<b>Commands</b>",
    "<code>/help</code>     — this message",
    "<code>/status</code>   — plugin + bot status",
    "<code>/issues</code>   — recent open issues",
  ].join("\n");
}

async function handleStatusCommand(ctx, cfg, message) {
  const lines = [
    `<b>paperclipai-plugin-telegram</b> v${VERSION}`,
    `plugin id: ${fmtCode(process.env.PAPERCLIP_PLUGIN_ID || "?")}`,
    `default chat: ${fmtCode(cfg.defaultChatId || "?")}`,
    `mutation api: ${cfg.paperclipApiToken ? "✅ configured" : "❌ disabled (set paperclipApiToken to enable)"}`,
  ];
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  await tg.sendMessage({
    chat_id: message.chat.id,
    message_thread_id: message.message_thread_id ?? undefined,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

async function handleIssuesCommand(ctx, cfg, message) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  let listed = [];
  try {
    if (ctx.issues && typeof ctx.issues.list === "function") {
      // Lists across the first company the plugin can see.
      const companies = await ctx.companies.list({});
      const company = (companies?.items || companies || [])[0];
      if (company?.id) {
        const result = await ctx.issues.list(company.id, {
          limit: COMMAND_MAX_ISSUES,
        });
        listed = result?.items || result || [];
      }
    }
  } catch (err) {
    ctx.logger.warn("issues list failed", { err: String(err) });
  }
  const lines = [`<b>Recent issues</b>`];
  if (listed.length === 0) {
    lines.push("<i>(none or unable to list)</i>");
  } else {
    for (const issue of listed.slice(0, COMMAND_MAX_ISSUES)) {
      const ident = issue.identifier || fmtIdShort(issue.id || "");
      const title = issue.title || "(untitled)";
      const status = issue.status || "?";
      const link = deepLink(cfg, "issue", issue.id);
      const lineLabel = link
        ? `<a href="${escapeHtml(link)}">${escapeHtml(ident)}</a>`
        : `<b>${escapeHtml(ident)}</b>`;
      lines.push(
        `${statusEmoji(status)} ${lineLabel} — ${escapeHtml(truncate(title, 80))}`
      );
    }
  }
  await tg.sendMessage({
    chat_id: message.chat.id,
    message_thread_id: message.message_thread_id ?? undefined,
    text: clampMessage(lines.join("\n")),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function handleCommand(ctx, cfg, message) {
  const text = String(message.text || "").trim();
  const m = text.match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s+(.*))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  switch (cmd) {
    case "start":
    case "help":
      await tg.sendMessage({
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id ?? undefined,
        text: helpText(),
        parse_mode: "HTML",
      });
      return true;
    case "status":
      await handleStatusCommand(ctx, cfg, message);
      return true;
    case "issues":
      await handleIssuesCommand(ctx, cfg, message);
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Callback query handler (Approve / Reject)
// ---------------------------------------------------------------------------

async function callPaperclip(ctx, cfg, pathRel, body) {
  if (!cfg.paperclipPublicUrl || !cfg.paperclipApiToken)
    return { ok: false, status: 0, description: "no api token configured" };
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  const url = `${base}/api${pathRel}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.paperclipApiToken}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body: json };
}

async function handleCallbackQuery(ctx, cfg, query) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const data = String(query.data || "");
  const m = data.match(/^(approve|reject):([a-f0-9-]{8,})$/i);
  if (!m) {
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: "Unrecognized button",
    });
    return;
  }
  const action = m[1];
  const approvalId = m[2];
  if (!cfg.paperclipApiToken) {
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: "Approve/reject requires paperclipApiToken to be set in plugin config.",
      show_alert: true,
    });
    return;
  }
  const path = action === "approve"
    ? `/approvals/${approvalId}/approve`
    : `/approvals/${approvalId}/reject`;
  const result = await callPaperclip(ctx, cfg, path, {
    decisionNote: `Via Telegram by ${query.from?.username || query.from?.first_name || "user"}`,
  });
  const ok = result.ok;
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: ok
      ? action === "approve"
        ? "Approved ✅"
        : "Rejected ❌"
      : `Failed (${result.status}): ${truncate(JSON.stringify(result.body), 120)}`,
    show_alert: !ok,
  });
  if (ok && query.message) {
    const original = query.message.text || query.message.caption || "";
    const decoration = action === "approve"
      ? `\n\n<b>✅ Approved</b> by ${escapeHtml(query.from?.username || query.from?.first_name || "user")}`
      : `\n\n<b>❌ Rejected</b> by ${escapeHtml(query.from?.username || query.from?.first_name || "user")}`;
    await tg.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: clampMessage(original + decoration),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Inbound allowlist (for commands + callback queries)
// ---------------------------------------------------------------------------

function inboundAllowed(cfg, fromUserId) {
  const list = cfg.allowlist?.telegramUserIds;
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes(fromUserId);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    ctx.logger.info("paperclipai-plugin-telegram setup starting", { version: VERSION });

    function safe(label, fn) {
      return async (event) => {
        try {
          await fn(event);
        } catch (err) {
          ctx.logger.error("event handler error", {
            err: String(err),
            label,
            eventId: event?.eventId,
          });
        }
      };
    }

    async function send(eventType, html, opts = {}) {
      const cfg = await ctx.config.get();
      await dispatchMessage(ctx, cfg, eventType, html, opts);
    }

    async function gate(event, key, defaultOn) {
      const cfg = await ctx.config.get();
      if (!eventEnabled(cfg, key, defaultOn)) return null;
      if (!passesAllowlist(cfg, event)) return null;
      return cfg;
    }

    // Issues
    ctx.events.on(
      "issue.created",
      safe("issue.created", async (event) => {
        const cfg = await gate(event, "issueCreated", false);
        if (!cfg) return;
        const html = fmtIssue("🆕 <b>Issue created</b>", event, cfg);
        const kb = buildIssueKeyboard(cfg, event.entityId);
        await send("issue.created", html, kb ? { reply_markup: kb } : {});
      })
    );

    ctx.events.on(
      "issue.updated",
      safe("issue.updated", async (event) => {
        const cfg = await gate(event, "issueDone", true);
        if (!cfg) return;
        const payload = event.payload || {};
        const prev = payload._previous?.status;
        const curr = payload.status;
        const isDone = curr === "done" && prev && prev !== "done";
        const isAnyStatus =
          typeof curr === "string" && (prev ?? null) !== null && prev !== curr;
        const sendDone = eventEnabled(cfg, "issueDone", true) && isDone;
        const sendStatus =
          eventEnabled(cfg, "issueStatusChanged", false) && isAnyStatus && !isDone;
        if (!sendDone && !sendStatus) return;
        const transition = fmtStatusTransition(event, cfg);
        if (!transition) return;
        const head = sendDone ? `✅ <b>Issue done</b>` : `🔁 <b>Issue status changed</b>`;
        const html = [head, transition].join("\n");
        const kb = buildIssueKeyboard(cfg, event.entityId);
        await send("issue.updated", html, kb ? { reply_markup: kb } : {});
      })
    );

    ctx.events.on(
      "issue.comment.created",
      safe("issue.comment.created", async (event) => {
        const cfg = await gate(event, "issueCommentCreated", false);
        if (!cfg) return;
        const html = fmtComment(event, cfg);
        const issueId =
          typeof event.payload?.issueId === "string"
            ? event.payload.issueId
            : event.entityType === "issue"
            ? event.entityId
            : null;
        const kb = buildIssueKeyboard(cfg, issueId);
        await send(
          "issue.comment.created",
          html,
          kb ? { reply_markup: kb } : {}
        );
      })
    );

    // Approvals
    ctx.events.on(
      "approval.created",
      safe("approval.created", async (event) => {
        const cfg = await gate(event, "approvalCreated", true);
        if (!cfg) return;
        const html = fmtApprovalCreated(event, cfg);
        const kb = buildApprovalKeyboard(cfg, event.entityId);
        await send("approval.created", html, kb ? { reply_markup: kb } : {});
      })
    );

    ctx.events.on(
      "approval.decided",
      safe("approval.decided", async (event) => {
        const cfg = await gate(event, "approvalDecided", true);
        if (!cfg) return;
        const html = fmtApprovalDecided(event, cfg);
        const kb = buildApprovalKeyboard(cfg, event.entityId);
        await send("approval.decided", html, kb ? { reply_markup: kb } : {});
      })
    );

    // Agent runs
    ctx.events.on(
      "agent.run.started",
      safe("agent.run.started", async (event) => {
        const cfg = await gate(event, "agentRunStarted", false);
        if (!cfg) return;
        const html = fmtAgentRun("▶️ <b>Agent run started</b>", event, cfg);
        await send("agent.run.started", html);
      })
    );

    ctx.events.on(
      "agent.run.finished",
      safe("agent.run.finished", async (event) => {
        const cfg = await gate(event, "agentRunFinished", false);
        if (!cfg) return;
        const html = fmtAgentRun("🏁 <b>Agent run finished</b>", event, cfg);
        await send("agent.run.finished", html);
      })
    );

    ctx.events.on(
      "agent.run.cancelled",
      safe("agent.run.cancelled", async (event) => {
        const cfg = await gate(event, "agentRunCancelled", false);
        if (!cfg) return;
        const html = fmtAgentRun("🚫 <b>Agent run cancelled</b>", event, cfg);
        await send("agent.run.cancelled", html);
      })
    );

    ctx.events.on(
      "agent.run.failed",
      safe("agent.run.failed", async (event) => {
        const cfg = await gate(event, "agentRunFailed", true);
        if (!cfg) return;
        const html = fmtAgentRun("❌ <b>Agent run failed</b>", event, cfg);
        await send("agent.run.failed", html);
      })
    );

    // Budgets
    ctx.events.on(
      "budget.incident.opened",
      safe("budget.incident.opened", async (event) => {
        const cfg = await gate(event, "budgetIncidentOpened", true);
        if (!cfg) return;
        const html = fmtBudget("💸 <b>Budget incident</b>", event, cfg);
        await send("budget.incident.opened", html);
      })
    );

    ctx.events.on(
      "budget.incident.resolved",
      safe("budget.incident.resolved", async (event) => {
        const cfg = await gate(event, "budgetIncidentResolved", false);
        if (!cfg) return;
        const html = fmtBudget("✅ <b>Budget incident resolved</b>", event, cfg);
        await send("budget.incident.resolved", html);
      })
    );

    // Goals
    ctx.events.on(
      "goal.created",
      safe("goal.created", async (event) => {
        const cfg = await gate(event, "goalCreated", false);
        if (!cfg) return;
        const html = fmtGoal("🎯 <b>Goal created</b>", event, cfg);
        await send("goal.created", html);
      })
    );

    ctx.events.on(
      "goal.updated",
      safe("goal.updated", async (event) => {
        const cfg = await gate(event, "goalUpdated", false);
        if (!cfg) return;
        const html = fmtGoal("🎯 <b>Goal updated</b>", event, cfg);
        await send("goal.updated", html);
      })
    );

    // Bot wiring (webhook + commands) is opportunistic — failures don't
    // stop the plugin from delivering outbound notifications.
    try {
      const cfg = await ctx.config.get();
      await ensureWebhookRegistered(ctx, cfg);
      await ensureCommandsRegistered(ctx, cfg);
    } catch (err) {
      ctx.logger.warn("bot wiring on startup failed", { err: String(err) });
    }

    ctx.logger.info("paperclipai-plugin-telegram setup complete");
  },

  async onWebhook(input) {
    const ctx = pluginCtx;
    if (!ctx) return;
    try {
      const cfg = await ctx.config.get();

      // Optional secret-token verification.
      if (cfg.webhookSecretToken && typeof cfg.webhookSecretToken === "string") {
        const want = cfg.webhookSecretToken.trim();
        if (want) {
          const headerKey = Object.keys(input.headers || {}).find(
            (k) => k.toLowerCase() === "x-telegram-bot-api-secret-token"
          );
          const got = headerKey ? input.headers[headerKey] : null;
          const gotStr = Array.isArray(got) ? got[0] : got;
          if (gotStr !== want) {
            ctx.logger.warn("webhook secret token mismatch — dropping update");
            return;
          }
        }
      }

      const update =
        input.parsedBody && typeof input.parsedBody === "object"
          ? input.parsedBody
          : null;
      if (!update) return;

      if (update.callback_query) {
        const q = update.callback_query;
        if (!inboundAllowed(cfg, q.from?.id)) {
          ctx.logger.warn("callback from non-allowlisted user", { userId: q.from?.id });
          return;
        }
        await handleCallbackQuery(ctx, cfg, q);
        return;
      }

      const message = update.message || update.edited_message;
      if (!message) return;
      if (!inboundAllowed(cfg, message.from?.id)) return;
      if (!cfg.enableCommands) return;
      if (typeof message.text === "string" && message.text.startsWith("/")) {
        await handleCommand(ctx, cfg, message);
      }
    } catch (err) {
      ctx.logger.error("onWebhook handler error", {
        err: String(err),
        stack: err?.stack ? String(err.stack).slice(0, 600) : undefined,
        name: err?.name,
        message: err?.message,
      });
    }
  },

  async onConfigChanged(newConfig) {
    const ctx = pluginCtx;
    if (!ctx) return;
    try {
      await ensureWebhookRegistered(ctx, newConfig);
      await ensureCommandsRegistered(ctx, newConfig);
    } catch (err) {
      ctx.logger.warn("onConfigChanged failed", { err: String(err) });
    }
  },

  async onHealth() {
    return { status: "ok", message: `paperclipai-plugin-telegram v${VERSION}` };
  },

  async onShutdown() {
    // nothing persistent to clean up
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
