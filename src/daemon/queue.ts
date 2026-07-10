// spike: 队列处理器（单 running 语义，对齐 openhub/scheduler/queue_processor.go）
import type { OpenCodeClient } from "./opencode-client.js";
import type { EventHub } from "./eventhub.js";
import type { TaskQueue } from "./store.js";
import type { CooldownManager } from "./cooldown.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class QueueProcessor {
  public paused = false;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly queue: TaskQueue,
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

  /** 处理一个 pending 任务；返回是否处理了 */
  async processOne(): Promise<boolean> {
    if (this.paused) return false;
    const task = this.queue.peekPending();
    if (!task) return false;
    if (task.agentID && this.cooldown.has(task.agentID)) return false;

    this.queue.markRunning(task.id);
    this.events.emitTask({ id: task.id, status: "running" });

    try {
      // OpenCode Server 离线时 createSession 失败 -> 保持 pending 稍后重试
      if (!task.agentID) {
        try {
          task.agentID = await this.client.createSession(task.directory);
        } catch {
          this.queue.markFailed(task.id, "server offline");
          this.queue.get(task.id)!.status = "pending"; // 重试（未计入 attempts 上限）
          return true;
        }
      }

      const { aborted } = await this.client.sendMessage(
        task.agentID,
        task.prompt,
        task.model || this.defaultModel,
      );

      if (aborted) {
        this.queue.markFailed(task.id, "rate limited");
        this.cooldown.add(task.agentID); // 进入 cooldown + Pause
        this.events.emitStatus({ cooldowns: this.cooldown.getCooldowns() });
      } else {
        this.queue.markCompleted(task.id);
        this.events.emitTask({ id: task.id, status: "completed" });
      }
    } catch (e) {
      this.queue.markFailed(task.id, String(e));
      this.events.emitTask({ id: task.id, status: "failed", error: String(e) });
    }
    return true;
  }

  /** 常驻模式：循环处理（Ctrl-C 退出） */
  async run(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.paused) await this.processOne();
      await sleep(1000);
    }
  }
}
