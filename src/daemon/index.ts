#!/usr/bin/env node
// openhub-daemon 常驻入口
// 默认：启动 HTTP API + SSE + 队列循环 + 定时调度（7×24 常驻，不依赖 OpenCode 是否打开）。
// 子命令 `submit "prompt" [dir] [model]`：一次性提交并执行，仅用于本地验证。
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode-client.js";
import { EventHub } from "./eventhub.js";
import { Store } from "./store.js";
import { CooldownManager } from "./cooldown.js";
import { QueueProcessor } from "./queue.js";
import { RecurringScheduler } from "./recurring.js";
import { PipelineRunner } from "./pipeline.js";
import { startHttpServer, makeTask } from "./server.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const events = new EventHub();
  const store = await Store.create(cfg.dbPath);
  const client = new OpenCodeClient(cfg.serverUrl, cfg.model);

  let proc!: QueueProcessor;
  const cooldown = new CooldownManager(
    client,
    { pause: () => proc.pause(), resume: () => proc.resume() },
    cfg.pingIntervalMs,
    cfg.model,
  );
  proc = new QueueProcessor(client, store, cooldown, events, cfg.model);
  const scheduler = new RecurringScheduler(store, proc, events);
  const pipeline = new PipelineRunner(store, proc, events, client);

  events.on("task", (p) => console.log("[event:task]", p));
  events.on("status", (p) => console.log("[event:status]", p));

  const mode = process.argv[2];
  if (mode === "submit") {
    const prompt = process.argv[3] || "Say hello in one word.";
    const directory = process.argv[4] || cfg.directories[0] || process.cwd();
    const model = process.argv[5] || cfg.model;
    const task = makeTask(prompt, directory, model);
    await store.enqueue(task);
    console.log(`[daemon] submitted ${task.id} -> ${directory} (model=${model || "default"})`);
    for (;;) {
      const t = await store.get(task.id);
      if (!t) break;
      if (t.status === "completed" || t.status === "failed") {
        console.log(`[daemon] ${task.id} -> ${t.status}`);
        break;
      }
      if (!proc.isPaused()) await proc.processOne();
      await sleep(1000);
    }
    process.exit(0);
  }

  // 常驻 daemon 模式
  console.log(
    `[daemon] openhub-daemon server=${cfg.serverUrl} dirs=${cfg.directories} ping=${cfg.pingIntervalMs}ms db=${cfg.dbPath}`,
  );
  startHttpServer({ config: cfg, events, queue: proc, store, client, cooldown, scheduler, pipeline });
  scheduler.start();
  pipeline.init();  // 恢复卡住的 pipeline + 注册事件监听
  await proc.run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
