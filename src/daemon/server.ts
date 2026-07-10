// HTTP API + SSE + 静态 webui（对齐 openhub 的 /events + 查询 API）
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { EventHub } from "./eventhub.js";
import type { QueueProcessor } from "./queue.js";
import type { Store, TaskRecord } from "./store.js";
import type { OpenCodeClient } from "./opencode-client.js";
import type { CooldownManager } from "./cooldown.js";
import type { RecurringScheduler } from "./recurring.js";
import type { DaemonConfig } from "./config.js";

export interface HttpDeps {
  config: DaemonConfig;
  events: EventHub;
  queue: QueueProcessor;
  store: Store;
  client: OpenCodeClient;
  cooldown: CooldownManager;
  scheduler: RecurringScheduler;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function makeTask(prompt: string, directory: string, model: string): TaskRecord {
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    directory,
    prompt,
    model,
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
export { makeTask };

function json(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf ? (JSON.parse(buf) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function startHttpServer(deps: HttpDeps): http.Server {
  const { config, events, queue, store, client, cooldown, scheduler } = deps;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost:${config.port}`);
      const path = url.pathname;
      const method = req.method || "GET";

      // ---- SSE 实时事件 ----
      if (path === "/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = (kind: string, data: unknown) =>
          res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
        const onTask = (p: unknown) => send("task", p);
        const onAgent = (p: unknown) => send("agent", p);
        const onStatus = (p: unknown) => send("status", p);
        events.on("task", onTask);
        events.on("agent", onAgent);
        events.on("status", onStatus);
        send("status", { connected: true });
        req.on("close", () => {
          events.off("task", onTask);
          events.off("agent", onAgent);
          events.off("status", onStatus);
        });
        return;
      }

      // ---- health ----
      if (path === "/health" && method === "GET") {
        return json(res, 200, {
          status: "ok",
          paused: queue.isPaused(),
          cooldowns: cooldown.getCooldowns(),
          port: config.port,
        });
      }

      // ---- tasks ----
      if (path === "/tasks" && method === "GET") {
        const all = await store.listAll();
        const status = url.searchParams.get("status");
        return json(res, 200, status ? all.filter((t) => t.status === status) : all);
      }
      if (path === "/tasks" && method === "POST") {
        const body = await readJson(req);
        const directory =
          (body.directory as string) || config.directories[0] || process.cwd();
        const task = makeTask(
          body.prompt as string,
          directory,
          (body.model as string) || "",
        );
        await store.enqueue(task);
        events.emitTask({ id: task.id, status: "pending" });
        return json(res, 201, { id: task.id });
      }
      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (taskMatch && method === "GET") {
        const t = await store.get(taskMatch[1]);
        return t ? json(res, 200, t) : json(res, 404, { error: "not found" });
      }
      if (taskMatch && method === "POST" && url.searchParams.get("action") === "abort") {
        const t = await store.get(taskMatch[1]);
        if (!t) return json(res, 404, { error: "not found" });
        if (t.agentID) await client.abort(t.agentID);
        return json(res, 200, { ok: true });
      }

      // ---- agents ----
      if (path === "/agents" && method === "GET") {
        return json(res, 200, {
          directories: config.directories,
          cooldowns: cooldown.getCooldowns(),
        });
      }

      // ---- recurring ----
      if (path === "/recurring" && method === "GET") {
        return json(res, 200, await scheduler.list());
      }
      if (path === "/recurring" && method === "POST") {
        const body = await readJson(req);
        const rec = await scheduler.add({
          name: body.name as string,
          directory: (body.directory as string) || config.directories[0] || process.cwd(),
          prompt: body.prompt as string,
          model: (body.model as string) || "",
          cron: body.cron as string,
          timezone: body.timezone as string | undefined,
          enabled: body.enabled !== false,
        });
        return json(res, 201, rec);
      }
      const recMatch = path.match(/^\/recurring\/([^/]+)$/);
      if (recMatch && method === "DELETE") {
        await scheduler.remove(recMatch[1]);
        return json(res, 200, { ok: true });
      }

      // ---- 静态 webui ----
      if (config.webDir && existsSync(config.webDir)) {
        const rel = path === "/" ? "/index.html" : path;
        const filePath = normalize(join(config.webDir, rel));
        if (filePath.startsWith(config.webDir) && existsSync(filePath)) {
          const s = await stat(filePath);
          if (s.isFile()) {
            const data = await readFile(filePath);
            res.writeHead(200, {
              "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
            });
            return res.end(data);
          }
        }
        // SPA fallback
        const indexP = join(config.webDir, "index.html");
        if (existsSync(indexP)) {
          const data = await readFile(indexP);
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end(data);
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  server.listen(config.port, () => {
    console.log(`[daemon] HTTP server on http://localhost:${config.port}`);
  });
  return server;
}
