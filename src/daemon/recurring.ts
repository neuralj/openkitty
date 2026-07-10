// 定时任务（recurring）—— 对齐 openhub 的 5 字段 cron + @hourly/@daily
// 每分钟 tick 一次，到期则生成任务实例入队。
import type { Store, RecurringRecord } from "./store.js";
import type { QueueProcessor } from "./queue.js";
import type { EventHub } from "./eventhub.js";

interface ParsedField {
  /** 命中的分钟/小时/日/月/周集合；null 表示 *（任意） */
  set: Set<number> | null;
}

export interface ParsedCron {
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
  raw: string;
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

function parseField(field: string, min: number, max: number): ParsedField {
  if (field === "*") return { set: null };
  const set = new Set<number>();
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = Number(stepStr);
      let lo = min;
      let hi = max;
      if (range !== "*") {
        if (range.includes("-")) {
          [lo, hi] = range.split("-").map(Number);
        } else {
          lo = hi = Number(range);
        }
      }
      for (let v = lo; v <= hi; v += step) set.add(v);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let v = lo; v <= hi; v++) set.add(v);
    } else {
      set.add(Number(part));
    }
  }
  return { set };
}

export function parseCron(expr: string): ParsedField[] | null {
  const raw = ALIASES[expr] ?? expr;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return [
    parseField(parts[0], 0, 59),
    parseField(parts[1], 0, 23),
    parseField(parts[2], 1, 31),
    parseField(parts[3], 1, 12),
    parseField(parts[4], 0, 6),
  ];
}

function matches(f: ParsedField, v: number): boolean {
  return f.set === null || f.set.has(v);
}

/** 从 from 起计算下一次命中的时间（逐分钟递增，最多查 4 年） */
export function nextRun(parsed: ParsedField[], from: Date): Date {
  const d = new Date(from.getTime() + 60_000);
  const limit = from.getTime() + 4 * 366 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (
      matches(parsed[0], d.getMinutes()) &&
      matches(parsed[1], d.getHours()) &&
      matches(parsed[2], d.getDate()) &&
      matches(parsed[3], d.getMonth() + 1) &&
      matches(parsed[4], d.getDay())
    ) {
      return d;
    }
    d.setTime(d.getTime() + 60_000);
  }
  return new Date(limit);
}

export class RecurringScheduler {
  constructor(
    private readonly store: Store,
    private readonly queue: QueueProcessor,
    private readonly events: EventHub,
  ) {}

  start(): void {
    setInterval(() => void this.tick(), 60_000);
    // 启动后立即检查一次（处理错过的触发）
    void this.tick();
  }

  private async tick(): Promise<void> {
    const all = await this.store.listRecurring();
    const now = Date.now();
    for (const r of all) {
      if (!r.enabled) continue;
      const parsed = parseCron(r.cron);
      if (!parsed) continue;
      const base = r.lastRunAt ? new Date(r.lastRunAt) : new Date(now - 60_000);
      const next = nextRun(parsed, base).getTime();
      if (next <= now) {
        await this.spawn(r);
        await this.store.updateRecurring(r.id, { lastRunAt: now });
      }
    }
  }

  private async spawn(r: RecurringRecord): Promise<void> {
    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      directory: r.directory,
      prompt: r.prompt,
      model: r.model,
      status: "pending" as const,
      attempts: 0,
      maxAttempts: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.enqueue(task);
    this.events.emitTask({ id: task.id, status: "pending", recurring: r.name });
  }

  async list(): Promise<RecurringRecord[]> {
    return this.store.listRecurring();
  }

  async add(r: Omit<RecurringRecord, "id" | "lastRunAt">): Promise<RecurringRecord> {
    const rec: RecurringRecord = {
      ...r,
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };
    await this.store.addRecurring(rec);
    return rec;
  }

  async remove(id: string): Promise<void> {
    await this.store.removeRecurring(id);
  }
}
