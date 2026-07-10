export class PipelineRunner {
    store;
    queue;
    events;
    client;
    /** 正在运行的 pipeline ID → 用于恢复 */
    running = new Set();
    constructor(store, queue, events, client) {
        this.store = store;
        this.queue = queue;
        this.events = events;
        this.client = client;
    }
    /** 启动一个 pipeline：提交第一个 stage 为任务 */
    async start(pipelineId) {
        const pl = await this.store.getPipeline(pipelineId);
        if (!pl)
            throw new Error(`pipeline ${pipelineId} not found`);
        if (pl.stages.length === 0)
            throw new Error("pipeline has no stages");
        await this.store.updatePipeline(pipelineId, {
            status: "running",
            currentStage: 0,
            updatedAt: Date.now(),
        });
        this.running.add(pipelineId);
        await this.submitStage(pl, 0);
        this.events.emitStatus({ pipeline: { id: pipelineId, status: "running" } });
        return (await this.store.getPipeline(pipelineId));
    }
    /** 提交一个 stage 作为普通任务 */
    async submitStage(pl, stageIndex) {
        const stage = pl.stages[stageIndex];
        if (!stage)
            return;
        const task = {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            directory: pl.directory,
            prompt: stage.prompt,
            model: stage.model || "",
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pipelineId: pl.id,
            agentID: pl.sessionId, // 复用同一 session（首阶段为 undefined，QueueProcessor 自动创建）
        };
        await this.store.enqueue(task);
        // 更新 stage 状态
        pl.stages[stageIndex] = {
            ...stage,
            status: "running",
            taskId: task.id,
        };
        await this.store.updatePipeline(pl.id, {
            stages: pl.stages,
            currentStage: stageIndex,
            updatedAt: Date.now(),
        });
        this.events.emitTask({
            id: task.id,
            status: "pending",
            pipelineId: pl.id,
            stage: stageIndex,
        });
    }
    /** 当一个任务完成时调用（由事件监听触发） */
    async onTaskCompleted(task) {
        if (!task.pipelineId)
            return;
        const pl = await this.store.getPipeline(task.pipelineId);
        if (!pl || pl.status !== "running")
            return;
        const stageIndex = pl.stages.findIndex((s) => s.taskId === task.id);
        if (stageIndex < 0)
            return;
        // 从 store 重新读取，确认真实状态（避免事件时序导致误判可重试失败为终态）
        const current = await this.store.get(task.id);
        if (!current)
            return;
        if (current.status === "pending")
            return; // 自动重试中，不推进 pipeline
        if (current.status === "running")
            return; // 仍在执行
        const stage = pl.stages[stageIndex];
        if (current.status === "completed") {
            // 当前 stage 成功
            pl.stages[stageIndex] = { ...stage, status: "completed" };
            // 首阶段完成时记录 sessionId，后续阶段复用
            if (stageIndex === 0 && current.agentID && !pl.sessionId) {
                pl.sessionId = current.agentID;
            }
            const nextIndex = stageIndex + 1;
            if (nextIndex < pl.stages.length) {
                // 还有下一 stage → 提交
                await this.store.updatePipeline(pl.id, {
                    stages: pl.stages,
                    sessionId: pl.sessionId,
                    currentStage: nextIndex,
                    updatedAt: Date.now(),
                });
                await this.submitStage(pl, nextIndex);
                this.events.emitStatus({
                    pipeline: { id: pl.id, stage: nextIndex, total: pl.stages.length },
                });
            }
            else {
                // 最后一个 stage 完成 → pipeline 完成
                await this.store.updatePipeline(pl.id, {
                    status: "completed",
                    stages: pl.stages,
                    updatedAt: Date.now(),
                });
                this.running.delete(pl.id);
                this.events.emitStatus({ pipeline: { id: pl.id, status: "completed" } });
            }
        }
        else {
            // 任务终态失败 → pipeline 失败，剩余 stage 跳过
            pl.stages[stageIndex] = {
                ...stage,
                status: "failed",
                error: current.error,
            };
            // 标记剩余 stage 为 skipped
            for (let i = stageIndex + 1; i < pl.stages.length; i++) {
                pl.stages[i] = { ...pl.stages[i], status: "skipped" };
            }
            await this.store.updatePipeline(pl.id, {
                status: "failed",
                stages: pl.stages,
                updatedAt: Date.now(),
            });
            this.running.delete(pl.id);
            this.events.emitStatus({ pipeline: { id: pl.id, status: "failed" } });
        }
    }
    /** 中止 pipeline：abort 当前运行的 task，标记剩余 skipped */
    async abort(pipelineId) {
        const pl = await this.store.getPipeline(pipelineId);
        if (!pl)
            throw new Error("not found");
        const stage = pl.stages[pl.currentStage];
        if (stage?.taskId) {
            try {
                await this.client.abort(stage.taskId);
            }
            catch { /* best effort */ }
        }
        // 标记当前和后续 stage
        for (let i = pl.currentStage; i < pl.stages.length; i++) {
            pl.stages[i] = {
                ...pl.stages[i],
                status: i === pl.currentStage ? "failed" : "skipped",
                error: i === pl.currentStage ? "aborted" : undefined,
            };
        }
        await this.store.updatePipeline(pl.id, {
            status: "failed",
            stages: pl.stages,
            updatedAt: Date.now(),
        });
        this.running.delete(pl.id);
    }
    /** daemon 重启时恢复卡住的 pipeline */
    async recoverStale() {
        const all = await this.store.listPipelines();
        for (const pl of all) {
            if (pl.status !== "running")
                continue;
            const stage = pl.stages[pl.currentStage];
            if (!stage?.taskId)
                continue;
            // 检查关联任务的状态
            const task = await this.store.get(stage.taskId);
            if (!task) {
                // 任务丢失 → 回退 stage 为 pending
                pl.stages[pl.currentStage] = { ...stage, status: "pending", taskId: undefined };
                await this.store.updatePipeline(pl.id, {
                    stages: pl.stages,
                    updatedAt: Date.now(),
                });
                continue;
            }
            if (task.status === "completed" || task.status === "failed") {
                await this.onTaskCompleted(task);
            }
            // 若任务仍在 running → 等待下一轮任务完成事件
        }
    }
    /** 初始化：恢复卡住的 pipeline + 注册事件监听 */
    init() {
        this.recoverStale();
        // 监听任务完成事件，驱动 pipeline 推进
        this.events.on("task", (p) => {
            const payload = p;
            if (payload.id &&
                (payload.status === "completed" || payload.status === "failed")) {
                this.store.get(payload.id).then((task) => {
                    if (task?.pipelineId)
                        this.onTaskCompleted(task);
                });
            }
        });
        console.log("[pipeline] runner started");
    }
}
