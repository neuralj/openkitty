// 队列处理器（单 running 语义，对齐 openhub/scheduler/queue_processor.go）
// store 已升级为异步 lowdb 持久化，本模块所有读写均 await。
import type { OpenCodeClient } from "./opencode-client.js";
import type { EventHub } from "./eventhub.js";
import type { Store } from "./store.js";
import type { CooldownManager } from "./cooldown.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class QueueProcessor {
  public paused = false;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly store: Store,
    private readonly cooldown: CooldownManager,
    private readonly events: EventHub,
    private readonly defaultModel = "",
  ) {}

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  isPaused(): boolean {
    return this.paused;
  }

  /** 处理一个 pending 任务；返回是否处理了（用于驱动循环） */
  async processOne(): Promise<boolean> {
    if (this.paused) return false;
    const task = await this.store.peekPending();
    if (!task) return false;
    if (task.agentID && this.cooldown.has(task.agentID)) return false;

    await this.store.markRunning(task.id);
    this.events.emitTask({ id: task.id, status: "running" });

    try {
      // OpenCode Server 离线时 createSession 失败 -> 保持 pending 稍后重试（不消耗 attempts）
      let agentID = task.agentID;
      if (!agentID) {
        try {
          agentID = await this.client.createSession(task.directory);
          await this.store.update(task.id, { agentID });
        } catch {
          this.events.emitStatus({ offline: true, taskId: task.id });
          return true;
        }
      }

      const { aborted } = await this.client.sendMessage(
        agentID,
        task.prompt,
        task.model || this.defaultModel,
      );

      if (aborted) {
        await this.store.markFailed(task.id, "rate limited");
        this.cooldown.add(agentID); // 进入 cooldown + Pause
        this.events.emitStatus({ cooldowns: this.cooldown.getCooldowns() });
      } else {
        await this.store.markCompleted(task.id);
        this.events.emitTask({ id: task.id, status: "completed" });
      }
    } catch (e) {
      const msg = String(e);
      await this.store.markFailed(task.id, msg);
      this.events.emitTask({ id: task.id, status: "failed", error: msg });
    }
    return true;
  }

  /** 常驻模式：循环处理（Ctrl-C 退出） */
  async run(): Promise<void> {
    for (;;) {
      if (!this.paused) await this.processOne();
      await sleep(1000);
    }
  }
}
