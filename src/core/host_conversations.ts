export interface HostConversationMeta {
  title: string | null;
  summary: string | null;
  runState: string | null;
}

export function hasHostConversationEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.POLY_SWARM_DISABLE_HOST_SYNC === "1") return false;
  return Boolean(env.ANTIGRAVITY_LS_ADDRESS?.trim() && env.ANTIGRAVITY_CSRF_TOKEN?.trim());
}

export async function fetchHostConversationMeta(
  conversationId: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<HostConversationMeta | null> {
  const id = conversationId.trim();
  const env = opts.env ?? process.env;
  if (!id || !hasHostConversationEnv(env)) return null;

  const address = env.ANTIGRAVITY_LS_ADDRESS!.trim();
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN!.trim();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 800);
  const url = /^https?:\/\//i.test(address)
    ? `${address.replace(/\/$/, "")}/product.v1.ConversationService/GetConversation`
    : `http://${address}/product.v1.ConversationService/GetConversation`;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-antigravity-csrf-token": csrfToken,
      },
      body: JSON.stringify({ conversationId: id }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      conversation?: { annotations?: { title?: unknown }; state?: { summary?: unknown; runState?: unknown } };
      annotations?: { title?: unknown };
      state?: { summary?: unknown; runState?: unknown };
    } | null;
    if (!raw || typeof raw !== "object") return null;
    const body = raw.conversation && typeof raw.conversation === "object" ? raw.conversation : raw;
    const title = typeof body.annotations?.title === "string" && body.annotations.title.trim()
      ? body.annotations.title.trim()
      : null;
    const summary = typeof body.state?.summary === "string" && body.state.summary.trim()
      ? body.state.summary.trim()
      : null;
    const runState = typeof body.state?.runState === "string" && body.state.runState.trim()
      ? body.state.runState.trim()
      : null;
    return { title, summary, runState };
  } catch (err) {
    console.error(`[poly-swarm] host conversation metadata fetch failed (${id}):`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
