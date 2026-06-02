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
const VERSION = "0.9.0";
const COMMAND_MAX_ISSUES = 10;
const TELEGRAM_HARD_LIMIT = 4000; // Bot API limit is 4096; keep a margin.

// Captured during setup() so onWebhook / onConfigChanged can reuse the host
// context the SDK does not pass them directly.
let pluginCtx = null;

// Process-local cache of companyId → display name. Populated lazily by
// event handlers (which have invocation scope and can call ctx.companies.get)
// so every notification carries the source workspace label without a REST
// round-trip per event.
const companyNameCache = new Map();

async function getCompanyName(ctx, companyId) {
  if (!companyId) return null;
  if (companyNameCache.has(companyId)) return companyNameCache.get(companyId);
  try {
    const c = await ctx.companies.get(companyId);
    const name = c?.name || null;
    companyNameCache.set(companyId, name);
    return name;
  } catch {
    companyNameCache.set(companyId, null);
    return null;
  }
}

function workspaceTag(name) {
  return name ? ` · 🏢 ${escapeHtml(name)}` : "";
}

// Approvals decided via Telegram inline buttons within the last
// DECIDED_TTL_MS are suppressed on the approval.decided notification
// path — the user already saw the decision reflected in-place on the
// original message and doesn't need a duplicate ping.
const DECIDED_TTL_MS = 60_000;
const recentlyDecidedViaTelegram = new Map();
function markRecentlyDecidedViaTelegram(approvalId) {
  if (!approvalId) return;
  recentlyDecidedViaTelegram.set(approvalId, Date.now() + DECIDED_TTL_MS);
}
function wasRecentlyDecidedViaTelegram(approvalId) {
  if (!approvalId) return false;
  const exp = recentlyDecidedViaTelegram.get(approvalId);
  if (!exp) return false;
  if (exp < Date.now()) {
    recentlyDecidedViaTelegram.delete(approvalId);
    return false;
  }
  return true;
}

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
  // Per-project topic override: if the event carries a projectId and the
  // destination chat has a /topics mapping for it, route into that topic.
  // The mapping is keyed off the *routed* chat (the place the notification
  // actually lands), not whatever chat ran /topics — those are usually the
  // same in practice, and explicitly tying the mapping to the destination
  // keeps the override predictable from inside the chat.
  let topicId = route.topicId;
  const projectId = entityRef?.projectId;
  if (projectId) {
    try {
      const map = await getChatProjectTopics(ctx, route.chatId);
      const mapped = map[projectId];
      if (Number.isInteger(mapped)) topicId = mapped;
    } catch (err) {
      ctx.logger.warn("project topic lookup failed", { err: String(err) });
    }
  }
  const tg = createTelegram(ctx, token);
  const body = {
    chat_id: route.chatId,
    text: clampMessage(html),
    parse_mode: cfg.parseMode === "MarkdownV2" ? "MarkdownV2" : "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  if (topicId != null) body.message_thread_id = topicId;
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

function buildApprovalKeyboard(cfg, approvalId, view = "note") {
  const rows = [];
  if (cfg.paperclipApiToken && approvalId) {
    rows.push([
      callbackButton("✅ Approve", `approve.${view}:${approvalId}`),
      callbackButton("❌ Reject", `reject.${view}:${approvalId}`),
      callbackButton("💬 Comment", `approval.comment.${view}:${approvalId}`),
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

// Per-issue button row used inside a list view and in /open detail. The
// "view" argument is stamped into callback_data so the callback handler
// knows whether to re-render the list, the single-issue detail, or just
// pop a confirmation.
function buildIssueActionRow(cfg, issue, view) {
  const row = [];
  const link = deepLink(cfg, "issue", issue.id);
  if (link)
    row.push(viewButton(`👁 ${issue.identifier || fmtIdShort(issue.id)}`, link));
  if (issue.id) {
    if (issue.status === "done") {
      row.push(callbackButton("🔁 Reopen", `issue.reopen.${view}:${issue.id}`));
    } else {
      row.push(callbackButton("✅ Done", `issue.done.${view}:${issue.id}`));
    }
    row.push(callbackButton("💬 Comment", `issue.comment.${view}:${issue.id}`));
  }
  return row;
}

function buildAgentActionRow(agent, view) {
  if (!agent?.id) return [];
  const row = [];
  if (agent.status === "paused") {
    row.push(callbackButton("▶️ Resume", `agent.resume.${view}:${agent.id}`));
  } else if (agent.status !== "terminated") {
    row.push(callbackButton("⏸ Pause", `agent.pause.${view}:${agent.id}`));
  }
  return row;
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
      { command: "workspaces", description: "List workspaces (companies)" },
      { command: "use", description: "Switch active workspace (/use <name>)" },
      { command: "connect", description: "Bind this chat to a workspace (/connect <name>)" },
      { command: "issues", description: "Recent issues (with action buttons)" },
      { command: "open", description: "Show one issue (/open PCL-123)" },
      { command: "new", description: "Create an issue (/new <title>)" },
      { command: "comment", description: "Comment on an issue (/comment <id> <text>)" },
      { command: "done", description: "Mark issue done (/done <id>)" },
      { command: "reopen", description: "Reopen an issue (/reopen <id>)" },
      { command: "approvals", description: "List pending approvals" },
      { command: "approve", description: "Approve an approval (/approve <id>)" },
      { command: "reject", description: "Reject an approval (/reject <id>)" },
      { command: "agents", description: "List agents and their status" },
      { command: "pause", description: "Pause an agent (/pause <id or name>)" },
      { command: "resume", description: "Resume an agent (/resume <id or name>)" },
      { command: "topics", description: "Per-chat project → topic routing (/topics list|add|remove|clear)" },
      { command: "digest", description: "On-demand 24h workspace digest" },
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

// Per-Telegram-user "active workspace" persisted in plugin state.
// Each user can switch independently via /use <name>; commands then resolve
// company in the order: per-user active → cfg.defaultCompanyId → first visible.
async function getUserActiveCompany(ctx, userId) {
  if (!userId) return null;
  try {
    const v = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `tg:user:${userId}:activeCompany`,
    });
    return v && typeof v.companyId === "string" ? v.companyId : null;
  } catch (err) {
    ctx.logger.warn("getUserActiveCompany failed", { err: String(err) });
    return null;
  }
}

async function setUserActiveCompany(ctx, userId, companyId) {
  if (!userId || !companyId) return;
  try {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: `tg:user:${userId}:activeCompany`,
      },
      { companyId, savedAt: new Date().toISOString() }
    );
  } catch (err) {
    ctx.logger.warn("setUserActiveCompany failed", { err: String(err) });
  }
}

// Per-chat "connected workspace" persisted in plugin state. Set via
// /connect <company>; takes precedence over the per-user active workspace
// so a dedicated workspace channel always reads the same company even when
// different humans run commands in it.
async function getChatConnectedCompany(ctx, chatId) {
  if (chatId == null) return null;
  try {
    const v = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `tg:chat:${chatId}:connectedCompany`,
    });
    return v && typeof v.companyId === "string" ? v.companyId : null;
  } catch (err) {
    ctx.logger.warn("getChatConnectedCompany failed", { err: String(err) });
    return null;
  }
}

async function setChatConnectedCompany(ctx, chatId, companyId) {
  if (chatId == null || !companyId) return;
  try {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: `tg:chat:${chatId}:connectedCompany`,
      },
      { companyId, savedAt: new Date().toISOString() }
    );
  } catch (err) {
    ctx.logger.warn("setChatConnectedCompany failed", { err: String(err) });
  }
}

// Per-chat project → topic mapping. When an event has a `payload.projectId`
// that matches a key here, resolveRoute's topicId is overridden so the
// notification lands in the project-specific forum topic.
async function getChatProjectTopics(ctx, chatId) {
  if (chatId == null) return {};
  try {
    const v = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `tg:chat:${chatId}:projectTopics`,
    });
    return v && typeof v === "object" && v.map && typeof v.map === "object"
      ? v.map
      : {};
  } catch (err) {
    ctx.logger.warn("getChatProjectTopics failed", { err: String(err) });
    return {};
  }
}

async function setChatProjectTopics(ctx, chatId, map) {
  if (chatId == null) return;
  try {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: `tg:chat:${chatId}:projectTopics`,
      },
      { map: map || {}, savedAt: new Date().toISOString() }
    );
  } catch (err) {
    ctx.logger.warn("setChatProjectTopics failed", { err: String(err) });
  }
}

async function resolveCompanyId(ctx, cfg, userId = null, chatId = null) {
  // Order: per-chat connected → per-user active → cfg.defaultCompanyId →
  // first visible. chatId is optional so existing call sites that only
  // know the user keep working (they just skip the chat tier).
  const chatConnected = await getChatConnectedCompany(ctx, chatId);
  if (chatConnected) return chatConnected;
  const userActive = await getUserActiveCompany(ctx, userId);
  if (userActive) return userActive;
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
    "<b>Workspaces</b>",
    "<code>/workspaces</code>      — list companies, mark the active one",
    "<code>/use &lt;name&gt;</code>      — switch your active workspace",
    "<code>/connect &lt;name&gt;</code>  — bind this chat to a workspace",
    "",
    "<b>Read</b>",
    "<code>/status</code>          — plugin + active workspace counts",
    "<code>/issues</code>          — recent issues, each with action buttons",
    "<code>/open &lt;id&gt;</code>       — show one issue (identifier or UUID)",
    "<code>/approvals</code>       — list pending approvals",
    "<code>/agents</code>          — list agents and their status",
    "<code>/digest</code>          — on-demand 24h summary for active workspace",
    "",
    "<b>Write</b>",
    "<code>/new &lt;title&gt;</code>     — create an issue in the default project",
    "<code>/comment &lt;id&gt; &lt;text&gt;</code> — add a comment to an issue",
    "<code>/done &lt;id&gt;</code>       — mark issue done",
    "<code>/reopen &lt;id&gt;</code>     — reopen a closed issue",
    "<code>/approve &lt;id&gt;</code>    — approve an approval (UUID or 8-char prefix)",
    "<code>/reject &lt;id&gt;</code>     — reject an approval (UUID or 8-char prefix)",
    "<code>/pause &lt;agent&gt;</code>   — pause an agent",
    "<code>/resume &lt;agent&gt;</code>  — resume an agent",
    "",
    "<b>Routing</b>",
    "<code>/topics list</code>       — show per-project topic mappings for this chat",
    "<code>/topics add &lt;project&gt; &lt;topicId&gt;</code> — route a project's events to a forum topic",
    "<code>/topics remove &lt;project&gt;</code> — drop a mapping",
    "<code>/topics clear</code>      — drop all mappings for this chat",
    "",
    "<b>Reply / inline buttons</b>",
    "Replying to any notification (or the 💬 Comment prompt) posts the reply as a comment on the source entity. /issues rows include ✅ Done / 🔁 Reopen / 💬 Comment buttons that act on your behalf.",
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
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
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

function renderIssuesListView(cfg, issues) {
  const lines = [`<b>Recent issues</b>`];
  const inlineKeyboard = [];
  if (!Array.isArray(issues) || issues.length === 0) {
    lines.push("<i>(none)</i>");
  } else {
    for (const issue of issues.slice(0, COMMAND_MAX_ISSUES)) {
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
      const row = buildIssueActionRow(cfg, issue, "list");
      if (row.length > 0) inlineKeyboard.push(row);
    }
  }
  return {
    text: lines.join("\n"),
    reply_markup:
      inlineKeyboard.length > 0
        ? { inline_keyboard: inlineKeyboard }
        : undefined,
  };
}

async function handleIssuesCommand(ctx, cfg, message) {
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
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
  const view = renderIssuesListView(cfg, listed);
  await sendReply(
    ctx,
    cfg,
    message,
    view.text,
    view.reply_markup ? { reply_markup: view.reply_markup } : {}
  );
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
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
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
  const view = renderIssueDetailView(cfg, issue);
  await sendReply(
    ctx,
    cfg,
    message,
    view.text,
    view.reply_markup ? { reply_markup: view.reply_markup } : {}
  );
}

function renderIssueDetailView(cfg, issue) {
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
  const row = buildIssueActionRow(cfg, issue, "open");
  return {
    text: lines.join("\n"),
    reply_markup: row.length > 0 ? { inline_keyboard: [row] } : undefined,
  };
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
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
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

function renderApprovalsListView(cfg, pending) {
  if (!Array.isArray(pending) || pending.length === 0) {
    return {
      text: "<b>Pending approvals</b>\n<i>(none)</i>",
      reply_markup: undefined,
    };
  }
  const lines = [`<b>Pending approvals (${pending.length})</b>`];
  const inlineKeyboard = [];
  for (const a of pending.slice(0, 10)) {
    const tldr = renderApprovalTldr(cfg, a);
    const subject = tldr ? tldr.split("\n")[0] : `type ${fmtCode(a.type)}`;
    const link = deepLink(cfg, "approval", a.id);
    const headLinked = link
      ? `🟡 <a href="${escapeHtml(link)}">${escapeHtml(fmtIdShort(a.id))}</a>`
      : `🟡 ${fmtCode(fmtIdShort(a.id))}`;
    lines.push(`${headLinked} — ${subject}`);
    if (cfg.paperclipApiToken) {
      inlineKeyboard.push([
        callbackButton(`✅ ${fmtIdShort(a.id)}`, `approve.list:${a.id}`),
        callbackButton(`❌ ${fmtIdShort(a.id)}`, `reject.list:${a.id}`),
        callbackButton(`💬 ${fmtIdShort(a.id)}`, `approval.comment.list:${a.id}`),
      ]);
    } else if (link) {
      inlineKeyboard.push([viewButton(`Open ${fmtIdShort(a.id)}`, link)]);
    }
  }
  return {
    text: lines.join("\n"),
    reply_markup:
      inlineKeyboard.length > 0
        ? { inline_keyboard: inlineKeyboard }
        : undefined,
  };
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
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
  if (!companyId) return;
  const pending = await fetchPendingApprovals(ctx, cfg, companyId);
  if (!Array.isArray(pending)) {
    await sendReply(ctx, cfg, message, "Could not fetch approvals.");
    return;
  }
  const view = renderApprovalsListView(cfg, pending);
  await sendReply(
    ctx,
    cfg,
    message,
    view.text,
    view.reply_markup ? { reply_markup: view.reply_markup } : {}
  );
}

function renderAgentsListView(cfg, agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return {
      text: "<b>Agents</b>\n<i>(none)</i>",
      reply_markup: undefined,
    };
  }
  const lines = [`<b>Agents (${agents.length})</b>`];
  const inlineKeyboard = [];
  for (const a of agents.slice(0, 25)) {
    const name = a.displayName || a.name || fmtIdShort(a.id || "");
    const status = a.status || "?";
    const role = a.role || null;
    const bits = [`${statusEmoji(status)} <b>${escapeHtml(name)}</b>`];
    if (role) bits.push(fmtCode(role));
    bits.push(fmtCode(status));
    lines.push(bits.join(" · "));
    if (cfg.paperclipApiToken) {
      const actionRow = buildAgentActionRow(a, "list");
      // Tag the buttons with the agent name for clarity in a multi-row list.
      const labelled = actionRow.map((b) =>
        b.callback_data
          ? { ...b, text: `${b.text} ${name}`.slice(0, 60) }
          : b
      );
      if (labelled.length > 0) inlineKeyboard.push(labelled);
    }
  }
  return {
    text: lines.join("\n"),
    reply_markup:
      inlineKeyboard.length > 0
        ? { inline_keyboard: inlineKeyboard }
        : undefined,
  };
}

async function handleAgentsCommand(ctx, cfg, message) {
  const companyId = await resolveCompanyId(ctx, cfg, message.from?.id || null, message.chat?.id ?? null);
  if (!companyId) return;
  const agents = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(companyId)}/agents`)
  );
  const view = renderAgentsListView(cfg, agents);
  await sendReply(
    ctx,
    cfg,
    message,
    view.text,
    view.reply_markup ? { reply_markup: view.reply_markup } : {}
  );
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

async function resolveAgentId(ctx, cfg, arg, userId = null, chatId = null) {
  const needle = String(arg || "").trim();
  if (!needle) return null;
  if (isUuidLike(needle)) return needle;
  const companyId = await resolveCompanyId(ctx, cfg, userId, chatId);
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

async function resolveIssueId(ctx, cfg, arg, userId = null, chatId = null) {
  const needle = String(arg || "").trim();
  if (!needle) return null;
  if (isUuidLike(needle)) return needle;
  const companyId = await resolveCompanyId(ctx, cfg, userId, chatId);
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
  const issueId = await resolveIssueId(ctx, cfg, ref, message.from?.id || null, message.chat?.id ?? null);
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
  const agentId = await resolveAgentId(ctx, cfg, arg, message.from?.id || null, message.chat?.id ?? null);
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

// ---------------------------------------------------------------------------
// Multi-workspace switching
// ---------------------------------------------------------------------------

function renderWorkspacesView(companies, activeCompanyId) {
  const lines = [`<b>Workspaces</b>`];
  const keyboard = [];
  for (const c of companies) {
    const name = c.name || fmtIdShort(c.id);
    const isActive = c.id === activeCompanyId;
    const marker = isActive ? " 🟢 active" : "";
    lines.push(`${escapeHtml(name)} — ${fmtCode(fmtIdShort(c.id))}${marker}`);
    keyboard.push([
      {
        text: isActive ? `🟢 ${name} (active)` : `Switch to ${name}`,
        callback_data: `ws.use:${c.id}`,
      },
    ]);
  }
  lines.push("");
  lines.push("<i>Tap to switch. Notifications fire across all workspaces regardless of which is active.</i>");
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: keyboard },
  };
}

async function handleWorkspacesCommand(ctx, cfg, message) {
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  if (companies.length === 0) {
    await sendReply(ctx, cfg, message, "No companies visible to this plugin.");
    return;
  }
  const userId = message.from?.id || null;
  const chatId = message.chat?.id ?? null;
  const active = await resolveCompanyId(ctx, cfg, userId, chatId);
  const view = renderWorkspacesView(companies, active);
  await sendReply(ctx, cfg, message, view.text, { reply_markup: view.keyboard });
}

async function handleUseCommand(ctx, cfg, message, args) {
  const arg = String(args || "").trim();
  if (!arg) {
    await sendReply(
      ctx,
      cfg,
      message,
      "Usage: <code>/use &lt;company name or id&gt;</code>"
    );
    return;
  }
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  const lower = arg.toLowerCase();
  let match = null;
  if (isUuidLike(arg)) match = companies.find((c) => c.id === arg);
  if (!match)
    match = companies.find(
      (c) => c.name && c.name.toLowerCase() === lower
    );
  if (!match)
    match = companies.find(
      (c) => c.name && c.name.toLowerCase().startsWith(lower)
    );
  if (!match)
    match = companies.find((c) => c.id && c.id.startsWith(arg));
  if (!match) {
    await sendReply(ctx, cfg, message, `No workspace matches ${fmtCode(arg)}`);
    return;
  }
  await setUserActiveCompany(ctx, message.from?.id || null, match.id);
  await sendReply(
    ctx,
    cfg,
    message,
    `🟢 Active workspace: <b>${escapeHtml(
      match.name || fmtIdShort(match.id)
    )}</b>`
  );
}

// ---------------------------------------------------------------------------
// Issue lifecycle commands (/done /reopen — siblings of /pause /resume)
// ---------------------------------------------------------------------------

async function handleIssueStatusChange(ctx, cfg, message, args, targetStatus) {
  const arg = String(args || "").trim();
  if (!arg) {
    const verb = targetStatus === "done" ? "done" : "reopen";
    await sendReply(
      ctx,
      cfg,
      message,
      `Usage: <code>/${verb} &lt;issue id or identifier&gt;</code>`
    );
    return;
  }
  const issueId = await resolveIssueId(ctx, cfg, arg, message.from?.id || null, message.chat?.id ?? null);
  if (!issueId) {
    await sendReply(ctx, cfg, message, `Issue not found: ${fmtCode(arg)}`);
    return;
  }
  const result = await pcRequest(
    ctx,
    cfg,
    "PATCH",
    `/issues/${encodeURIComponent(issueId)}`,
    { status: targetStatus }
  );
  if (result.ok) {
    const issue = result.body || {};
    const ident = issue.identifier || fmtIdShort(issueId);
    await sendReply(
      ctx,
      cfg,
      message,
      `${statusEmoji(issue.status || targetStatus)} <b>${escapeHtml(
        ident
      )}</b> → ${fmtCode(issue.status || targetStatus)}`,
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

// ---------------------------------------------------------------------------
// /connect — bind this chat to a specific company
// ---------------------------------------------------------------------------

async function handleConnectCommand(ctx, cfg, message, args) {
  const arg = String(args || "").trim();
  if (!arg) {
    await sendReply(
      ctx,
      cfg,
      message,
      "Usage: <code>/connect &lt;company name or id&gt;</code>"
    );
    return;
  }
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  if (companies.length === 0) {
    await sendReply(ctx, cfg, message, "No companies visible to this plugin.");
    return;
  }
  const lower = arg.toLowerCase();
  let match = null;
  if (isUuidLike(arg)) match = companies.find((c) => c.id === arg);
  if (!match)
    match = companies.find((c) => c.name && c.name.toLowerCase() === lower);
  if (!match)
    match = companies.find(
      (c) => c.name && c.name.toLowerCase().startsWith(lower)
    );
  if (!match)
    match = companies.find((c) => c.id && c.id.startsWith(arg));
  if (!match) {
    await sendReply(ctx, cfg, message, `No workspace matches ${fmtCode(arg)}`);
    return;
  }
  const chatId = message.chat?.id ?? null;
  if (chatId == null) {
    await sendReply(ctx, cfg, message, "Could not determine chat id.");
    return;
  }
  await setChatConnectedCompany(ctx, chatId, match.id);
  await sendReply(
    ctx,
    cfg,
    message,
    `🔗 This chat is now connected to <b>${escapeHtml(
      match.name || fmtIdShort(match.id)
    )}</b>. Commands in this chat will default to that workspace until you /connect another.`
  );
}

// ---------------------------------------------------------------------------
// /approve <id> /reject <id> — standalone approval decisions
// ---------------------------------------------------------------------------

async function resolveApprovalId(ctx, cfg, arg, companyId) {
  const needle = String(arg || "").trim();
  if (!needle) return null;
  if (isUuidLike(needle)) return needle;
  // 8-char (or longer prefix) — list pending approvals and match by id prefix.
  if (!companyId) return null;
  const pending = await fetchPendingApprovals(ctx, cfg, companyId);
  if (!Array.isArray(pending)) return null;
  const match = pending.find(
    (a) => typeof a.id === "string" && a.id.toLowerCase().startsWith(needle.toLowerCase())
  );
  return match?.id || null;
}

async function handleApprovalDecisionCommand(ctx, cfg, message, args, action) {
  const arg = String(args || "").trim();
  if (!arg) {
    await sendReply(
      ctx,
      cfg,
      message,
      `Usage: <code>/${action} &lt;approval id or 8-char prefix&gt;</code>`
    );
    return;
  }
  if (!cfg.paperclipApiToken) {
    await sendReply(
      ctx,
      cfg,
      message,
      `<i>Set paperclipApiToken in plugin config to ${action} approvals.</i>`
    );
    return;
  }
  const companyId = await resolveCompanyId(
    ctx,
    cfg,
    message.from?.id || null,
    message.chat?.id ?? null
  );
  const approvalId = await resolveApprovalId(ctx, cfg, arg, companyId);
  if (!approvalId) {
    await sendReply(ctx, cfg, message, `Approval not found: ${fmtCode(arg)}`);
    return;
  }
  // Mirror the inline-button path: pre-mark, drop on failure. The host can
  // emit `approval.decided` to plugin event handlers before our REST call
  // returns, so we need the mark in place before we hit the wire.
  markRecentlyDecidedViaTelegram(approvalId);
  const path =
    action === "approve"
      ? `/approvals/${encodeURIComponent(approvalId)}/approve`
      : `/approvals/${encodeURIComponent(approvalId)}/reject`;
  const who = message.from?.username || message.from?.first_name || "user";
  const result = await callPaperclip(ctx, cfg, path, {
    decisionNote: `Via Telegram by ${who}`,
  });
  if (!result.ok) {
    recentlyDecidedViaTelegram.delete(approvalId);
    await sendReply(
      ctx,
      cfg,
      message,
      `Failed to ${action} (${result.status}): ${fmtCode(
        truncate(JSON.stringify(result.body || {}), 200)
      )}`
    );
    return;
  }
  const link = deepLink(cfg, "approval", approvalId);
  const kb = link
    ? { inline_keyboard: [[viewButton("Open in Paperclip", link)]] }
    : undefined;
  const head =
    action === "approve"
      ? `✅ Approved <b>${escapeHtml(fmtIdShort(approvalId))}</b>`
      : `❌ Rejected <b>${escapeHtml(fmtIdShort(approvalId))}</b>`;
  await sendReply(ctx, cfg, message, head, kb ? { reply_markup: kb } : {});
}

// ---------------------------------------------------------------------------
// /topics — per-chat project → topic routing overrides
// ---------------------------------------------------------------------------

async function resolveProjectByArg(ctx, cfg, companyId, arg) {
  const needle = String(arg || "").trim();
  if (!needle || !companyId) return null;
  const projects = asArray(
    await pcGet(
      ctx,
      cfg,
      `/companies/${encodeURIComponent(companyId)}/projects`
    )
  );
  if (isUuidLike(needle)) {
    return projects.find((p) => p.id === needle) || { id: needle, name: null };
  }
  const lower = needle.toLowerCase();
  let match = projects.find(
    (p) => p.name && p.name.toLowerCase() === lower
  );
  if (!match)
    match = projects.find(
      (p) => p.name && p.name.toLowerCase().startsWith(lower)
    );
  if (!match) match = projects.find((p) => p.id && p.id.startsWith(needle));
  return match || null;
}

async function handleTopicsCommand(ctx, cfg, message, args) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts.shift() || "").toLowerCase();
  const chatId = message.chat?.id ?? null;
  if (chatId == null) {
    await sendReply(ctx, cfg, message, "Could not determine chat id.");
    return;
  }

  if (!sub || sub === "list") {
    const map = await getChatProjectTopics(ctx, chatId);
    const entries = Object.entries(map);
    if (entries.length === 0) {
      await sendReply(
        ctx,
        cfg,
        message,
        "<b>Project topic mappings</b>\n<i>(none)</i>\n\nUse <code>/topics add &lt;project&gt; &lt;topicId&gt;</code> to add one."
      );
      return;
    }
    // Best-effort: resolve project names so the list is readable.
    const companyId = await resolveCompanyId(
      ctx,
      cfg,
      message.from?.id || null,
      chatId
    );
    let nameById = new Map();
    if (companyId) {
      const projects = asArray(
        await pcGet(
          ctx,
          cfg,
          `/companies/${encodeURIComponent(companyId)}/projects`
        )
      );
      for (const p of projects) if (p?.id) nameById.set(p.id, p.name || null);
    }
    const lines = ["<b>Project topic mappings</b>"];
    for (const [pid, tid] of entries) {
      const name = nameById.get(pid) || fmtIdShort(pid);
      lines.push(`${escapeHtml(name)} → topic ${fmtCode(String(tid))}`);
    }
    await sendReply(ctx, cfg, message, lines.join("\n"));
    return;
  }

  if (sub === "clear") {
    await setChatProjectTopics(ctx, chatId, {});
    await sendReply(ctx, cfg, message, "🧹 Cleared all project → topic mappings for this chat.");
    return;
  }

  if (sub === "add") {
    const projectArg = parts.shift();
    const topicArg = parts.shift();
    if (!projectArg || !topicArg) {
      await sendReply(
        ctx,
        cfg,
        message,
        "Usage: <code>/topics add &lt;project name or uuid&gt; &lt;topicId&gt;</code>"
      );
      return;
    }
    const topicId = Number.parseInt(topicArg, 10);
    if (!Number.isInteger(topicId) || topicId < 0) {
      await sendReply(
        ctx,
        cfg,
        message,
        `topicId must be a non-negative integer (got ${fmtCode(topicArg)})`
      );
      return;
    }
    const companyId = await resolveCompanyId(
      ctx,
      cfg,
      message.from?.id || null,
      chatId
    );
    if (!companyId) {
      await sendReply(ctx, cfg, message, "No company visible — cannot resolve project.");
      return;
    }
    const project = await resolveProjectByArg(ctx, cfg, companyId, projectArg);
    if (!project || !project.id) {
      await sendReply(
        ctx,
        cfg,
        message,
        `Project not found: ${fmtCode(projectArg)}`
      );
      return;
    }
    const map = await getChatProjectTopics(ctx, chatId);
    map[project.id] = topicId;
    await setChatProjectTopics(ctx, chatId, map);
    const name = project.name || fmtIdShort(project.id);
    await sendReply(
      ctx,
      cfg,
      message,
      `📌 <b>${escapeHtml(name)}</b> → topic ${fmtCode(String(topicId))}`
    );
    return;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const projectArg = parts.shift();
    if (!projectArg) {
      await sendReply(
        ctx,
        cfg,
        message,
        "Usage: <code>/topics remove &lt;project name or uuid&gt;</code>"
      );
      return;
    }
    const companyId = await resolveCompanyId(
      ctx,
      cfg,
      message.from?.id || null,
      chatId
    );
    const project = companyId
      ? await resolveProjectByArg(ctx, cfg, companyId, projectArg)
      : (isUuidLike(projectArg) ? { id: projectArg, name: null } : null);
    if (!project || !project.id) {
      await sendReply(
        ctx,
        cfg,
        message,
        `Project not found: ${fmtCode(projectArg)}`
      );
      return;
    }
    const map = await getChatProjectTopics(ctx, chatId);
    if (!(project.id in map)) {
      await sendReply(ctx, cfg, message, "No mapping to remove for that project.");
      return;
    }
    delete map[project.id];
    await setChatProjectTopics(ctx, chatId, map);
    const name = project.name || fmtIdShort(project.id);
    await sendReply(
      ctx,
      cfg,
      message,
      `🗑 Removed topic mapping for <b>${escapeHtml(name)}</b>`
    );
    return;
  }

  await sendReply(
    ctx,
    cfg,
    message,
    "Usage: <code>/topics [list|add|remove|clear]</code>\n" +
      "• <code>/topics list</code>\n" +
      "• <code>/topics add &lt;project&gt; &lt;topicId&gt;</code>\n" +
      "• <code>/topics remove &lt;project&gt;</code>\n" +
      "• <code>/topics clear</code>"
  );
}

// ---------------------------------------------------------------------------
// /digest — on-demand summary for active workspace
// ---------------------------------------------------------------------------

/**
 * Build the digest text+keyboard for one company. Used by both /digest and
 * the scheduled job. Returns { text, reply_markup? }.
 */
async function buildCompanyDigest(ctx, cfg, company) {
  if (!company || !company.id) return null;
  const cid = company.id;
  const name = company.name || fmtIdShort(cid);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const issues = asArray(
    await pcGet(
      ctx,
      cfg,
      `/companies/${encodeURIComponent(cid)}/issues?limit=200`
    )
  );
  const agents = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(cid)}/agents`)
  );
  const approvals = (await fetchPendingApprovals(ctx, cfg, cid)) || [];

  const tsOf = (v) => {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const closedRecent = issues.filter(
    (i) => i?.status === "done" && tsOf(i.updatedAt) >= since
  );
  const newRecent = issues.filter((i) => tsOf(i?.createdAt) >= since);
  const busyAgents = agents.filter(
    (a) =>
      a?.status && a.status !== "idle" && a.status !== "terminated"
  );

  const lines = [
    `📰 <b>Daily digest</b> · 🏢 ${escapeHtml(name)}`,
    "",
    `✅ Closed (24h): ${fmtCode(String(closedRecent.length))}`,
    `🆕 New issues (24h): ${fmtCode(String(newRecent.length))}`,
    `🟡 Pending approvals: ${fmtCode(String(approvals.length))}`,
    `🤖 Agents not idle: ${fmtCode(String(busyAgents.length))} / ${fmtCode(String(agents.length))}`,
  ];

  // A few example titles, capped, for at-a-glance scanning.
  if (closedRecent.length > 0) {
    lines.push("", "<b>Recently closed</b>");
    for (const i of closedRecent.slice(0, 5)) {
      const ident = i.identifier || fmtIdShort(i.id || "");
      lines.push(
        `• <b>${escapeHtml(ident)}</b> ${escapeHtml(truncate(i.title || "(untitled)", 80))}`
      );
    }
  }
  if (newRecent.length > 0) {
    lines.push("", "<b>New</b>");
    for (const i of newRecent.slice(0, 5)) {
      const ident = i.identifier || fmtIdShort(i.id || "");
      lines.push(
        `• <b>${escapeHtml(ident)}</b> ${escapeHtml(truncate(i.title || "(untitled)", 80))}`
      );
    }
  }
  if (busyAgents.length > 0) {
    lines.push("", "<b>Active agents</b>");
    for (const a of busyAgents.slice(0, 5)) {
      const an = a.displayName || a.name || fmtIdShort(a.id || "");
      lines.push(`• ${statusEmoji(a.status)} ${escapeHtml(an)} (${fmtCode(a.status || "?")})`);
    }
  }

  const link = deepLink(cfg, "project", null) || cfg.paperclipPublicUrl;
  const kb = link
    ? { inline_keyboard: [[viewButton("Open in Paperclip", String(link).replace(/\/+$/, ""))]] }
    : undefined;
  return { text: lines.join("\n"), reply_markup: kb };
}

async function handleDigestCommand(ctx, cfg, message) {
  const companyId = await resolveCompanyId(
    ctx,
    cfg,
    message.from?.id || null,
    message.chat?.id ?? null
  );
  if (!companyId) {
    await sendReply(ctx, cfg, message, "No company visible to this plugin.");
    return;
  }
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  const company = companies.find((c) => c.id === companyId) || { id: companyId };
  const view = await buildCompanyDigest(ctx, cfg, company);
  if (!view) {
    await sendReply(ctx, cfg, message, "Could not build digest.");
    return;
  }
  await sendReply(
    ctx,
    cfg,
    message,
    view.text,
    view.reply_markup ? { reply_markup: view.reply_markup } : {}
  );
}

// Iterates every visible company, builds a digest, and posts it to the
// digest chat (digestChatId, falling back to defaultChatId). Used by both
// the scheduled job handler and any future ops/debug path.
async function runDailyDigestForAllCompanies(ctx, cfg) {
  const chatId =
    (typeof cfg.digestChatId === "string" && cfg.digestChatId.trim()) ||
    (typeof cfg.defaultChatId === "string" && cfg.defaultChatId.trim()) ||
    "";
  if (!chatId) {
    ctx.logger.warn("daily digest: no chat id configured — skipping");
    return;
  }
  const token = (cfg.botToken || "").trim();
  if (!token) {
    ctx.logger.warn("daily digest: no botToken — skipping");
    return;
  }
  const topicId = Number.isInteger(cfg.digestTopicId)
    ? cfg.digestTopicId
    : Number.isInteger(cfg.defaultTopicId)
    ? cfg.defaultTopicId
    : null;
  const tg = createTelegram(ctx, token);
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  if (companies.length === 0) {
    ctx.logger.info("daily digest: no companies visible — skipping");
    return;
  }
  for (const c of companies) {
    try {
      const view = await buildCompanyDigest(ctx, cfg, c);
      if (!view) continue;
      const body = {
        chat_id: chatId,
        text: clampMessage(view.text),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      if (topicId != null) body.message_thread_id = topicId;
      if (view.reply_markup) body.reply_markup = view.reply_markup;
      await tg.sendMessage(body);
    } catch (err) {
      ctx.logger.warn("daily digest: per-company send failed", {
        err: String(err),
        companyId: c?.id,
      });
    }
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
    case "done":
      await handleIssueStatusChange(ctx, cfg, message, args, "done");
      return true;
    case "reopen":
      await handleIssueStatusChange(ctx, cfg, message, args, "todo");
      return true;
    case "workspaces":
    case "companies":
      await handleWorkspacesCommand(ctx, cfg, message);
      return true;
    case "use":
      await handleUseCommand(ctx, cfg, message, args);
      return true;
    case "connect":
      await handleConnectCommand(ctx, cfg, message, args);
      return true;
    case "approve":
      await handleApprovalDecisionCommand(ctx, cfg, message, args, "approve");
      return true;
    case "reject":
      await handleApprovalDecisionCommand(ctx, cfg, message, args, "reject");
      return true;
    case "topics":
      await handleTopicsCommand(ctx, cfg, message, args);
      return true;
    case "digest":
      await handleDigestCommand(ctx, cfg, message);
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

async function pcRequest(ctx, cfg, method, pathRel, body) {
  if (!cfg.paperclipPublicUrl || !cfg.paperclipApiToken)
    return { ok: false, status: 0, body: { error: "no api token configured" } };
  const base = cfg.paperclipPublicUrl.replace(/\/+$/, "");
  const url = `${base}/api${pathRel}`;
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.paperclipApiToken}`,
    },
  };
  if (body !== undefined && body !== null && method !== "GET")
    init.body = JSON.stringify(body);
  try {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => "");
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    ctx.logger.warn("pcRequest threw", { err: String(err), method, pathRel });
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}

// Backwards-compatible POST helper used by approve/reject + comment paths.
async function callPaperclip(ctx, cfg, pathRel, body) {
  return pcRequest(ctx, cfg, "POST", pathRel, body ?? {});
}

// View-aware refresh helpers — used by callbacks to edit the source
// message in place after an action so the UI reflects the new state
// without sending a fresh notification.

async function refreshIssuesListMessage(ctx, cfg, query) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const userId = query.from?.id || null;
  const chatId = query.message?.chat?.id ?? null;
  const companyId = await resolveCompanyId(ctx, cfg, userId, chatId);
  if (!companyId) return;
  const issues = asArray(
    await pcGet(
      ctx,
      cfg,
      `/companies/${encodeURIComponent(companyId)}/issues?limit=${COMMAND_MAX_ISSUES}`
    )
  );
  const view = renderIssuesListView(cfg, issues);
  await tg.editMessageText({
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: clampMessage(view.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup || { inline_keyboard: [] },
  });
}

async function refreshIssueDetailMessage(ctx, cfg, query, issueId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const issue = await pcGet(ctx, cfg, `/issues/${encodeURIComponent(issueId)}`);
  if (!issue) return;
  const view = renderIssueDetailView(cfg, issue);
  await tg.editMessageText({
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: clampMessage(view.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup || { inline_keyboard: [] },
  });
}

async function refreshApprovalsListMessage(ctx, cfg, query) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const userId = query.from?.id || null;
  const chatId = query.message?.chat?.id ?? null;
  const companyId = await resolveCompanyId(ctx, cfg, userId, chatId);
  if (!companyId) return;
  const pending = await fetchPendingApprovals(ctx, cfg, companyId);
  const view = renderApprovalsListView(cfg, pending || []);
  await tg.editMessageText({
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: clampMessage(view.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup || { inline_keyboard: [] },
  });
}

async function refreshAgentsListMessage(ctx, cfg, query) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const userId = query.from?.id || null;
  const chatId = query.message?.chat?.id ?? null;
  const companyId = await resolveCompanyId(ctx, cfg, userId, chatId);
  if (!companyId) return;
  const agents = asArray(
    await pcGet(ctx, cfg, `/companies/${encodeURIComponent(companyId)}/agents`)
  );
  const view = renderAgentsListView(cfg, agents);
  await tg.editMessageText({
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: clampMessage(view.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup || { inline_keyboard: [] },
  });
}

async function sendCommentPrompt(ctx, cfg, query, entityType, entityId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const label = entityType === "approval" ? "approval" : "issue";
  const promptText = `💬 Reply to this message with your comment for ${label} ${fmtCode(
    fmtIdShort(entityId)
  )}`;
  const r = await tg.sendMessage({
    chat_id: query.message.chat.id,
    message_thread_id: query.message.message_thread_id ?? undefined,
    text: promptText,
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  });
  if (r.ok) {
    await rememberEntityRef(ctx, r, { type: entityType, id: entityId });
  }
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: "Reply to the prompt to add your comment",
  });
}

async function handleIssueCallback(ctx, cfg, query, action, view, issueId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  if (!cfg.paperclipApiToken) {
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: "Issue actions require paperclipApiToken to be set in plugin config.",
      show_alert: true,
    });
    return;
  }
  if (action === "comment") {
    return sendCommentPrompt(ctx, cfg, query, "issue", issueId);
  }
  if (action === "done" || action === "reopen") {
    const newStatus = action === "done" ? "done" : "todo";
    const result = await pcRequest(
      ctx,
      cfg,
      "PATCH",
      `/issues/${encodeURIComponent(issueId)}`,
      { status: newStatus }
    );
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: result.ok
        ? action === "done"
          ? "Marked done ✅"
          : "Reopened 🔁"
        : `Failed (${result.status})`,
      show_alert: !result.ok,
    });
    if (result.ok) {
      try {
        if (view === "list") await refreshIssuesListMessage(ctx, cfg, query);
        else if (view === "open")
          await refreshIssueDetailMessage(ctx, cfg, query, issueId);
        // view "note" or unknown: leave the original message alone.
      } catch (err) {
        ctx.logger.warn("refresh after issue action failed", {
          err: String(err),
          view,
          issueId,
        });
      }
    }
    return;
  }
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: `Unknown issue action: ${action}`,
  });
}

async function handleApprovalDecideCallback(ctx, cfg, query, action, view, approvalId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  if (!cfg.paperclipApiToken) {
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: "Approve / Reject requires paperclipApiToken to be set in plugin config.",
      show_alert: true,
    });
    return;
  }
  const path =
    action === "approve"
      ? `/approvals/${approvalId}/approve`
      : `/approvals/${approvalId}/reject`;
  // Mark BEFORE the REST call: the host emits `approval.decided` to plugin
  // event handlers from inside the route's activity-log write, which can
  // race ahead of our REST response. A pre-mark wins the race. On failure
  // we drop the mark — no decision was made, so no event will fire.
  markRecentlyDecidedViaTelegram(approvalId);
  const result = await callPaperclip(ctx, cfg, path, {
    decisionNote: `Via Telegram by ${query.from?.username || query.from?.first_name || "user"}`,
  });
  const ok = result.ok;
  if (!ok) recentlyDecidedViaTelegram.delete(approvalId);
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: ok
      ? action === "approve"
        ? "Approved ✅"
        : "Rejected ❌"
      : `Failed (${result.status}): ${truncate(JSON.stringify(result.body), 120)}`,
    show_alert: !ok,
  });
  if (!ok) return;

  if (view === "list") {
    try {
      await refreshApprovalsListMessage(ctx, cfg, query);
    } catch (err) {
      ctx.logger.warn("refresh approvals list failed", { err: String(err) });
    }
    return;
  }
  // Notification view (default): annotate the original text and collapse
  // the action row to just the deep-link button.
  if (query.message) {
    const original = query.message.text || query.message.caption || "";
    const who = escapeHtml(
      query.from?.username || query.from?.first_name || "user"
    );
    const decoration =
      action === "approve"
        ? `\n\n<b>✅ Approved</b> by ${who}`
        : `\n\n<b>❌ Rejected</b> by ${who}`;
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

async function handleAgentCallback(ctx, cfg, query, action, view, agentId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  if (!cfg.paperclipApiToken) {
    await tg.answerCallbackQuery({
      callback_query_id: query.id,
      text: "Agent actions require paperclipApiToken to be set in plugin config.",
      show_alert: true,
    });
    return;
  }
  const result = await callPaperclip(
    ctx,
    cfg,
    `/agents/${encodeURIComponent(agentId)}/${action}`,
    {}
  );
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: result.ok
      ? action === "pause"
        ? "Paused ⏸"
        : "Resumed ▶️"
      : `Failed (${result.status})`,
    show_alert: !result.ok,
  });
  if (result.ok && view === "list") {
    try {
      await refreshAgentsListMessage(ctx, cfg, query);
    } catch (err) {
      ctx.logger.warn("refresh agents list failed", { err: String(err) });
    }
  }
}

async function handleWorkspaceSwitchCallback(ctx, cfg, query, companyId) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const userId = query.from?.id || null;
  await setUserActiveCompany(ctx, userId, companyId);
  const companies = asArray(await pcGet(ctx, cfg, "/companies"));
  const matched = companies.find((c) => c.id === companyId);
  const name = matched?.name || fmtIdShort(companyId);
  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: `🟢 Active workspace: ${name}`,
  });
  if (query.message) {
    const view = renderWorkspacesView(companies, companyId);
    await tg.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: clampMessage(view.text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: view.keyboard,
    });
  }
}

async function handleCallbackQuery(ctx, cfg, query) {
  const tg = createTelegram(ctx, (cfg.botToken || "").trim());
  const data = String(query.data || "");

  // Workspace switching (existing).
  const wsMatch = data.match(/^ws\.use:([0-9a-f-]{36})$/i);
  if (wsMatch) {
    return handleWorkspaceSwitchCallback(ctx, cfg, query, wsMatch[1]);
  }

  // Issue actions — view-aware: issue.<action>[.<view>]:<uuid>
  // view defaults to "list" for backwards compat with older messages.
  const issueMatch = data.match(
    /^issue\.(done|reopen|comment)(?:\.([a-z]+))?:([0-9a-f-]{36})$/i
  );
  if (issueMatch) {
    return handleIssueCallback(
      ctx,
      cfg,
      query,
      issueMatch[1].toLowerCase(),
      (issueMatch[2] || "list").toLowerCase(),
      issueMatch[3]
    );
  }

  // Agent actions — agent.<pause|resume>[.<view>]:<uuid>
  const agentMatch = data.match(
    /^agent\.(pause|resume)(?:\.([a-z]+))?:([0-9a-f-]{36})$/i
  );
  if (agentMatch) {
    return handleAgentCallback(
      ctx,
      cfg,
      query,
      agentMatch[1].toLowerCase(),
      (agentMatch[2] || "list").toLowerCase(),
      agentMatch[3]
    );
  }

  // Approval comment — approval.comment[.<view>]:<uuid>
  const apprComment = data.match(
    /^approval\.comment(?:\.([a-z]+))?:([0-9a-f-]{8,})$/i
  );
  if (apprComment) {
    return sendCommentPrompt(ctx, cfg, query, "approval", apprComment[2]);
  }

  // Approve / Reject — supports both legacy "approve:id" and new
  // "approve.<view>:id". view defaults to "note" so legacy callback_data
  // on existing notifications keeps working.
  const apprDecide = data.match(
    /^(approve|reject)(?:\.([a-z]+))?:([a-f0-9-]{8,})$/i
  );
  if (apprDecide) {
    return handleApprovalDecideCallback(
      ctx,
      cfg,
      query,
      apprDecide[1].toLowerCase(),
      (apprDecide[2] || "note").toLowerCase(),
      apprDecide[3]
    );
  }

  await tg.answerCallbackQuery({
    callback_query_id: query.id,
    text: "Unrecognized button",
  });
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
      // Tag every outbound notification with its source workspace so users
      // running multiple companies see at a glance which one fired it.
      // The append is one line so it stays inline with the existing header.
      let tagged = html;
      const companyId = entityRef?.companyId;
      if (companyId) {
        const name = await getCompanyName(ctx, companyId);
        if (name) {
          // Insert the tag right after the first newline-bounded header line.
          const firstBreak = html.indexOf("\n");
          if (firstBreak === -1) {
            tagged = html + workspaceTag(name);
          } else {
            tagged =
              html.slice(0, firstBreak) +
              workspaceTag(name) +
              html.slice(firstBreak);
          }
        }
      }
      await dispatchMessage(ctx, cfg, eventType, tagged, opts, entityRef);
    }

    async function gate(event, key, defaultOn) {
      const cfg = await ctx.config.get();
      if (!eventEnabled(cfg, key, defaultOn)) return null;
      if (!passesAllowlist(cfg, event)) return null;
      return cfg;
    }

    // Helper — pull a projectId off an event payload if present. Used to
    // tag entityRefs so dispatchMessage can apply per-chat /topics overrides.
    const pidOf = (event) => {
      const p = event?.payload;
      return p && typeof p.projectId === "string" ? p.projectId : null;
    };

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
          { type: "issue", id: event.entityId, companyId: event.companyId, projectId: pidOf(event) }
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
          { type: "issue", id: event.entityId, companyId: event.companyId, projectId: pidOf(event) }
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
            ? { type: "issue", id: issueId, companyId: event.companyId, projectId: pidOf(event) }
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
          { type: "approval", id: event.entityId, companyId: event.companyId, projectId: pidOf(event) }
        );
      })
    );

    ctx.events.on(
      "approval.decided",
      safe("approval.decided", async (event) => {
        const cfg = await gate(event, "approvalDecided", true);
        if (!cfg) return;
        // Skip if this approval was just decided via a Telegram inline
        // button — the user already saw the result land on the original
        // message and doesn't need a duplicate ping.
        if (wasRecentlyDecidedViaTelegram(event.entityId)) {
          ctx.logger.info("skipping approval.decided (recently decided via Telegram)", {
            approvalId: event.entityId,
          });
          return;
        }
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
          { type: "approval", id: event.entityId, companyId: event.companyId, projectId: pidOf(event) }
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
        await send("agent.run.started", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    ctx.events.on(
      "agent.run.finished",
      safe("agent.run.finished", async (event) => {
        const cfg = await gate(event, "agentRunFinished", false);
        if (!cfg) return;
        const html = fmtAgentRun("🏁 <b>Agent run finished</b>", event, cfg);
        await send("agent.run.finished", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    ctx.events.on(
      "agent.run.cancelled",
      safe("agent.run.cancelled", async (event) => {
        const cfg = await gate(event, "agentRunCancelled", false);
        if (!cfg) return;
        const html = fmtAgentRun("🚫 <b>Agent run cancelled</b>", event, cfg);
        await send("agent.run.cancelled", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    ctx.events.on(
      "agent.run.failed",
      safe("agent.run.failed", async (event) => {
        const cfg = await gate(event, "agentRunFailed", true);
        if (!cfg) return;
        const html = fmtAgentRun("❌ <b>Agent run failed</b>", event, cfg);
        await send("agent.run.failed", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    // Budgets
    ctx.events.on(
      "budget.incident.opened",
      safe("budget.incident.opened", async (event) => {
        const cfg = await gate(event, "budgetIncidentOpened", true);
        if (!cfg) return;
        const html = fmtBudget("💸 <b>Budget incident</b>", event, cfg);
        await send("budget.incident.opened", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    ctx.events.on(
      "budget.incident.resolved",
      safe("budget.incident.resolved", async (event) => {
        const cfg = await gate(event, "budgetIncidentResolved", false);
        if (!cfg) return;
        const html = fmtBudget("✅ <b>Budget incident resolved</b>", event, cfg);
        await send("budget.incident.resolved", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    // Goals
    ctx.events.on(
      "goal.created",
      safe("goal.created", async (event) => {
        const cfg = await gate(event, "goalCreated", false);
        if (!cfg) return;
        const html = fmtGoal("🎯 <b>Goal created</b>", event, cfg);
        await send("goal.created", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
      })
    );

    ctx.events.on(
      "goal.updated",
      safe("goal.updated", async (event) => {
        const cfg = await gate(event, "goalUpdated", false);
        if (!cfg) return;
        const html = fmtGoal("🎯 <b>Goal updated</b>", event, cfg);
        await send("goal.updated", html, {}, { type: "event", companyId: event.companyId, projectId: pidOf(event) });
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

    // Scheduled jobs — must match a jobKey declared in the manifest. Host
    // calls this handler on the declared cron schedule.
    try {
      ctx.jobs.register("telegram-daily-digest", async (job) => {
        ctx.logger.info("daily digest job triggered", {
          runId: job?.runId,
          trigger: job?.trigger,
          scheduledAt: job?.scheduledAt,
        });
        try {
          const cfg = await ctx.config.get();
          await runDailyDigestForAllCompanies(ctx, cfg);
        } catch (err) {
          ctx.logger.error("daily digest job failed", { err: String(err) });
        }
      });
    } catch (err) {
      ctx.logger.warn("ctx.jobs.register failed", { err: String(err) });
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
