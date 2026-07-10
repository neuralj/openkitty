// spike: 内存任务队列（后续以 lowdb 持久化替换，接口保持一致）
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  directory: string;
  prompt: string;
  model: string;
  status: TaskStatus;
  agentID?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  cooldownUntil?: number;
}

export class TaskQueue {
  private tasks = new Map<string, TaskRecord>();
  private order: string[] = [];

  enqueue(t: TaskRecord): void {
    this.tasks.set(t.id, t);
    this.order.push(t.id);
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** 取第一个 pending 任务（不改变状态，由调用方 markRunning） */
  peekPending(): TaskRecord | null {
    for (const id of this.order) {
      const t = this.tasks.get(id)!;
      if (t.status === "pending") return t;
    }
    return null;
  }

  markRunning(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = "running";
    t.attempts += 1;
    t.updatedAt = Date.now();
  }

  /** 失败：未超 maxAttempts 则回到 pending（重试），否则终态 failed */
  markFailed(id: string, _reason: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = t.attempts >= t.maxAttempts ? "failed" : "pending";
    t.updatedAt = Date.now();
  }

  markCompleted(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = "completed";
    t.updatedAt = Date.now();
  }

  listPending(): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }
}
