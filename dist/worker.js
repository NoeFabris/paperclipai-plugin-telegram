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
const VERSION = "0.5.0";
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

async function dispatchMessage(ctx, cfg, eventType, html, extra = {}, entityRef = null) {
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
  const r = await tg.sendMessage(body);
  if (entityRef && r.ok) {
    await rememberEntityRef(ctx, r, entityRef);
  }
}

// ---------------------------------------------------------------------------
// Reply-to-message → entity tracking
//
// When the plugin sends a notification about an issue or approval, it
// records (chatId, messageId) → {type, id, companyId} in plugin state.
// When a user replies to that Telegram message, onWebhook looks the entity
// up and posts the reply text as a comment on the source entity.
// ---------------------------------------------------------------------------

function entityRefStateKey(chatId, messageId) {
  return `tg:msg:${chatId}:${messageId}`;
}

async function rememberEntityRef(ctx, sendResult, entityRef) {
  const msg = sendResult?.result;
  if (!msg || msg.message_id == null || msg.chat?.id == null) return;
  if (!entityRef || !entityRef.type || !entityRef.id) return;
  try {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: entityRefStateKey(msg.chat.id, msg.message_id),
      },
      {
        type: entityRef.type,
        id: entityRef.id,
        companyId: entityRef.companyId || null,
        savedAt: new Date().toISOString(),
      }
    );
  } catch (err) {
    ctx.logger.warn("state.set failed", { err: String(err) });
  }
}

async function lookupEntityRef(ctx, chatId, messageId) {
  if (chatId == null || messageId == null) return null;
  try {
    return await ctx.state.get({
      scopeKind: "instance",
      stateKey: entityRefStateKey(chatId, messageId),
    });
  } catch (err) {
    ctx.logger.warn("state.get failed", { err: String(err) });
    return null;
  }
}

function viewButton(label, url) {
  return { text: label, url };
}

function callbackButton(label, data) {
  return { text: label, callback_data: data };
}

function buildApprovalKeyboard(cfg, approvalId) {
  const rows = [];
  if (cfg.paperclipApiToken && approvalId) {
    rows.push([
      callbackButton("✅ Approve", `approve:${approvalId}`),
      callbackButton("❌ Reject", `reject:${approvalId}`),
    ]);
  }
  const link = deepLink(cfg, "approval", approvalId);
  if (link) rows.push([viewButton("Open in Paperclip", link)]);
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

function buildIssueKeyboard(cfg, issueId) {
  const link = deepLink(cfg, "issue", issueId);
  if (!link) return null;
  return { inline_keyboard: [[viewButton("Open in Paperclip", link)]] };
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

function formatMoneyCents(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return (
    "$" +
    (cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

async function fetchApproval(ctx, cfg, approvalId) {
  if (!cfg.paperclipPublicUrl || !cfg.paperclipApiToken || !approvalId)
    return null;
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  const url = `${base}/api/approvals/${encodeURIComponent(approvalId)}`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.paperclipApiToken}` },
    });
    if (!res.ok) {
      ctx.logger.warn("fetchApproval non-2xx", { status: res.status, approvalId });
      return null;
    }
    return await res.json();
  } catch (err) {
    ctx.logger.warn("fetchApproval threw", { err: String(err), approvalId });
    return null;
  }
}

/**
 * Render a 1-3 line TLDR for an approval based on its type and payload.
 * Best-effort field probing — payload shape varies by approval type.
 */
function renderApprovalTldr(cfg, approval) {
  if (!approval) return null;
  const type = approval.type || "approval";
  const payload = approval.payload || {};
  switch (type) {
    case "hire_agent": {
      const name = payload.displayName || payload.name || "(unnamed)";
      const adapter = payload.adapterType || payload.adapter || null;
      const role = payload.role || null;
      const budget = formatMoneyCents(payload.budgetMonthlyCents);
      const lines = [`Hire agent <b>${escapeHtml(name)}</b>`];
      const meta = [];
      if (role) meta.push(`role ${fmtCode(role)}`);
      if (adapter) meta.push(`adapter ${fmtCode(adapter)}`);
      if (budget) meta.push(`budget ${escapeHtml(budget)}/mo`);
      if (meta.length > 0) lines.push(meta.join(" · "));
      return lines.join("\n");
    }
    case "approve_ceo_strategy": {
      const summary =
        payload.summary ||
        payload.strategy ||
        payload.title ||
        payload.description;
      const preview = summary ? bodyPreview(cfg, String(summary)) : null;
      return preview ? `<b>Strategy</b>: ${escapeHtml(preview)}` : "CEO strategy approval";
    }
    case "budget_override_required": {
      const amount =
        formatMoneyCents(payload.amountCents) ||
        formatMoneyCents(payload.requestedAmountCents) ||
        formatMoneyCents(payload.newLimitCents);
      const reason = payload.reason || payload.justification || payload.note;
      const lines = [
        `<b>Budget override</b>${amount ? ` (${escapeHtml(amount)})` : ""}`,
      ];
      if (reason) {
        const preview = bodyPreview(cfg, String(reason));
        if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
      }
      return lines.join("\n");
    }
    case "request_board_approval": {
      const subject =
        payload.subject ||
        payload.summary ||
        payload.title ||
        payload.description;
      const preview = subject ? bodyPreview(cfg, String(subject)) : null;
      return preview
        ? `<b>Board approval</b>: ${escapeHtml(preview)}`
        : "Board approval request";
    }
    default: {
      const bits = [];
      for (const [k, v] of Object.entries(payload).slice(0, 4)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          bits.push(`${escapeHtml(k)}: ${fmtCode(String(v).slice(0, 80))}`);
        }
      }
      return bits.length > 0 ? bits.join(" · ") : null;
    }
  }
}

async function fmtApprovalCreated(ctx, event, cfg) {
  const approvalId = event.entityId;
  const eventPayload = event.payload || {};
  const lines = [`🟡 <b>Approval requested</b>`];
  const approval = await fetchApproval(ctx, cfg, approvalId);
  if (approval) {
    const tldr = renderApprovalTldr(cfg, approval);
    if (tldr) lines.push(tldr);
    const who = approval.requestedByAgentId
      ? `agent ${fmtCode(fmtIdShort(approval.requestedByAgentId))}`
      : approval.requestedByUserId
      ? `user ${fmtCode(fmtIdShort(approval.requestedByUserId))}`
      : null;
    if (who) lines.push(`<i>requested by ${who}</i>`);
  } else {
    if (typeof eventPayload.type === "string")
      lines.push(`type ${fmtCode(eventPayload.type)}`);
    const ctxBits = [];
    if (typeof eventPayload.linkedAgentId === "string")
      ctxBits.push(`agent ${fmtCode(fmtIdShort(eventPayload.linkedAgentId))}`);
    if (typeof eventPayload.managedResourceKey === "string")
      ctxBits.push(`key ${fmtCode(eventPayload.managedResourceKey)}`);
    if (Array.isArray(eventPayload.issueIds) && eventPayload.issueIds.length > 0)
      ctxBits.push(`${eventPayload.issueIds.length} issue(s)`);
    if (ctxBits.length > 0) lines.push(ctxBits.join(" · "));
    if (!cfg.paperclipApiToken) {
      lines.push(`<i>set paperclipApiToken in plugin config to enable rich TLDR + one-tap approve/reject</i>`);
    }
  }
  return lines.join("\n");
}

async function fmtApprovalDecided(ctx, event, cfg) {
  const approvalId = event.entityId;
  const eventPayload = event.payload || {};
  const approval = await fetchApproval(ctx, cfg, approvalId);
  const status =
    (approval && approval.status) ||
    (typeof eventPayload.outcome === "string" ? eventPayload.outcome : null) ||
    (typeof eventPayload.decision === "string" ? eventPayload.decision : null) ||
    "decided";
  const emoji = statusEmoji(status);
  const lines = [`${emoji} <b>Approval ${escapeHtml(status)}</b>`];
  if (approval) {
    const tldr = renderApprovalTldr(cfg, approval);
    if (tldr) lines.push(tldr);
    if (approval.decisionNote) {
      const preview = bodyPreview(cfg, String(approval.decisionNote));
      if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
    }
    if (approval.decidedByUserId)
      lines.push(`<i>by ${fmtCode(fmtIdShort(approval.decidedByUserId))}</i>`);
  } else {
    if (typeof eventPayload.type === "string")
      lines.push(`type ${fmtCode(eventPayload.type)}`);
    if (typeof eventPayload.decisionNote === "string") {
      const preview = bodyPreview(cfg, eventPayload.decisionNote);
      if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
    }
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
      { command: "status", description: "Plugin + instance status & counts" },
      { command: "issues", description: "Recent issues" },
      { command: "open", description: "Show one issue (/open PCL-123)" },
      { command: "new", description: "Create an issue (/new <title>)" },
      { command: "comment", description: "Comment on an issue (/comment <id> <text>)" },
      { command: "approvals", description: "List pending approvals" },
      { command: "agents", description: "List agents and their status" },
      { command: "pause", description: "Pause an agent (/pause <id or name>)" },
      { command: "resume", description: "Resume an agent (/resume <id or name>)" },
    ],
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by command handlers
// ---------------------------------------------------------------------------

function isUuidLike(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

async function resolveCompanyId(ctx, cfg) {
  if (
    typeof cfg.defaultCompanyId === "string" &&
    cfg.defaultCompanyId.trim().length > 0
  )
    return cfg.defaultCompanyId.trim();
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  return companies.length > 0 ? companies[0].id : null;
}

async function resolveProjectId(ctx, cfg, companyId) {
  if (
    typeof cfg.defaultProjectId === "string" &&
    cfg.defaultProjectId.trim().length > 0
  )
    return cfg.defaultProjectId.trim();
  if (!companyId) return null;
  const projects = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(companyId)}/projects`)
  );
  return projects.length > 0 ? projects[0].id : null;
}

async function fetchPendingApprovals(ctx, cfg, companyId) {
  if (!cfg.paperclipPublicUrl || !cfg.paperclipApiToken || !companyId)
    return null;
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(
      `${base}/api/companies/${encodeURIComponent(companyId)}/approvals`,
      { headers: { authorization: `Bearer ${cfg.paperclipApiToken}` } }
    );
    if (!res.ok) {
      ctx.logger.warn("approvals list non-2xx", { status: res.status });
      return null;
    }
    const data = await res.json();
    const arr = Array.isArray(data) ? data : data?.items || [];
    return arr.filter((a) => a && a.status === "pending");
  } catch (err) {
    ctx.logger.warn("approvals list threw", { err: String(err) });
    return null;
  }
}

async function sendReply(ctx, cfg, message, html, extra = {}, entityRef = null) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const body = {
    chat_id: message.chat.id,
    text: clampMessage(html),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  if (message.message_thread_id != null)
    body.message_thread_id = message.message_thread_id;
  const r = await tg.sendMessage(body);
  if (entityRef && r.ok) {
    await rememberEntityRef(ctx, r, entityRef);
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function helpText() {
  return [
    "<b>Paperclip Telegram bot</b>",
    `<i>v${VERSION}</i>`,
    "",
    "<b>Read</b>",
    "<code>/status</code>          — plugin + instance counts",
    "<code>/issues</code>          — recent issues",
    "<code>/open &lt;id&gt;</code>       — show one issue (identifier or UUID)",
    "<code>/approvals</code>       — list pending approvals",
    "<code>/agents</code>          — list agents and their status",
    "",
    "<b>Write</b>",
    "<code>/new &lt;title&gt;</code>     — create an issue in the default project",
    "<code>/comment &lt;id&gt; &lt;text&gt;</code> — add a comment to an issue",
    "<code>/pause &lt;agent&gt;</code>   — pause an agent",
    "<code>/resume &lt;agent&gt;</code>  — resume an agent",
    "",
    "<b>Reply</b>",
    "Replying to any notification posts the reply as a comment on the source issue or approval.",
    "",
    "<code>/help</code>             — this message",
  ].join("\n");
}

async function handleStatusCommand(ctx, cfg, message) {
  const lines = [
    `<b>paperclipai-plugin-telegram</b> v${VERSION}`,
    `plugin id: ${fmtCode(process.env.PAPERCLIP_PLUGIN_ID || "?")}`,
    `default chat: ${fmtCode(cfg.defaultChatId || "?")}`,
    `mutation api: ${cfg.paperclipApiToken ? "✅ configured" : "❌ disabled"}`,
  ];
  const companyId = await resolveCompanyId(ctx, cfg);
  if (companyId) {
    const companies = asArray(await pcGet(ctx, cfg, "/companies"));
    const company = companies.find((c) => c.id === companyId);
    if (company)
      lines.push(
        `company: ${escapeHtml(company.name || fmtIdShort(companyId))}`
      );
    const issues = asArray(
      await pcGet(
        ctx,
        cfg,
        `/companies/${encodeURIComponent(companyId)}/issues?limit=100`
      )
    );
    const openCount = issues.filter(
      (i) => i.status !== "done" && i.status !== "cancelled"
    ).length;
    lines.push(`open issues: ${fmtCode(String(openCount))}`);
    const agents = asArray(
      await pcGet(
        ctx,
        cfg,
        `/companies/${encodeURIComponent(companyId)}/agents`
      )
    );
    lines.push(`agents: ${fmtCode(String(agents.length))}`);
    const pending = await fetchPendingApprovals(ctx, cfg, companyId);
    if (Array.isArray(pending))
      lines.push(`pending approvals: ${fmtCode(String(pending.length))}`);
  }
  await sendReply(ctx, cfg, message, lines.join("\n"));
}

async function handleIssuesCommand(ctx, cfg, message) {
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) {
    await sendReply(ctx, cfg, message, "No company visible to this plugin.");
    return;
  }
  const listed = asArray(
    await pcGet(
      ctx,
      cfg,
      `/companies/${encodeURIComponent(companyId)}/issues?limit=${COMMAND_MAX_ISSUES}`
    )
  );
  const lines = [`<b>Recent issues</b>`];
  if (!Array.isArray(listed) || listed.length === 0) {
    lines.push("<i>(none)</i>");
  } else {
    for (const issue of listed.slice(0, COMMAND_MAX_ISSUES)) {
      const ident = issue.identifier || fmtIdShort(issue.id || "");
      const title = issue.title || "(untitled)";
      const status = issue.status || "?";
      const link = deepLink(cfg, "issue", issue.id);
      const label = link
        ? `<a href="${escapeHtml(link)}">${escapeHtml(ident)}</a>`
        : `<b>${escapeHtml(ident)}</b>`;
      lines.push(
        `${statusEmoji(status)} ${label} — ${escapeHtml(truncate(title, 80))}`
      );
    }
  }
  await sendReply(ctx, cfg, message, lines.join("\n"));
}

async function handleOpenCommand(ctx, cfg, message, args) {
  const arg = (args || "").trim();
  if (!arg) {
    await sendReply(
      ctx,
      cfg,
      message,
      "Usage: <code>/open &lt;identifier or UUID&gt;</code>"
    );
    return;
  }
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) {
    await sendReply(ctx, cfg, message, "No company visible to this plugin.");
    return;
  }
  let issue = null;
  if (isUuidLike(arg)) {
    issue = await pcGet(ctx, cfg, `/issues/${encodeURIComponent(arg)}`);
  } else {
    const issues = asArray(
      await pcGet(
        ctx,
        cfg,
        `/companies/${encodeURIComponent(companyId)}/issues?limit=200`
      )
    );
    const needle = arg.toLowerCase();
    issue =
      issues.find(
        (i) =>
          typeof i.identifier === "string" &&
          i.identifier.toLowerCase() === needle
      ) || null;
  }
  if (!issue) {
    await sendReply(ctx, cfg, message, `Issue not found: ${fmtCode(arg)}`);
    return;
  }
  const ident = issue.identifier || fmtIdShort(issue.id);
  const lines = [
    `<b>${escapeHtml(ident)}</b> ${escapeHtml(issue.title || "(untitled)")}`,
  ];
  const meta = [];
  if (issue.status)
    meta.push(`${statusEmoji(issue.status)} ${fmtCode(issue.status)}`);
  if (issue.priority) meta.push(`priority ${fmtCode(issue.priority)}`);
  if (issue.assigneeAgentId)
    meta.push(`agent ${fmtCode(fmtIdShort(issue.assigneeAgentId))}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const preview = bodyPreview(cfg, issue.description);
  if (preview) lines.push(`<i>${escapeHtml(preview)}</i>`);
  const kb = buildIssueKeyboard(cfg, issue.id);
  await sendReply(
    ctx,
    cfg,
    message,
    lines.join("\n"),
    kb ? { reply_markup: kb } : {}
  );
}

async function handleNewCommand(ctx, cfg, message, args) {
  const title = (args || "").trim();
  if (!title) {
    await sendReply(
      ctx,
      cfg,
      message,
      "Usage: <code>/new &lt;issue title&gt;</code>"
    );
    return;
  }
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) {
    await sendReply(ctx, cfg, message, "No company visible to this plugin.");
    return;
  }
  const projectId = await resolveProjectId(ctx, cfg, companyId);
  const result = await callPaperclip(
    ctx,
    cfg,
    `/companies/${encodeURIComponent(companyId)}/issues`,
    {
      ...(projectId ? { projectId } : {}),
      title: title.slice(0, 200),
    }
  );
  if (!result.ok) {
    ctx.logger.warn("issue create failed", { status: result.status });
    await sendReply(
      ctx,
      cfg,
      message,
      `Failed to create issue (${result.status}): ${fmtCode(
        truncate(JSON.stringify(result.body || {}), 200)
      )}`
    );
    return;
  }
  const issue = result.body || {};
  const ident = issue.identifier || fmtIdShort(issue.id);
  const lines = [
    `✅ Created <b>${escapeHtml(ident)}</b>`,
    escapeHtml(issue.title || ""),
  ];
  const kb = buildIssueKeyboard(cfg, issue.id);
  await sendReply(
    ctx,
    cfg,
    message,
    lines.join("\n"),
    kb ? { reply_markup: kb } : {}
  );
}

async function handleApprovalsCommand(ctx, cfg, message) {
  if (!cfg.paperclipApiToken) {
    await sendReply(
      ctx,
      cfg,
      message,
      "<i>Set paperclipApiToken in plugin config to list approvals.</i>"
    );
    return;
  }
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) return;
  const pending = await fetchPendingApprovals(ctx, cfg, companyId);
  if (!Array.isArray(pending)) {
    await sendReply(ctx, cfg, message, "Could not fetch approvals.");
    return;
  }
  if (pending.length === 0) {
    await sendReply(ctx, cfg, message, "<b>Pending approvals</b>\n<i>(none)</i>");
    return;
  }
  const lines = [`<b>Pending approvals (${pending.length})</b>`];
  for (const a of pending.slice(0, 20)) {
    const tldr = renderApprovalTldr(cfg, a);
    const head = `🟡 ${fmtCode(fmtIdShort(a.id))}`;
    const subject = tldr ? tldr.split("\n")[0] : `type ${fmtCode(a.type)}`;
    const link = deepLink(cfg, "approval", a.id);
    const headLinked = link
      ? `🟡 <a href="${escapeHtml(link)}">${escapeHtml(fmtIdShort(a.id))}</a>`
      : head;
    lines.push(`${headLinked} — ${subject}`);
  }
  await sendReply(ctx, cfg, message, lines.join("\n"));
}

async function handleAgentsCommand(ctx, cfg, message) {
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) return;
  const agents = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(companyId)}/agents`)
  );
  if (!Array.isArray(agents) || agents.length === 0) {
    await sendReply(ctx, cfg, message, "<b>Agents</b>\n<i>(none)</i>");
    return;
  }
  const lines = [`<b>Agents (${agents.length})</b>`];
  for (const a of agents.slice(0, 25)) {
    const name = a.displayName || a.name || fmtIdShort(a.id || "");
    const status = a.status || "?";
    const role = a.role || null;
    const bits = [`${statusEmoji(status)} <b>${escapeHtml(name)}</b>`];
    if (role) bits.push(fmtCode(role));
    bits.push(fmtCode(status));
    lines.push(bits.join(" · "));
  }
  await sendReply(ctx, cfg, message, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Reply → comment on the referenced entity
// ---------------------------------------------------------------------------

async function handleReplyAsComment(ctx, cfg, message) {
  const replyToId = message.reply_to_message?.message_id;
  const ref = await lookupEntityRef(ctx, message.chat.id, replyToId);
  if (!ref || !ref.type || !ref.id) {
    await sendReply(
      ctx,
      cfg,
      message,
      "<i>Reply detected, but the original notification is no longer tracked. Use <code>/comment &lt;id&gt; …</code> to comment directly.</i>"
    );
    return;
  }
  if (!cfg.paperclipApiToken) {
    await sendReply(
      ctx,
      cfg,
      message,
      "<i>Set <code>paperclipApiToken</code> in plugin config to enable reply → comment.</i>"
    );
    return;
  }
  const body = (message.text || "").trim();
  if (!body) return;
  let pathRel = null;
  if (ref.type === "issue") pathRel = `/issues/${encodeURIComponent(ref.id)}/comments`;
  else if (ref.type === "approval")
    pathRel = `/approvals/${encodeURIComponent(ref.id)}/comments`;
  if (!pathRel) {
    await sendReply(
      ctx,
      cfg,
      message,
      `<i>Replies are not yet supported for entity type ${fmtCode(ref.type)}.</i>`
    );
    return;
  }
  const result = await callPaperclip(ctx, cfg, pathRel, { body });
  if (result.ok) {
    const idLabel = ref.type === "issue" ? "issue" : "approval";
    await sendReply(
      ctx,
      cfg,
      message,
      `💬 Comment posted on ${idLabel} ${fmtCode(fmtIdShort(ref.id))}`,
      {},
      ref
    );
  } else {
    await sendReply(
      ctx,
      cfg,
      message,
      `Failed to post comment (${result.status}): ${fmtCode(
        truncate(JSON.stringify(result.body || {}), 200)
      )}`
    );
  }
}

// ---------------------------------------------------------------------------
// Agent + comment commands
// ---------------------------------------------------------------------------

async function resolveAgentId(ctx, cfg, arg) {
  const needle = String(arg || "").trim();
  if (!needle) return null;
  if (isUuidLike(needle)) return needle;
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) return null;
  const agents = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(companyId)}/agents`)
  );
  const lower = needle.toLowerCase();
  // Try id prefix, then exact name/displayName, then prefix match.
  let match = agents.find((a) => a.id && a.id.startsWith(needle));
  if (!match)
    match = agents.find(
      (a) =>
        (a.displayName && a.displayName.toLowerCase() === lower) ||
        (a.name && a.name.toLowerCase() === lower)
    );
  if (!match)
    match = agents.find(
      (a) =>
        (a.displayName && a.displayName.toLowerCase().startsWith(lower)) ||
        (a.name && a.name.toLowerCase().startsWith(lower))
    );
  return match?.id || null;
}

async function resolveIssueId(ctx, cfg, arg) {
  const needle = String(arg || "").trim();
  if (!needle) return null;
  if (isUuidLike(needle)) return needle;
  const companyId = await resolveCompanyId(ctx, cfg);
  if (!companyId) return null;
  const issues = asArray(
    await pcGet(
      ctx,
      cfg,
      `/companies/${encodeURIComponent(companyId)}/issues?limit=200`
    )
  );
  const lower = needle.toLowerCase();
  return (
    issues.find(
      (i) =>
        typeof i.identifier === "string" &&
        i.identifier.toLowerCase() === lower
    )?.id || null
  );
}

async function handleCommentCommand(ctx, cfg, message, args) {
  const parts = String(args || "").trim().split(/\s+/);
  const ref = parts.shift();
  const body = parts.join(" ").trim();
  if (!ref || !body) {
    await sendReply(
      ctx,
      cfg,
      message,
      "Usage: <code>/comment &lt;issue id or identifier&gt; &lt;text&gt;</code>"
    );
    return;
  }
  const issueId = await resolveIssueId(ctx, cfg, ref);
  if (!issueId) {
    await sendReply(ctx, cfg, message, `Issue not found: ${fmtCode(ref)}`);
    return;
  }
  const result = await callPaperclip(
    ctx,
    cfg,
    `/issues/${encodeURIComponent(issueId)}/comments`,
    { body }
  );
  if (result.ok) {
    await sendReply(
      ctx,
      cfg,
      message,
      `💬 Comment posted on ${fmtCode(ref)}`,
      {},
      { type: "issue", id: issueId }
    );
  } else {
    await sendReply(
      ctx,
      cfg,
      message,
      `Failed (${result.status}): ${fmtCode(
        truncate(JSON.stringify(result.body || {}), 200)
      )}`
    );
  }
}

async function handleAgentLifecycle(ctx, cfg, message, args, action) {
  const arg = String(args || "").trim();
  if (!arg) {
    await sendReply(
      ctx,
      cfg,
      message,
      `Usage: <code>/${action} &lt;agent id or name&gt;</code>`
    );
    return;
  }
  const agentId = await resolveAgentId(ctx, cfg, arg);
  if (!agentId) {
    await sendReply(ctx, cfg, message, `Agent not found: ${fmtCode(arg)}`);
    return;
  }
  const result = await callPaperclip(
    ctx,
    cfg,
    `/agents/${encodeURIComponent(agentId)}/${action}`,
    {}
  );
  if (result.ok) {
    const agent = result.body || {};
    const name = agent.displayName || agent.name || fmtIdShort(agentId);
    const status = agent.status || "?";
    await sendReply(
      ctx,
      cfg,
      message,
      `${statusEmoji(status)} <b>${escapeHtml(name)}</b> → ${fmtCode(status)}`
    );
  } else {
    await sendReply(
      ctx,
      cfg,
      message,
      `Failed to ${action} (${result.status}): ${fmtCode(
        truncate(JSON.stringify(result.body || {}), 200)
      )}`
    );
  }
}

async function handleCommand(ctx, cfg, message) {
  const text = String(message.text || "").trim();
  const m = text.match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const args = m[2] || "";
  switch (cmd) {
    case "start":
    case "help":
      await sendReply(ctx, cfg, message, helpText());
      return true;
    case "status":
      await handleStatusCommand(ctx, cfg, message);
      return true;
    case "issues":
      await handleIssuesCommand(ctx, cfg, message);
      return true;
    case "open":
      await handleOpenCommand(ctx, cfg, message, args);
      return true;
    case "new":
      await handleNewCommand(ctx, cfg, message, args);
      return true;
    case "approvals":
      await handleApprovalsCommand(ctx, cfg, message);
      return true;
    case "agents":
      await handleAgentsCommand(ctx, cfg, message);
      return true;
    case "comment":
      await handleCommentCommand(ctx, cfg, message, args);
      return true;
    case "pause":
      await handleAgentLifecycle(ctx, cfg, message, args, "pause");
      return true;
    case "resume":
      await handleAgentLifecycle(ctx, cfg, message, args, "resume");
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Callback query handler (Approve / Reject)
// ---------------------------------------------------------------------------

/**
 * GET against the Paperclip REST API.
 *
 * Used by bot commands (/issues, /new, /open, /agents, /approvals, /status
 * counts) because handlers running inside onWebhook do not have an
 * invocation scope — the host rejects company-scoped ctx.* calls with
 * "missing, expired, or unknown invocation scope". Authenticated REST does
 * not have that constraint.
 */
async function pcGet(ctx, cfg, pathRel) {
  if (!cfg.paperclipPublicUrl || !cfg.paperclipApiToken) return null;
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api${pathRel}`, {
      headers: { authorization: `Bearer ${cfg.paperclipApiToken}` },
    });
    if (!res.ok) {
      ctx.logger.warn("pcGet non-2xx", { status: res.status, pathRel });
      return null;
    }
    return await res.json();
  } catch (err) {
    ctx.logger.warn("pcGet threw", { err: String(err), pathRel });
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : value?.items || [];
}

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
    const who = escapeHtml(
      query.from?.username || query.from?.first_name || "user"
    );
    const decoration = action === "approve"
      ? `\n\n<b>✅ Approved</b> by ${who}`
      : `\n\n<b>❌ Rejected</b> by ${who}`;
    // Replace the action buttons with just the deep-link button so the user
    // can still open the approval in Paperclip for context, but can't
    // double-decide.
    const link = deepLink(cfg, "approval", approvalId);
    const replacement = link
      ? { inline_keyboard: [[viewButton("Open in Paperclip", link)]] }
      : { inline_keyboard: [] };
    await tg.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: clampMessage(original + decoration),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replacement,
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

    async function send(eventType, html, opts = {}, entityRef = null) {
      const cfg = await ctx.config.get();
      await dispatchMessage(ctx, cfg, eventType, html, opts, entityRef);
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
        await send(
          "issue.created",
          html,
          kb ? { reply_markup: kb } : {},
          { type: "issue", id: event.entityId, companyId: event.companyId }
        );
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
        await send(
          "issue.updated",
          html,
          kb ? { reply_markup: kb } : {},
          { type: "issue", id: event.entityId, companyId: event.companyId }
        );
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
          kb ? { reply_markup: kb } : {},
          issueId
            ? { type: "issue", id: issueId, companyId: event.companyId }
            : null
        );
      })
    );

    // Approvals
    ctx.events.on(
      "approval.created",
      safe("approval.created", async (event) => {
        const cfg = await gate(event, "approvalCreated", true);
        if (!cfg) return;
        const html = await fmtApprovalCreated(ctx, event, cfg);
        const kb = buildApprovalKeyboard(cfg, event.entityId);
        await send(
          "approval.created",
          html,
          kb ? { reply_markup: kb } : {},
          { type: "approval", id: event.entityId, companyId: event.companyId }
        );
      })
    );

    ctx.events.on(
      "approval.decided",
      safe("approval.decided", async (event) => {
        const cfg = await gate(event, "approvalDecided", true);
        if (!cfg) return;
        const html = await fmtApprovalDecided(ctx, event, cfg);
        // No action buttons on already-decided approvals; just a deep link.
        const link = deepLink(cfg, "approval", event.entityId);
        const kb = link
          ? { inline_keyboard: [[viewButton("Open in Paperclip", link)]] }
          : null;
        await send(
          "approval.decided",
          html,
          kb ? { reply_markup: kb } : {},
          { type: "approval", id: event.entityId, companyId: event.companyId }
        );
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

      // Reply-to-notification → comment on the referenced entity.
      // This branch fires regardless of enableCommands; without it the
      // primary bidirectional UX is unreachable.
      if (
        message.reply_to_message &&
        typeof message.text === "string" &&
        message.text.trim().length > 0 &&
        !message.text.startsWith("/")
      ) {
        await handleReplyAsComment(ctx, cfg, message);
        return;
      }

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
