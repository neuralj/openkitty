// spike: daemon 配置加载（读取环境变量）
export interface DaemonConfig {
  serverUrl: string;
  directories: string[];
  port: number;
  pingIntervalMs: number;
  model: string;
  dbPath: string;
}

export function loadConfig(): DaemonConfig {
  return {
    serverUrl: process.env.OPENHUB_SERVER_URL || "http://localhost:4096",
    directories: (process.env.OPENHUB_DIRECTORIES || process.cwd())
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    port: Number(process.env.OPENHUB_PORT || 7099),
    pingIntervalMs: Number(process.env.OPENHUB_PING_INTERVAL || 14 * 60 * 1000),
    model: process.env.OPENHUB_MODEL || "",
    dbPath: process.env.OPENHUB_DB || ".openhub.json",
  };
}
