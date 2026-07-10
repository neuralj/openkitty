#!/usr/bin/env node
// spike: openhub-daemon 最小可运行入口
// 用法:
//   node dist/daemon/index.mjs                 # 常驻 daemon（等待任务）
//   node dist/daemon/index.mjs submit "prompt" [directory] [model]   # 提交并执行一个任务
import { loadConfig } from "./config.js";
import { OpenCodeClient } from "./opencode-client.js";
import { EventHub } from "./eventhub.js";
import { TaskQueue, type TaskRecord } from "./store.js";
import { CooldownManager } from "./cooldown.js";
import { QueueProcessor } from "./queue.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new OpenCodeClient(cfg.serverUrl, cfg.model);
  const events = new EventHub();
  const queue = new TaskQueue();

  let proc!: QueueProcessor;
  const cooldown = new CooldownManager(
    client,
    { pause: () => proc.pause(), resume: () => proc.resume() },
    cfg.pingIntervalMs,
    cfg.model,
  );
  proc = new QueueProcessor(client, queue, cooldown, events, cfg.model);

  // 简单的事件日志
  events.on("task", (p) => console.log("[event:task]", p));
  events.on("status", (p) => console.log("[event:status]", p));

  const mode = process.argv[2];
  if (mode === "submit") {
    const prompt = process.argv[3] || "Say hello in one word.";
    const directory = process.argv[4] || cfg.directories[0] || process.cwd();
    const model = process.argv[5] || cfg.model;
    const task = makeTask(prompt, directory, model);
    queue.enqueue(task);
    console.log(`[spike] submitted ${task.id} -> ${directory} (model=${model || "default"})`);

    while (true) {
      const t = queue.get(task.id)!;
      if (t.status === "completed" || t.status === "failed") {
        console.log(`[spike] ${task.id} -> ${t.status}`);
        break;
      }
      if (!proc.isPaused()) await proc.processOne();
      await sleep(1000);
    }
    process.exit(0);
  }

  // 常驻 daemon 模式
  console.log(
    `[spike] openhub-daemon (spike) server=${cfg.serverUrl} dirs=${cfg.directories} ping=${cfg.pingIntervalMs}ms`,
  );
  await proc.run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
