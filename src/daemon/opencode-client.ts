// spike: OpenCode Server HTTP 客户端
// 端点对齐 openhub/adapters/opencode.go（6 个端点）
// aborted 信号: 响应 info.error.name === "MessageAbortedError"

export interface Session {
  id: string;
  parentID: string | null;
  directory?: string;
  title?: string;
}

export interface MessageResponse {
  info?: {
    finish?: string;
    error?: { name: string };
  };
}

export interface SendMessageOutcome {
  aborted: boolean;
  response: MessageResponse | null;
}

export class OpenCodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultModel = "",
  ) {}

  private parseModel(model: string): { providerID: string; modelID: string } | { modelID: string } {
    const parts = model.split("/");
    if (parts.length === 2) return { providerID: parts[0], modelID: parts[1] };
    return { modelID: model };
  }

  async createSession(directory: string): Promise<string> {
    const url = `${this.baseUrl}/session?directory=${encodeURIComponent(directory)}`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) throw new Error(`create session failed: ${res.status}`);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async listSessions(directory: string): Promise<Session[]> {
    const url = `${this.baseUrl}/session?directory=${encodeURIComponent(directory)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
    const sessions = (await res.json()) as Session[];
    return sessions.filter((s) => !s.parentID);
  }

  async sendMessage(
    sessionId: string,
    message: string,
    model = "",
  ): Promise<SendMessageOutcome> {
    const m = model || this.defaultModel;
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: message }],
    };
    if (m) body.model = this.parseModel(m);
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`send message failed: ${res.status}`);
    const response = (await res.json()) as MessageResponse;
    const aborted = response.info?.error?.name === "MessageAbortedError";
    return { aborted, response };
  }

  async abort(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/abort`, { method: "POST" });
    if (!res.ok) throw new Error(`abort failed: ${res.status}`);
  }

  async getMessages(sessionId: string): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`);
    if (!res.ok) throw new Error(`get messages failed: ${res.status}`);
    return (await res.json()) as unknown[];
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`delete session failed: ${res.status}`);
  }
}
