export class CooldownManager {
    client;
    controls;
    pingIntervalMs;
    defaultModel;
    aborted = new Map();
    recoveryConfigs = new Map();
    probeTimer = null;
    constructor(client, controls, pingIntervalMs, defaultModel = "") {
        this.client = client;
        this.controls = controls;
        this.pingIntervalMs = pingIntervalMs;
        this.defaultModel = defaultModel;
    }
    has(agentID) {
        return this.aborted.has(agentID);
    }
    getCooldowns() {
        return [...this.aborted.keys()];
    }
    setRecoveryConfig(agentID, prompt) {
        if (agentID)
            this.recoveryConfigs.set(agentID, prompt);
    }
    add(agentID) {
        if (!agentID)
            return;
        this.aborted.set(agentID, { until: Date.now() + this.pingIntervalMs });
        this.controls.pause();
        this.startProbe();
    }
    startProbe() {
        if (this.probeTimer)
            return;
        const tick = async () => {
            const agents = [...this.aborted.keys()];
            if (agents.length === 0) {
                this.stopProbe();
                return;
            }
            const aid = agents[0];
            try {
                const { aborted } = await this.client.sendMessage(aid, "only ping", this.defaultModel);
                if (!aborted) {
                    // 探活成功：脱离 cooldown，恢复全部
                    await this.resumeAll();
                }
                // 仍 aborted -> 等待下一轮 tick
            }
            catch {
                // 网络错误：等待下一轮
            }
        };
        this.probeTimer = setInterval(tick, this.pingIntervalMs);
    }
    stopProbe() {
        if (this.probeTimer) {
            clearInterval(this.probeTimer);
            this.probeTimer = null;
        }
    }
    async resumeAll() {
        const agents = [...this.aborted.keys()];
        for (const aid of agents) {
            const prompt = this.recoveryConfigs.get(aid) || "继续";
            try {
                await this.client.sendMessage(aid, prompt, this.defaultModel);
            }
            catch {
                // 恢复 prompt 失败：忽略，继续其它 agent
            }
        }
        this.aborted.clear();
        this.stopProbe();
        this.controls.resume();
    }
}
