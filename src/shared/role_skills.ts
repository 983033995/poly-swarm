export const MAX_ROLE_SKILLS = 12;

export const READONLY_BUILTIN_IDENTITY_IDS = [
  "architect",
  "tech-lead",
  "product-analyst",
  "researcher",
  "verifier",
  "sec-auditor",
  "perf-reviewer",
  "qa-challenger",
] as const;

export function isRoleSkillPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 240) return false;
  const parts = value.split("/");
  return parts.at(-1) === "SKILL.md" && parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !/[^a-z\d._-]/i.test(part),
  );
}

export function areRoleSkillPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ROLE_SKILLS && value.every(isRoleSkillPath);
}
