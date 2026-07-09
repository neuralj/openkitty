import type { Plugin, PluginInput } from "@opencode-ai/plugin"

const RETRY_LIMIT = 2

export const CooldownGuard: Plugin = async ({ client }: PluginInput) => {
  if (process.env.COOLDOWN_GUARD_ENABLED === "false") {
    return {}
  }

  const retries = new Map<string, number>()

  return {
    event: async ({ event }: { event: any }) => {
      if (event?.type !== "session.status") return
      const props = event.properties ?? {}
      const sid = props.sessionID
      const status = props.status
      if (!sid || !status) return

      if (status.type === "retry") {
        const count = (retries.get(sid) ?? 0) + 1
        retries.set(sid, count)

        if (count > RETRY_LIMIT) {
          try { await client.session.abort({ path: { id: sid } }) } catch {}
          retries.delete(sid)
        }
      } else if (status.type === "idle") {
        retries.delete(sid)
      }
    },

    dispose: async () => {
      retries.clear()
    },
  }
}
