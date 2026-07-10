const ALIASES = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
};
function parseField(field, min, max) {
    if (field === "*")
        return { set: null };
    const set = new Set();
    for (const part of field.split(",")) {
        if (part.includes("/")) {
            const [range, stepStr] = part.split("/");
            const step = Number(stepStr);
            let lo = min;
            let hi = max;
            if (range !== "*") {
                if (range.includes("-")) {
                    [lo, hi] = range.split("-").map(Number);
                }
                else {
                    lo = hi = Number(range);
                }
            }
            for (let v = lo; v <= hi; v += step)
                set.add(v);
        }
        else if (part.includes("-")) {
            const [lo, hi] = part.split("-").map(Number);
            for (let v = lo; v <= hi; v++)
                set.add(v);
        }
        else {
            set.add(Number(part));
        }
    }
    return { set };
}
export function parseCron(expr) {
    const raw = ALIASES[expr] ?? expr;
    const parts = raw.trim().split(/\s+/);
    if (parts.length !== 5)
        return null;
    return [
        parseField(parts[0], 0, 59),
        parseField(parts[1], 0, 23),
        parseField(parts[2], 1, 31),
        parseField(parts[3], 1, 12),
        parseField(parts[4], 0, 6),
    ];
}
function matches(f, v) {
    return f.set === null || f.set.has(v);
}
/** 从 from 起计算下一次命中的时间（逐分钟递增，最多查 4 年） */
export function nextRun(parsed, from) {
    const d = new Date(from.getTime() + 60_000);
    const limit = from.getTime() + 4 * 366 * 24 * 3600 * 1000;
    while (d.getTime() < limit) {
        if (matches(parsed[0], d.getMinutes()) &&
            matches(parsed[1], d.getHours()) &&
            matches(parsed[2], d.getDate()) &&
            matches(parsed[3], d.getMonth() + 1) &&
            matches(parsed[4], d.getDay())) {
            return d;
        }
        d.setTime(d.getTime() + 60_000);
    }
    return new Date(limit);
}
export class RecurringScheduler {
    store;
    queue;
    events;
    constructor(store, queue, events) {
        this.store = store;
        this.queue = queue;
        this.events = events;
    }
    start() {
        setInterval(() => void this.tick(), 60_000);
        // 启动后立即检查一次（处理错过的触发）
        void this.tick();
    }
    async tick() {
        const all = await this.store.listRecurring();
        const now = Date.now();
        for (const r of all) {
            if (!r.enabled)
                continue;
            const parsed = parseCron(r.cron);
            if (!parsed)
                continue;
            const base = r.lastRunAt ? new Date(r.lastRunAt) : new Date(now - 60_000);
            const next = nextRun(parsed, base).getTime();
            if (next <= now) {
                await this.spawn(r);
                await this.store.updateRecurring(r.id, { lastRunAt: now });
            }
        }
    }
    async spawn(r) {
        const task = {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            directory: r.directory,
            prompt: r.prompt,
            model: r.model,
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await this.store.enqueue(task);
        this.events.emitTask({ id: task.id, status: "pending", recurring: r.name });
    }
    async list() {
        return this.store.listRecurring();
    }
    async add(r) {
        const rec = {
            ...r,
            id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        };
        await this.store.addRecurring(rec);
        return rec;
    }
    async remove(id) {
        await this.store.removeRecurring(id);
    }
}
