#!/usr/bin/env node
// openhub MCP server（agent 操作入口）
//
// 被 OpenCode 拉起（stdio，JSON-RPC 2.0 帧：Content-Length + body）。
// 暴露 openhub_* 工具，内部转调 openhub-daemon 的 HTTP API。
// 纯 TS 零新依赖（手写最小 MCP 传输层，符合 MCP 规范）。
import process from "node:process";
const DAEMON = (process.env.OPENHUB_DAEMON_URL ||
    `http://localhost:${process.env.OPENHUB_DAEMON_PORT || 7099}`).replace(/\/$/, "");
const TOOLS = [
    {
        name: "openhub_submit_task",
        description: "向 openhub daemon 提交一个任务（目录 + 提示词），返回 taskId",
        inputSchema: {
            type: "object",
            properties: {
                directory: { type: "string", description: "任务运行的目录" },
                prompt: { type: "string", description: "发给 OpenCode agent 的提示词" },
                model: { type: "string", description: "可选模型 provider/model" },
            },
            required: ["prompt"],
        },
    },
    {
        name: "openhub_get_task_status",
        description: "查询单个任务的状态",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
        },
    },
    {
        name: "openhub_list_tasks",
        description: "列出任务，可按 status 过滤（pending/running/completed/failed）",
        inputSchema: {
            type: "object",
            properties: { status: { type: "string" } },
        },
    },
    {
        name: "openhub_abort_task",
        description: "中止一个运行中的任务（abort 对应 OpenCode session）",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
        },
    },
    {
        name: "openhub_schedule_recurring",
        description: "创建定时任务（cron 5 字段或 @hourly/@daily）",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                directory: { type: "string" },
                prompt: { type: "string" },
                cron: { type: "string", description: "如 '0 * * * *' 或 '@hourly'" },
                model: { type: "string" },
                timezone: { type: "string" },
            },
            required: ["name", "prompt", "cron"],
        },
    },
    {
        name: "openhub_list_agents",
        description: "列出受管目录与 cooldown 状态",
        inputSchema: { type: "object", properties: {} },
    },
];
async function api(method, path, body) {
    const res = await fetch(`${DAEMON}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    }
    catch {
        return { raw: text };
    }
}
async function callTool(name, args) {
    switch (name) {
        case "openhub_submit_task":
            return api("POST", "/tasks", {
                directory: args.directory,
                prompt: args.prompt,
                model: args.model,
            });
        case "openhub_get_task_status":
            return api("GET", `/tasks/${args.id}`);
        case "openhub_list_tasks":
            return api("GET", `/tasks${args.status ? `?status=${encodeURIComponent(String(args.status))}` : ""}`);
        case "openhub_abort_task":
            return api("POST", `/tasks/${args.id}?action=abort`);
        case "openhub_schedule_recurring":
            return api("POST", "/recurring", {
                name: args.name,
                directory: args.directory,
                prompt: args.prompt,
                cron: args.cron,
                model: args.model,
                timezone: args.timezone,
            });
        case "openhub_list_agents":
            return api("GET", "/agents");
        default:
            throw new Error(`unknown tool ${name}`);
    }
}
// ---- stdio JSON-RPC 帧处理 ----
function send(msg) {
    const s = JSON.stringify(msg);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
        const he = buf.indexOf("\r\n\r\n");
        if (he === -1)
            break;
        const header = buf.slice(0, he).toString();
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m)
            break;
        const len = parseInt(m[1], 10);
        const start = he + 4;
        if (buf.length < start + len)
            break;
        const body = buf.slice(start, start + len).toString();
        buf = buf.slice(start + len);
        let msg;
        try {
            msg = JSON.parse(body);
        }
        catch {
            continue;
        }
        void handle(msg);
    }
});
async function handle(msg) {
    const { id, method, params } = msg;
    if (method === "initialize") {
        return send({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "openhub", version: "1.0.0" },
            },
        });
    }
    if (method === "notifications/initialized")
        return; // 通知无需响应
    if (method === "tools/list") {
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
        try {
            const result = await callTool(params?.name, params?.arguments || {});
            return send({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
            });
        }
        catch (e) {
            return send({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: `error: ${String(e)}` }],
                    isError: true,
                },
            });
        }
    }
    if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
}
