// @openkit/plugin-wecom-notify
import { readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
// ─── Debug Logger ─────────────────────────────────────────────────────
const DEBUG_LOG = "/tmp/wecom-notify-debug.log";
function isDebug() {
    return process.env.WECOM_DEBUG === "1";
}
function debug(msg, data) {
    if (!isDebug())
        return;
    const ts = new Date().toISOString();
    const line = data ? `${ts} ${msg} ${JSON.stringify(data, null, 2)}` : `${ts} ${msg}`;
    appendFileSync(DEBUG_LOG, line + "\n");
}
// ─── Config ────────────────────────────────────────────────────────────
// 优先从 opencode.jsonc 读取，兼容 .env
function loadConfig(dir) {
    // 1. 尝试从 opencode.jsonc 读取
    try {
        const configPath = join(dir, ".opencode", "opencode.jsonc");
        const configText = readFileSync(configPath, "utf-8");
        // 简单解析 JSONC（去掉注释）
        const jsonText = configText
            .replace(/\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "");
        const config = JSON.parse(jsonText);
        const wecomConfig = config?.openkit?.wecomNotify || {};
        if (wecomConfig.webhook) {
            return {
                webhook: wecomConfig.webhook,
                enabled: wecomConfig.enabled !== false,
                repo: wecomConfig.repo || "",
            };
        }
    }
    catch { /* fallback to env */ }
    // 2. 从 .env 读取（兼容旧配置）
    try {
        for (const line of readFileSync(join(dir, ".env"), "utf-8").split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#"))
                continue;
            const i = t.indexOf("=");
            if (i === -1)
                continue;
            const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
            if (k && !process.env[k])
                process.env[k] = v;
        }
    }
    catch { /* .env is optional */ }
    return {
        webhook: process.env.WECOM_WEBHOOK_URL || "",
        enabled: process.env.WECOM_NOTIFY_ENABLED !== "false",
        repo: process.env.WECOM_REPO_NAME || "",
    };
}
const CFG = {
    ...loadConfig(process.cwd()),
    maxBytes: 4000,
    chunkDelayMs: 500,
    orphanTimeoutMs: 30 * 60 * 1000,
    templatePath: ".opencode/wecom-template.md",
    dedupeMs: {
        ready: 1500,
        error: 1500,
        permission: 1500,
        question: 1500,
    },
};
const repoPrefix = CFG.repo ? `${CFG.repo} · ` : "";
// ─── Helpers ───────────────────────────────────────────────────────────
const TOOL_EMOJI = {
    bash: "💻", read: "📖", write: "📝", edit: "✏️",
    glob: "🔍", grep: "🔎", task: "🧩", webfetch: "🌐",
    websearch: "🔍", ollama_query: "🧠", skill: "📘",
    question: "❓", todowrite: "📋",
};
const EXT_EMOJI = {
    ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️", py: "🐍",
    go: "🔷", rs: "🦀", json: "📋", yml: "⚙️", yaml: "⚙️",
    md: "📝", css: "🎨", html: "🌐", sql: "🗃️", sh: "💻",
    toml: "🔧", lock: "🔒", csv: "📊",
};
function bytes(s) { return Buffer.byteLength(s, "utf-8"); }
function truncate(text, max) {
    if (bytes(text) <= max)
        return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (bytes(text.slice(0, m)) <= max)
            lo = m;
        else
            hi = m - 1;
    }
    return text.slice(0, lo) + "...";
}
function md(...lines) { return lines.filter(Boolean).join("\n"); }
function toolArgs(tool, args) {
    if (!args)
        return "";
    switch (tool) {
        case "bash": return (args.command ?? "").slice(0, 60);
        case "read":
        case "edit":
        case "write": return args.filePath ?? "";
        case "glob":
        case "grep": return args.pattern ?? "";
        case "task": return (args.prompt ?? "").slice(0, 60);
        case "webfetch": return args.url ?? "";
        default: return Object.keys(args).slice(0, 2).map(k => `${k}=${String(args[k] ?? "").slice(0, 20)}`).join(", ");
    }
}
function extractFile(tool, args, output) {
    if (!args)
        return "";
    if (tool === "edit") {
        const parts = [];
        if (args.oldString)
            parts.push(`🔴 - ${truncate(args.oldString, 200)}`);
        if (args.newString)
            parts.push(`🟢 + ${truncate(args.newString, 200)}`);
        return parts.join("\n");
    }
    if (tool === "write" && args.content)
        return `🟢 ${truncate(args.content, 500)}`;
    const text = output?.output ?? output?.title ?? "";
    if (text && (tool === "read" || tool === "bash"))
        return truncate(text, tool === "bash" ? 300 : 500);
    return "";
}
function isFailed(output) {
    if (!output)
        return false;
    const s = String(output.output ?? "");
    return /\berror\b/i.test(s) || s.includes("failed") || (output.metadata?.exitCode && output.metadata.exitCode !== 0);
}
const QUOTA_RE = /quota exceeded|rate limit|usage allocated quota|\b429\b/;
function isQuota(output) {
    return !!output && QUOTA_RE.test(String(output.output ?? ""));
}
function toNonEmptyString(value) {
    if (typeof value !== "string")
        return null;
    const normalized = value.trim();
    return normalized || null;
}
function newSession() {
    return { tools: [], files: new Map(), startTime: Date.now(), isChild: null, retry: null };
}
function shouldDedupe(map, key, windowMs) {
    const now = Date.now();
    for (const [k, ts] of map) {
        if (now - ts >= windowMs)
            map.delete(k);
    }
    const last = map.get(key);
    if (last !== undefined && now - last < windowMs)
        return true;
    map.set(key, now);
    return false;
}
// ─── WeChat sender ─────────────────────────────────────────────────────
let _client = null;
async function sendWechat(payload) {
    if (!CFG.webhook) {
        debug("sendWechat: skipped (no webhook URL)");
        return;
    }
    try {
        debug("sendWechat: sending", { payload });
        const res = await fetch(CFG.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.errcode !== 0) {
            await _client?.app.log({ body: { service: "wecom-notify", level: "error", message: `webhook: ${JSON.stringify(json)}` } });
        }
    }
    catch (err) {
        await _client?.app.log({ body: { service: "wecom-notify", level: "error", message: `webhook failed: ${String(err)}` } });
    }
}
function sendMarkdown(body) {
    return sendWechat({ msgtype: "markdown", markdown: { content: body } });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function sendChunked(sections) {
    const sorted = [...sections].sort((a, b) => a.priority - b.priority);
    const chunks = [];
    let cur = "";
    for (const s of sorted) {
        const titlePart = s.title ? `\n\n## ${s.title}` : "";
        const text = `${titlePart}\n${s.content}`;
        if (bytes(text) > CFG.maxBytes) {
            if (cur) {
                chunks.push(cur);
                cur = "";
            }
            chunks.push(`${titlePart}\n${truncate(s.content, CFG.maxBytes - bytes(titlePart) - 20)}`);
        }
        else if (bytes(cur + text) > CFG.maxBytes) {
            chunks.push(cur);
            cur = text;
        }
        else {
            cur += text;
        }
    }
    if (cur)
        chunks.push(cur);
    for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `📎 ${i + 1}/${chunks.length}\n\n` : "";
        await sendMarkdown(prefix + chunks[i].trim());
        if (i < chunks.length - 1)
            await sleep(CFG.chunkDelayMs);
    }
}
// ─── Tool chain formatter ──────────────────────────────────────────────
function toolChain(records) {
    if (!records.length)
        return "";
    const lines = records.map((r, i) => {
        const emoji = TOOL_EMOJI[r.tool] ?? "🛠️";
        const status = r.failed ? " ❌" : "";
        return `${i + 1}. ${emoji} \`${r.tool}\`${status}\n   ${r.args || "(无参数)"}`;
    });
    return lines.join("\n");
}
function fileChanges(files) {
    if (!files.size)
        return "";
    const lines = [];
    for (const [path, content] of files) {
        const ext = (path.split(".").pop() ?? "").toLowerCase();
        const emoji = EXT_EMOJI[ext] ?? "📄";
        lines.push(`${emoji} \`${path}\``);
        if (content) {
            const truncated = truncate(content.replace(/\n{3,}/g, "\n\n"), 300);
            lines.push(`\`\`\`\n${truncated}\n\`\`\``);
        }
    }
    return lines.join("\n\n");
}
// ─── Plugin ────────────────────────────────────────────────────────────
export const WeComNotify = async ({ client, directory }) => {
    _client = client;
    debug("Plugin initialized", { enabled: CFG.enabled, directory });
    if (!CFG.enabled)
        return {};
    const sessions = new Map();
    const recentReady = new Map();
    const recentError = new Map();
    const recentPermission = new Map();
    const recentQuestion = new Map();
    let templateCache = null;
    let cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of sessions) {
            if (now - s.startTime > CFG.orphanTimeoutMs)
                sessions.delete(id);
        }
    }, 60_000);
    function getSession(id) {
        let s = sessions.get(id);
        if (!s) {
            s = newSession();
            sessions.set(id, s);
        }
        return s;
    }
    async function isParentSession(sessionID) {
        const s = sessions.get(sessionID);
        if (s?.isChild !== null && s?.isChild !== undefined)
            return !s.isChild;
        try {
            const r = await client.session.get({ path: { id: sessionID } });
            const isChild = !!r.data?.parentID;
            if (s)
                s.isChild = isChild;
            return !isChild;
        }
        catch {
            return true;
        }
    }
    async function getSessionContent(sessionID) {
        const result = { prompt: "", thinking: "", response: "" };
        try {
            const msgs = (await client.session.messages({ path: { id: sessionID } }) ?? {}).data ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m.info?.role === "user" && !result.prompt) {
                    const p = m.parts?.find((p) => p.type === "text");
                    if (p?.text)
                        result.prompt = p.text;
                }
            }
            const last = [...msgs].reverse().find((m) => m.info?.role === "assistant");
            if (last?.parts) {
                result.thinking = last.parts.filter((p) => p.type === "thinking").map((p) => p.text).join("\n");
                const textPart = last.parts.find((p) => p.type === "text");
                if (textPart?.text)
                    result.response = textPart.text;
            }
        }
        catch { /* non-critical */ }
        return result;
    }
    function loadTemplate(dir) {
        if (templateCache !== null)
            return templateCache;
        const p = join(dir, CFG.templatePath);
        templateCache = existsSync(p) ? readFileSync(p, "utf-8") : "";
        return templateCache || null;
    }
    function renderTmpl(tmpl, data) {
        let r = tmpl;
        for (const [k, v] of Object.entries(data))
            r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
        return r;
    }
    // ── Quota tracking ────────────────────────────────────────────────
    async function notifyQuotaFirst(tool, args, err) {
        await sendMarkdown(md(`## ⚠️ ${repoPrefix}API 配额超限`, ``, `**工具**: \`${tool}\``, `**参数**: \`${args}\``, `**重试**: 第 1 次`, ``, `> ${err}`, ``, `_等待重试中…_`));
    }
    async function notifyQuotaRetry(tool, args, count) {
        await sendMarkdown(md(`## ⚠️ ${repoPrefix}API 配额超限重试`, ``, `**工具**: \`${tool}\``, `**参数**: \`${args}\``, `**重试**: 第 ${count} 次`, ``, `_重试中…_`));
    }
    async function notifyQuotaRecovered(tool, args, count) {
        await sendMarkdown(md(`## ✅ ${repoPrefix}API 配额恢复`, ``, `经过 **${count}** 次重试后恢复`, ``, `**工具**: \`${tool}\``, `**参数**: \`${args}\``));
    }
    // ── Notification handlers ─────────────────────────────────────────
    async function handleSessionReady(sessionID) {
        debug("handleSessionReady", { sessionID });
        if (!(await isParentSession(sessionID))) {
            debug("handleSessionReady: skipped (child session)", { sessionID });
            return;
        }
        const dedupeKey = `ready:${sessionID}`;
        if (shouldDedupe(recentReady, dedupeKey, CFG.dedupeMs.ready)) {
            debug("handleSessionReady: skipped (dedupe)", { sessionID });
            return;
        }
        const s = getSession(sessionID);
        const now = Date.now();
        const elapsed = s.startTime ? Math.round((now - s.startTime) / 1000) : 0;
        const { prompt, thinking, response } = await getSessionContent(sessionID);
        const failedCount = s.tools.filter(t => t.failed).length;
        const statusEmoji = failedCount > 0 ? "⚠️" : "✅";
        const statusText = failedCount > 0 ? `完成 (${failedCount}个异常)` : "完成";
        const tmpl = loadTemplate(directory);
        if (tmpl) {
            await sendMarkdown(renderTmpl(tmpl, {
                status: `${statusEmoji} ${statusText}`,
                elapsed: `${elapsed}s`,
                prompt: prompt || "(无)",
                tools: s.tools.length > 0 ? toolChain(s.tools) : "(无)",
                toolCount: String(s.tools.length),
                files: s.files.size > 0 ? fileChanges(s.files) : "(无)",
                thinking: truncate(thinking || "(无)", 2000),
                response: truncate(response || "(无)", 2000),
            }));
        }
        else {
            const sections = [];
            const header = [
                `## ${statusEmoji} ${repoPrefix}${statusText}`,
                ``,
                `⏱️ **耗时**: \`${elapsed}s\` | 🔧 **工具调用**: \`${s.tools.length}次\` | 📁 **文件变更**: \`${s.files.size}个\``,
            ].join("\n");
            sections.push({ priority: 1, title: "", content: header });
            if (prompt) {
                sections.push({ priority: 2, title: "📝 **用户指令**", content: `> ${truncate(prompt, 500)}` });
            }
            if (s.tools.length) {
                sections.push({ priority: 3, title: "🔧 **工具调用链**", content: toolChain(s.tools) });
            }
            if (s.files.size) {
                sections.push({ priority: 4, title: "📁 **文件变更**", content: fileChanges(s.files) });
            }
            if (thinking) {
                sections.push({ priority: 5, title: "💭 **AI 思考**", content: `> ${truncate(thinking, 1000)}` });
            }
            if (response) {
                sections.push({ priority: 6, title: "💬 **AI 回复**", content: `> ${truncate(response, 1500)}` });
            }
            await sendChunked(sections);
        }
        s.tools = [];
        s.files.clear();
        s.startTime = 0;
        s.retry = null;
    }
    async function handleSessionError(sessionID, error) {
        debug("handleSessionError", { sessionID, error });
        if (!(await isParentSession(sessionID))) {
            debug("handleSessionError: skipped (child session)", { sessionID });
            return;
        }
        const dedupeKey = `error:${sessionID}`;
        if (shouldDedupe(recentError, dedupeKey, CFG.dedupeMs.error)) {
            debug("handleSessionError: skipped (dedupe)", { sessionID });
            return;
        }
        const err = error || "未知错误";
        const { prompt } = await getSessionContent(sessionID);
        await sendMarkdown(md(`## 🚨 ${repoPrefix}异常`, ``, `> ${String(err).slice(0, 300)}`, prompt ? `**触发**\n> ${prompt.slice(0, 200)}` : ""));
        sessions.delete(sessionID);
    }
    async function handlePermissionAsked(properties) {
        debug("handlePermissionAsked", { properties });
        const requestId = toNonEmptyString(properties.id);
        if (requestId && shouldDedupe(recentPermission, `permission:${requestId}`, CFG.dedupeMs.permission)) {
            debug("handlePermissionAsked: skipped (dedupe)", { requestId });
            return;
        }
        const action = (properties.action ?? properties.permission ?? "unknown");
        const resources = [].concat((properties.resources ?? properties.patterns ?? []));
        await sendMarkdown(md(`## 🔓 ${repoPrefix}需要授权`, ``, `**${action}**`, resources.filter(Boolean).map((r) => `- \`${r}\``).join("\n") || "", ``, "_终端审批_"));
    }
    async function handleQuestionAsked(properties) {
        debug("handleQuestionAsked", { properties });
        const toolInfo = properties.tool && typeof properties.tool === "object"
            ? properties.tool
            : undefined;
        const callID = toNonEmptyString(toolInfo?.callID);
        const sessionID = toNonEmptyString(properties.sessionID);
        const dedupeKey = callID
            ? `question:${sessionID}:${callID}`
            : sessionID
                ? `question:${sessionID}:request:${toNonEmptyString(properties.id)}`
                : null;
        if (dedupeKey && shouldDedupe(recentQuestion, dedupeKey, CFG.dedupeMs.question)) {
            debug("handleQuestionAsked: skipped (dedupe)", { dedupeKey });
            return;
        }
        const items = (properties.questions ?? []).map((q) => {
            const opts = (q.options ?? []).map((o) => `- \`${o.label}\``).join("\n") || "";
            return `**${q.multiple ? "🔘" : "⚪"} ${q.question}**\n${opts}`;
        }).join("\n\n");
        await sendMarkdown(md(`## ⏸️ ${repoPrefix}待确认`, ``, items, ``, "_终端回复以继续_"));
    }
    // ── Hook: tool.execute.after ───────────────────────────────────────
    async function onAfter(input, output) {
        debug("tool.execute.after", { tool: input.tool, sessionID: input.sessionID });
        const s = getSession(input.sessionID);
        const args = toolArgs(input.tool, input.args);
        const failed = isFailed(output);
        const content = extractFile(input.tool, input.args, output);
        s.tools.push({ tool: input.tool, args, title: output.title ?? "", failed, content });
        if (["edit", "write", "read"].includes(input.tool) && input.args?.filePath) {
            s.files.set(input.args.filePath, content);
        }
        // Quota tracking
        if (isQuota(output)) {
            debug("quota detected", { tool: input.tool, sessionID: input.sessionID });
            if (!s.retry) {
                s.retry = { count: 1, notified: 1 };
                await notifyQuotaFirst(input.tool, args, truncate(String(output.output ?? ""), 200));
            }
            else {
                s.retry.count++;
                if (s.retry.count > s.retry.notified) {
                    s.retry.notified = s.retry.count;
                    await notifyQuotaRetry(input.tool, args, s.retry.count);
                }
            }
        }
        else if (s.retry) {
            const n = s.retry.count;
            s.retry = null;
            if (n > 1)
                await notifyQuotaRecovered(input.tool, args, n);
        }
    }
    // ── Hook: event ────────────────────────────────────────────────────
    async function onEvent({ event }) {
        const props = event.properties ?? {};
        switch (event.type) {
            case "session.deleted": {
                debug("event:session.deleted", { sessionID: event.sessionID ?? props.sessionID });
                const sid = toNonEmptyString(event.sessionID ?? props.sessionID);
                if (sid)
                    sessions.delete(sid);
                return;
            }
            case "session.idle": {
                debug("event:session.idle", { sessionID: event.sessionID ?? props.sessionID });
                const sid = toNonEmptyString(event.sessionID ?? props.sessionID);
                if (sid)
                    await handleSessionReady(sid);
                return;
            }
            case "session.error": {
                debug("event:session.error", { sessionID: event.sessionID ?? props.sessionID, error: props.error });
                const sid = toNonEmptyString(event.sessionID ?? props.sessionID);
                const error = props.error;
                const errorMessage = typeof error === "string" ? error : error ? String(error) : undefined;
                if (sid)
                    await handleSessionError(sid, errorMessage);
                return;
            }
            case "permission.v2.asked":
            case "permission.updated":
            case "permission.asked": {
                debug(`event:${event.type}`, { properties: props });
                await handlePermissionAsked(props);
                return;
            }
            case "question.asked": {
                debug("event:question.asked", { properties: props });
                await handleQuestionAsked(props);
                return;
            }
        }
    }
    return {
        dispose: async () => {
            if (cleanupTimer) {
                clearInterval(cleanupTimer);
                cleanupTimer = null;
            }
            sessions.clear();
        },
        "tool.execute.after": onAfter,
        event: onEvent,
    };
};
