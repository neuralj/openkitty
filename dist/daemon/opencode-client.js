// spike: OpenCode Server HTTP 客户端
// 端点对齐 openhub/adapters/opencode.go（6 个端点）
// aborted 信号: 响应 info.error.name === "MessageAbortedError"
export class OpenCodeClient {
    baseUrl;
    defaultModel;
    constructor(baseUrl, defaultModel = "") {
        this.baseUrl = baseUrl;
        this.defaultModel = defaultModel;
    }
    parseModel(model) {
        const parts = model.split("/");
        if (parts.length === 2)
            return { providerID: parts[0], modelID: parts[1] };
        return { modelID: model };
    }
    async createSession(directory) {
        const url = `${this.baseUrl}/session?directory=${encodeURIComponent(directory)}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok)
            throw new Error(`create session failed: ${res.status}`);
        const body = (await res.json());
        return body.id;
    }
    async listSessions(directory) {
        const url = `${this.baseUrl}/session?directory=${encodeURIComponent(directory)}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`list sessions failed: ${res.status}`);
        const sessions = (await res.json());
        return sessions.filter((s) => !s.parentID);
    }
    async sendMessage(sessionId, message, model = "") {
        const m = model || this.defaultModel;
        const body = {
            parts: [{ type: "text", text: message }],
        };
        if (m)
            body.model = this.parseModel(m);
        const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`send message failed: ${res.status}`);
        const response = (await res.json());
        const aborted = response.info?.error?.name === "MessageAbortedError";
        return { aborted, response };
    }
    async abort(sessionId) {
        const res = await fetch(`${this.baseUrl}/session/${sessionId}/abort`, { method: "POST" });
        if (!res.ok)
            throw new Error(`abort failed: ${res.status}`);
    }
    async getMessages(sessionId) {
        const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`);
        if (!res.ok)
            throw new Error(`get messages failed: ${res.status}`);
        return (await res.json());
    }
    async deleteSession(sessionId) {
        const res = await fetch(`${this.baseUrl}/session/${sessionId}`, { method: "DELETE" });
        if (!res.ok)
            throw new Error(`delete session failed: ${res.status}`);
    }
}
