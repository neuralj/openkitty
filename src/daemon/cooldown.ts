// spike: cooldown 检测 + probe 自愈
// 对齐 openhub/handlers/cooldown.go:
//   - AddCooldown(agentID): 标记 cooldown + 启动 probe + Pause 队列
//   - probe 按 pingInterval 对 abortedAgents[0] 发 "only ping"
//   - ping 成功(不再 aborted) -> resumeAll(发送恢复 prompt + Resume 队列 + StopProbe)
import type { OpenCodeClient } from "./opencode-client.js";

export interface CooldownControls {
  pause(): void;
  resume(): void;
}

export class CooldownManager {
  private aborted = new Map<string, { until: number }>();
  private recoveryConfigs = new Map<string, string>();
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly controls: CooldownControls,
    private readonly pingIntervalMs: number,
    private readonly defaultModel = "",
  ) {}

  has(agentID: string): boolean {
    return this.aborted.has(agentID);
  }

  getCooldowns(): string[] {
    return [...this.aborted.keys()];
  }

  setRecoveryConfig(agentID: string, prompt: string): void {
    if (agentID) this.recoveryConfigs.set(agentID, prompt);
  }

  add(agentID: string): void {
    if (!agentID) return;
    this.aborted.set(agentID, { until: Date.now() + this.pingIntervalMs });
    this.controls.pause();
    this.startProbe();
  }

  private startProbe(): void {
    if (this.probeTimer) return;
    const tick = async (): Promise<void> => {
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
      } catch {
        // 网络错误：等待下一轮
      }
    };
    this.probeTimer = setInterval(tick, this.pingIntervalMs);
  }

  private stopProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private async resumeAll(): Promise<void> {
    const agents = [...this.aborted.keys()];
    for (const aid of agents) {
      const prompt = this.recoveryConfigs.get(aid) || "继续";
      try {
        await this.client.sendMessage(aid, prompt, this.defaultModel);
      } catch {
        // 恢复 prompt 失败：忽略，继续其它 agent
      }
    }
    this.aborted.clear();
    this.stopProbe();
    this.controls.resume();
  }
}
