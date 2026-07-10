// 持久化存储（决策 1：lowdb / JSON 文件，纯 TS 零原生依赖）
// 替代 openhub 的 SQLite。tasks + recurring 两类集合，方法均为异步。
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

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
  error?: string;
}

export interface RecurringRecord {
  id: string;
  name: string;
  directory: string;
  prompt: string;
  model: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: number;
}

interface DBShape {
  tasks: TaskRecord[];
  recurring: RecurringRecord[];
}

export class Store {
  private constructor(
    private readonly db: Low<DBShape>,
    public readonly path: string,
  ) {}

  /** 打开（或创建）JSON 持久化文件 */
  static async create(dbPath: string): Promise<Store> {
    const adapter = new JSONFile<DBShape>(dbPath);
    const db = new Low<DBShape>(adapter, { tasks: [], recurring: [] });
    await db.read();
    if (!db.data) db.data = { tasks: [], recurring: [] };
    return new Store(db, dbPath);
  }

  // ---- tasks ----
  async enqueue(t: TaskRecord): Promise<void> {
    this.db.data.tasks.push(t);
    await this.db.write();
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return this.db.data.tasks.find((t) => t.id === id);
  }

  /** 取第一个 pending 任务（返回内存引用，调用方只读字段） */
  async peekPending(): Promise<TaskRecord | null> {
    return this.db.data.tasks.find((t) => t.status === "pending") ?? null;
  }

  async listPending(): Promise<TaskRecord[]> {
    return this.db.data.tasks.filter((t) => t.status === "pending");
  }

  async listAll(): Promise<TaskRecord[]> {
    return [...this.db.data.tasks];
  }

  async update(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | undefined> {
    const t = this.db.data.tasks.find((x) => x.id === id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: Date.now() });
    await this.db.write();
    return t;
  }

  async markRunning(id: string): Promise<void> {
    const t = await this.get(id);
    if (!t) return;
    await this.update(id, { status: "running", attempts: t.attempts + 1 });
  }

  async markCompleted(id: string): Promise<void> {
    await this.update(id, { status: "completed" });
  }

  /** 失败：未超 maxAttempts 则回到 pending（重试），否则终态 failed */
  async markFailed(id: string, reason: string): Promise<void> {
    const t = await this.get(id);
    if (!t) return;
    const status: TaskStatus = t.attempts >= t.maxAttempts ? "failed" : "pending";
    await this.update(id, { status, error: reason });
  }

  // ---- recurring ----
  async addRecurring(r: RecurringRecord): Promise<void> {
    this.db.data.recurring.push(r);
    await this.db.write();
  }

  async listRecurring(): Promise<RecurringRecord[]> {
    return [...this.db.data.recurring];
  }

  async getRecurring(id: string): Promise<RecurringRecord | undefined> {
    return this.db.data.recurring.find((r) => r.id === id);
  }

  async updateRecurring(id: string, patch: Partial<RecurringRecord>): Promise<void> {
    const r = this.db.data.recurring.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    await this.db.write();
  }

  async removeRecurring(id: string): Promise<void> {
    this.db.data.recurring = this.db.data.recurring.filter((r) => r.id !== id);
    await this.db.write();
  }
}
