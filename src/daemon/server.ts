// HTTP API + SSE + 静态 webui（对齐 openhub-web Vue 的 API 契约）
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventHub } from "./eventhub.js";
import type { QueueProcessor } from "./queue.js";
import type { Store, TaskRecord, PipelineStage } from "./store.js";
import type { OpenCodeClient } from "./opencode-client.js";
import type { CooldownManager } from "./cooldown.js";
import type { RecurringScheduler } from "./recurring.js";
import type { PipelineRunner } from "./pipeline.js";
import type { DaemonConfig } from "./config.js";

export interface HttpDeps {
  config: DaemonConfig;
  events: EventHub;
  queue: QueueProcessor;
  store: Store;
  client: OpenCodeClient;
  cooldown: CooldownManager;
  scheduler: RecurringScheduler;
  pipeline: PipelineRunner;
}

// ---- web-compatible response shapes ----

interface WebTask {
  id: string;
  prompt: string;
  agentID: string;
  channel: string;
  status: string;
  error?: string;
  createdAt: string;
  updatedAt?: string;
}

interface WebAgent {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number; deleted?: number };
  summary?: string;
}

function toWebTask(t: TaskRecord): WebTask {
  return {
    id: t.id,
    prompt: t.prompt,
    agentID: t.agentID || "",
    channel: t.model || "cli",
    status: t.status,
    error: (t as any).error,
    createdAt: new Date(t.createdAt).toISOString(),
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
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

function resolveWebDir(config: DaemonConfig): string | null {
  // explicit config
  if (config.webDir && existsSync(config.webDir)) return config.webDir;
  // built-in: relative to dist/daemon/ -> ../../assets/openhub-web
  try {
    const distDir = dirname(fileURLToPath(import.meta.url));
    const builtin = join(distDir, "..", "..", "assets", "openhub-web");
    if (existsSync(builtin)) return builtin;
  } catch { /* ignore */ }
  // fallback: cwd
  const cwdDir = join(process.cwd(), "assets", "openhub-web");
  if (existsSync(cwdDir)) return cwdDir;
  return null;
}

async function serveStatic(
  webDir: string,
  path: string,
  res: http.ServerResponse,
): Promise<boolean> {
  const rel = path === "/" ? "/index.html" : path;
  const filePath = normalize(join(webDir, rel));
  if (!filePath.startsWith(webDir)) return false;
  if (existsSync(filePath)) {
    const s = await stat(filePath);
    if (s.isFile()) {
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
      return true;
    }
  }
  // SPA fallback
  const indexP = join(webDir, "index.html");
  if (existsSync(indexP)) {
    const data = await readFile(indexP);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
    return true;
  }
  return false;
}

export function startHttpServer(deps: HttpDeps): http.Server {
  const { config, events, queue, store, client, cooldown, scheduler, pipeline } = deps;
  const webDir = resolveWebDir(config);

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
        // initial status snapshot for web
        const all = await store.listAll();
        send("status", {
          queue: all.map(toWebTask),
          cooldowns: cooldown.getCooldowns(),
          pending: all.filter((t) => t.status === "pending").length,
          paused: queue.isPaused(),
        });
        req.on("close", () => {
          events.off("task", onTask);
          events.off("agent", onAgent);
          events.off("status", onStatus);
        });
        return;
      }

      // ---- /status (web-compatible) ----
      if (path === "/status" && method === "GET") {
        const all = await store.listAll();
        return json(res, 200, {
          queue: all.map(toWebTask),
          cooldowns: cooldown.getCooldowns(),
          pending: all.filter((t) => t.status === "pending").length,
          paused: queue.isPaused(),
        });
      }

      // ---- health (daemon internal) ----
      if (path === "/health" && method === "GET") {
        return json(res, 200, {
          status: "ok",
          paused: queue.isPaused(),
          cooldowns: cooldown.getCooldowns(),
          port: config.port,
        });
      }

      // ---- /task (web-compatible submit) ----
      if (path === "/task" && method === "POST") {
        const body = await readJson(req);
        const directory =
          (body.directory as string) || config.directories[0] || process.cwd();
        const task = makeTask(
          body.prompt as string,
          directory,
          (body.model as string) || config.model || "",
        );
        await store.enqueue(task);
        events.emitTask(toWebTask(task));
        return json(res, 201, toWebTask(task));
      }

      // ---- /task/:id/retry (web-compatible) ----
      const taskRetryMatch = path.match(/^\/task\/([^/]+)\/retry$/);
      if (taskRetryMatch && method === "POST") {
        const t = await store.get(taskRetryMatch[1]);
        if (!t) return json(res, 404, { error: "not found" });
        await store.markRetry(t.id);
        events.emitTask(toWebTask({ ...t, status: "pending", updatedAt: Date.now() }));
        return json(res, 200, { ok: true });
      }

      // ---- /queue (web-compatible pause/resume) ----
      if (path === "/queue" && method === "POST") {
        const body = await readJson(req);
        const action = body.action as string;
        if (action === "pause") queue.pause();
        else if (action === "resume") queue.resume();
        else return json(res, 400, { error: "action must be pause or resume" });
        return json(res, 200, { paused: queue.isPaused() });
      }

      // ---- agents (web-compatible) ----
      if (path === "/agents" && method === "GET") {
        const all = await store.listAll();
        const agentMap = new Map<string, WebAgent>();
        for (const t of all) {
          if (t.agentID && !agentMap.has(t.agentID)) {
            agentMap.set(t.agentID, {
              id: t.agentID,
              title: t.directory,
              directory: t.directory,
              time: { created: t.createdAt, updated: t.updatedAt },
            });
          }
        }
        return json(res, 200, [...agentMap.values()]);
      }

      const agentDelMatch = path.match(/^\/agents\/([^/]+)\/delete$/);
      if (agentDelMatch && method === "POST") {
        try {
          await client.deleteSession(agentDelMatch[1]);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { error: String(e) });
        }
      }

      // ---- tasks (daemon internal API, backward compat) ----
      if (path === "/tasks" && method === "GET") {
        const all = await store.listAll();
        const filterStatus = url.searchParams.get("status");
        return json(res, 200, filterStatus ? all.filter((t) => t.status === filterStatus) : all);
      }
      if (path === "/tasks" && method === "POST") {
        const body = await readJson(req);
        const directory =
          (body.directory as string) || config.directories[0] || process.cwd();
        const task = makeTask(
          body.prompt as string,
          directory,
          (body.model as string) || config.model || "",
        );
        await store.enqueue(task);
        events.emitTask(toWebTask(task));
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

      // ---- pipelines (L1 原子编排) ----
      if (path === "/pipeline" && method === "GET") {
        return json(res, 200, await store.listPipelines());
      }
      if (path === "/pipeline" && method === "POST") {
        const body = await readJson(req);
        const stages: PipelineStage[] = (body.stages as Array<Record<string, unknown>> || []).map(
          (s, i) => ({
            index: i,
            label: (s.label as string) || `stage_${i}`,
            prompt: s.prompt as string,
            model: s.model as string | undefined,
            status: "pending" as const,
          }),
        );
        if (stages.length === 0) return json(res, 400, { error: "stages required" });
        const pl = {
          id: `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: (body.name as string) || `pipeline_${Date.now()}`,
          directory: (body.directory as string) || config.directories[0] || process.cwd(),
          status: "pending" as const,
          stages,
          currentStage: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await store.addPipeline(pl);
        // auto-start the pipeline
        const started = await pipeline.start(pl.id);
        return json(res, 201, started);
      }
      const plMatch = path.match(/^\/pipeline\/([^/]+)$/);
      if (plMatch && method === "GET") {
        const pl = await store.getPipeline(plMatch[1]);
        return pl ? json(res, 200, pl) : json(res, 404, { error: "not found" });
      }
      if (plMatch && method === "DELETE") {
        await store.removePipeline(plMatch[1]);
        return json(res, 200, { ok: true });
      }
      const plAbortMatch = path.match(/^\/pipeline\/([^/]+)\/abort$/);
      if (plAbortMatch && method === "POST") {
        try {
          await pipeline.abort(plAbortMatch[1]);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 404, { error: String(e) });
        }
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

      // ---- 静态 webui (openhub-web Vue SPA) ----
      if (webDir) {
        const served = await serveStatic(webDir, path, res);
        if (served) return;
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  server.listen(config.port, () => {
    const staticInfo = webDir ? ` + webui static (${webDir})` : "";
    console.log(`[daemon] HTTP server on http://localhost:${config.port}${staticInfo}`);
  });
  return server;
}
