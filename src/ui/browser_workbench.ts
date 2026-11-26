/** Select HTTP transport for the local workbench and its two same-origin frames. */
export function readBrowserWorkbench(): { isMcp: boolean; swarmId: string | null } {
  if (window.location.origin === "null") return { isMcp: true, swarmId: null };
  const query = new URLSearchParams(window.location.search);
  if (window.parent === window) {
    return { isMcp: false, swarmId: query.get("swarm_id")?.trim() || null };
  }
  try {
    const parentUrl = window.parent.location;
    const swarmId = query.get("swarm_id")?.trim() || null;
    if (
      swarmId &&
      query.get("embed") === "codex" &&
      parentUrl.origin === window.location.origin &&
      parentUrl.pathname === "/codex" &&
      new URLSearchParams(parentUrl.search).get("swarm_id")?.trim() === swarmId
    ) {
      return { isMcp: false, swarmId };
    }
  } catch {
    // A cross-origin MCP App cannot read its host's location.
  }
  return { isMcp: true, swarmId: null };
}
