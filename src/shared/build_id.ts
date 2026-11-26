declare const __POLY_SWARM_BUILD_ID__: string | undefined;

export function getBuildId(): string {
  return typeof __POLY_SWARM_BUILD_ID__ === "string" && __POLY_SWARM_BUILD_ID__.length > 0
    ? __POLY_SWARM_BUILD_ID__
    : "dev";
}
