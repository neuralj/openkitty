// spike: 极简事件总线（后续 daemon 内嵌 SSE 时复用）
import { EventEmitter } from "node:events";
export class EventHub extends EventEmitter {
    emitTask(p) {
        this.emit("task", p);
    }
    emitAgent(p) {
        this.emit("agent", p);
    }
    emitStatus(p) {
        this.emit("status", p);
    }
}
