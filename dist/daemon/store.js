// 持久化存储（决策 1：lowdb / JSON 文件，纯 TS 零原生依赖）
// 替代 openhub 的 SQLite。tasks + recurring 两类集合，方法均为异步。
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
export class Store {
    db;
    path;
    constructor(db, path) {
        this.db = db;
        this.path = path;
    }
    /** 打开（或创建）JSON 持久化文件 */
    static async create(dbPath) {
        const adapter = new JSONFile(dbPath);
        const db = new Low(adapter, { tasks: [], recurring: [], pipelines: [] });
        await db.read();
        if (!db.data)
            db.data = { tasks: [], recurring: [], pipelines: [] };
        return new Store(db, dbPath);
    }
    // ---- tasks ----
    async enqueue(t) {
        this.db.data.tasks.push(t);
        await this.db.write();
    }
    async get(id) {
        return this.db.data.tasks.find((t) => t.id === id);
    }
    /** 取第一个 pending 任务（返回内存引用，调用方只读字段） */
    async peekPending() {
        return this.db.data.tasks.find((t) => t.status === "pending") ?? null;
    }
    async listPending() {
        return this.db.data.tasks.filter((t) => t.status === "pending");
    }
    async listAll() {
        return [...this.db.data.tasks];
    }
    async update(id, patch) {
        const t = this.db.data.tasks.find((x) => x.id === id);
        if (!t)
            return undefined;
        Object.assign(t, patch, { updatedAt: Date.now() });
        await this.db.write();
        return t;
    }
    async markRunning(id) {
        const t = await this.get(id);
        if (!t)
            return;
        await this.update(id, { status: "running", attempts: t.attempts + 1 });
    }
    async markCompleted(id) {
        await this.update(id, { status: "completed" });
    }
    /** 手动重试：重置为 pending */
    async markRetry(id) {
        await this.update(id, { status: "pending", error: undefined });
    }
    /** 失败：未超 maxAttempts 则回到 pending（重试），否则终态 failed */
    async markFailed(id, reason) {
        const t = await this.get(id);
        if (!t)
            return;
        const status = t.attempts >= t.maxAttempts ? "failed" : "pending";
        await this.update(id, { status, error: reason });
    }
    // ---- recurring ----
    async addRecurring(r) {
        this.db.data.recurring.push(r);
        await this.db.write();
    }
    async listRecurring() {
        return [...this.db.data.recurring];
    }
    async getRecurring(id) {
        return this.db.data.recurring.find((r) => r.id === id);
    }
    async updateRecurring(id, patch) {
        const r = this.db.data.recurring.find((x) => x.id === id);
        if (!r)
            return;
        Object.assign(r, patch);
        await this.db.write();
    }
    async removeRecurring(id) {
        this.db.data.recurring = this.db.data.recurring.filter((r) => r.id !== id);
        await this.db.write();
    }
    // ---- pipelines ----
    async addPipeline(pl) {
        this.db.data.pipelines.push(pl);
        await this.db.write();
    }
    async getPipeline(id) {
        return this.db.data.pipelines.find((p) => p.id === id);
    }
    async listPipelines() {
        return [...this.db.data.pipelines];
    }
    async updatePipeline(id, patch) {
        const p = this.db.data.pipelines.find((x) => x.id === id);
        if (!p)
            return undefined;
        Object.assign(p, patch);
        await this.db.write();
        return p;
    }
    async removePipeline(id) {
        this.db.data.pipelines = this.db.data.pipelines.filter((p) => p.id !== id);
        await this.db.write();
    }
}
