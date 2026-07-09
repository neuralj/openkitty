const RETRY_LIMIT = 2;
export const CooldownGuard = async ({ client }) => {
    if (process.env.COOLDOWN_GUARD_ENABLED === "false") {
        return {};
    }
    const retries = new Map();
    return {
        event: async ({ event }) => {
            if (event?.type !== "session.status")
                return;
            const props = event.properties ?? {};
            const sid = props.sessionID;
            const status = props.status;
            if (!sid || !status)
                return;
            if (status.type === "retry") {
                const count = (retries.get(sid) ?? 0) + 1;
                retries.set(sid, count);
                if (count > RETRY_LIMIT) {
                    try {
                        await client.session.abort({ path: { id: sid } });
                    }
                    catch { }
                    retries.delete(sid);
                }
            }
            else if (status.type === "idle") {
                retries.delete(sid);
            }
        },
        dispose: async () => {
            retries.clear();
        },
    };
};
