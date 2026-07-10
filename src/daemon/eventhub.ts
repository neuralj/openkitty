// spike: 极简事件总线（后续 daemon 内嵌 SSE 时复用）
import { EventEmitter } from "node:events";

export type EventKind = "task" | "agent" | "status";

export class EventHub extends EventEmitter {
  emitTask(p: unknown): void {
    this.emit("task", p);
  }
  emitAgent(p: unknown): void {
    this.emit("agent", p);
  }
  emitStatus(p: unknown): void {
    this.emit("status", p);
  }
}
