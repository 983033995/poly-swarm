import type { BackendId, StaffAvatarId, WorkerRole, WorkerSummary } from "../shared/types.js";
import { BRAND_LOGO_URI } from "./assets_inline.generated.js";
import { VENDOR_BUILDING_URIS } from "./assets_3d.generated.js";
import {
  STUDIO_AVATAR_URIS,
  STUDIO_BG_URI,
  STUDIO_DESK_GIFS,
  STUDIO_DESK_STATIC_URIS,
} from "./assets_studio.generated.js";
import { esc } from "./markdown.js";
import coordinatorAvatarUri from "./assets/coordinator-avatar.webp";
import userAvatarUri from "./assets/user-avatar.webp";

export function renderChatIdentityAvatar(identity: "coordinator" | "user", size = 34): string {
  const src = identity === "coordinator" ? coordinatorAvatarUri : userAvatarUri;
  const brand = identity === "coordinator" ? "#a482bf" : "#75a28b";
  return `<span class="employee-avatar-wrap" style="--brand:${brand};width:${size}px;height:${size}px" aria-hidden="true"><img class="employee-avatar-img" src="${esc(src)}" width="${size}" height="${size}" alt="" draggable="false" /></span>`;
}

export const BACKEND_COLORS: Record<string, string> = {
  codex: "#C85A32",
  cursor: "#D97706",
  grok: "#2F7D4C",
  agy: "#2B6CB0",
  codebuddy: "#0F766E",
  opencode: "#B45309",
  qoder: "#576574",
  trae: "#0EA5A4",
  mock: "#78716C",
};

const TRAE_BUILDING_URI = "data:image/svg+xml," + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
  <defs>
    <linearGradient id="roof" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="#c1fff0"/><stop offset="1" stop-color="#46dace"/>
    </linearGradient>
    <linearGradient id="front" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="#218e92"/><stop offset="1" stop-color="#10444d"/>
    </linearGradient>
    <linearGradient id="side" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="#176069"/><stop offset="1" stop-color="#092a36"/>
    </linearGradient>
  </defs>
  <ellipse cx="81" cy="139" rx="69" ry="13" fill="#083139" opacity=".35"/>
  <path d="M12 121l68-32 68 32v9l-68 31-68-31z" fill="#173c46"/>
  <path d="M12 121l68-32 68 32-68 31z" fill="#569998"/>
  <path d="M22 121l58-27 58 27-58 26z" fill="#0b535c" stroke="#82f3d8" stroke-width="1.3"/>
  <path d="M34 60l46 21v55l-46-21z" fill="url(#front)"/>
  <path d="M80 81l46-21v55l-46 21z" fill="url(#side)"/>
  <path d="M34 60l46-22 46 22-46 21z" fill="url(#roof)"/>
  <path d="M51 32l29 14v33L51 65z" fill="url(#front)"/>
  <path d="M80 46l29-14v33L80 79z" fill="url(#side)"/>
  <path d="M51 32l29-14 29 14-29 14z" fill="url(#roof)" stroke="#c4fff1" stroke-width="1.2"/>
  <path d="M61 32l19 9 19-9-19-9z" fill="#169b98" opacity=".65"/>
  <path d="M71 31l9-4 10 5-3 1-4-2-6 3-3-1 6-3-4 2z" fill="#edfffa"/>
  <g fill="none" stroke="#82f3d8" stroke-width="2.1" opacity=".84">
    <path d="M57 43l16 8m-16 1l16 8m-16 1l16 8M87 51l16-8m-16 17l16-8m-16 17l16-8"/>
    <path d="M41 74l32 15M41 83l32 15M41 92l32 15M41 101l32 15M87 89l32-15M87 98l32-15M87 107l32-15M87 116l32-15"/>
  </g>
  <path d="M80 82v54M51 33v32M34 61v54m92-54v54" fill="none" stroke="#9dfde6" stroke-width="1" opacity=".55"/>
  <path d="M63 115l12 6v12l-12-6z" fill="#092e3a" stroke="#85e0ca"/>
</svg>`.trim());

const STUDIO_CHAR_IDS: StaffAvatarId[] = ["aria", "leo", "theo", "jules", "mia"];

function hash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i += 1) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return Math.abs(n >>> 0);
}

function color(backend: string): string {
  return esc(Object.hasOwn(BACKEND_COLORS, backend) ? BACKEND_COLORS[backend]! : BACKEND_COLORS.mock!);
}

function pickStudioCharId(params: {
  avatar?: StaffAvatarId | string | null;
  backend: string;
  model?: string | null;
  name?: string | null;
  role?: WorkerRole;
}): StaffAvatarId {
  if (params.avatar && STUDIO_CHAR_IDS.includes(params.avatar as StaffAvatarId)) {
    return params.avatar as StaffAvatarId;
  }
  const nameKey = (params.name ?? "").trim().toLowerCase();
  for (const id of STUDIO_CHAR_IDS) {
    if (nameKey === id || nameKey.includes(id)) return id;
  }
  if (nameKey.includes("arch") || nameKey.includes("plan")) return "aria";
  if (nameKey.includes("fe") || nameKey.includes("ui") || nameKey.includes("design") || params.backend === "codebuddy") {
    return "jules";
  }
  if (params.role === "verifier" || nameKey.includes("review") || nameKey.includes("verify")) return "theo";
  if (params.role === "researcher" || nameKey.includes("research") || nameKey.includes("explore")) return "mia";
  if (params.backend === "codex" && (nameKey === "" || nameKey.includes("be") || nameKey.includes("author"))) {
    return nameKey && hash(nameKey) % 2 === 1 ? "aria" : "leo";
  }
  const idx = hash(`${params.name ?? ""}:${params.backend}:${params.model ?? ""}:${params.role ?? ""}`) % STUDIO_CHAR_IDS.length;
  return STUDIO_CHAR_IDS[idx]!;
}

function pickBuildingUri(backend: string): string {
  if (backend === "trae") return TRAE_BUILDING_URI;
  return VENDOR_BUILDING_URIS[backend] ?? VENDOR_BUILDING_URIS.codex!;
}

export function renderBrandLogoSvg(size = 28): string {
  const s = Math.max(16, Math.min(64, size));
  return `<img class="brand-logo" src="${BRAND_LOGO_URI}" width="${s}" height="${s}" alt="" aria-hidden="true" draggable="false" />`;
}

export function renderEmployeeAvatarSvg(params: {
  backend: BackendId | string;
  avatar?: StaffAvatarId | string | null;
  model?: string | null;
  name?: string | null;
  role?: WorkerRole;
  size?: number;
  animated?: boolean;
  badgeText?: string | null;
}): string {
  const size = Math.max(20, Math.min(160, params.size ?? 48));
  const brand = color(params.backend);
  const charId = pickStudioCharId({
    avatar: params.avatar,
    backend: String(params.backend),
    model: params.model,
    name: params.name,
    role: params.role,
  });
  const uri = STUDIO_AVATAR_URIS[charId] ?? STUDIO_AVATAR_URIS.aria!;
  const cls = [
    "employee-avatar-wrap",
    params.animated ? "is-animated" : "",
    params.badgeText ? "has-avatar-badge" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const badge = params.badgeText
    ? `<span class="avatar-subbadge">${esc(params.badgeText)}</span>`
    : "";
  return `<span class="${cls}" style="--brand:${brand};width:${size}px;height:${size}px" role="img" aria-label="${esc(params.backend)} ${esc(params.role ?? "worker")}"><img class="employee-avatar-img" src="${uri}" width="${size}" height="${size}" alt="${esc(params.name ?? params.backend)}" draggable="false" />${badge}</span>`;
}

export function renderVendorBuildingSvg(backend: BackendId | string, size = 56): string {
  const s = Math.max(24, Math.min(144, size));
  const brand = color(String(backend));
  const uri = pickBuildingUri(String(backend));
  return `<span class="vendor-building-wrap" style="--brand:${brand};width:${s}px;height:${s}px" aria-hidden="true"><img class="vendor-building" src="${uri}" width="${s}" height="${s}" alt="" draggable="false" /></span>`;
}

function renderStatusBubble(state: WorkerSummary["state"], labelText: string): string {
  if (state === "working") {
    return `<span class="studio-bubble is-working" aria-label="${esc(labelText)}"><span class="studio-dot-spinner" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span>`;
  }
  if (state === "error") {
    return `<span class="studio-bubble is-error" aria-label="${esc(labelText)}"><span class="studio-bubble-err">!</span></span>`;
  }
  return `<span class="studio-bubble is-ok" aria-label="${esc(labelText)}"><span class="studio-bubble-ok">✓</span></span>`;
}

export function renderMiniOfficeSvg(
  workers: Array<Pick<WorkerSummary, "name" | "backend" | "model" | "role" | "state"> & { needs_handoff?: number }>,
  options: { empty?: boolean; compact?: boolean; animated?: boolean; statusTexts?: Record<string, string>; selectedName?: string | null } = {},
): string {
  if (options.empty || workers.length === 0) {
    return `<div class="studio-stage is-empty" role="region" aria-label="Studio Workspace">
      <img class="studio-backdrop" src="${STUDIO_BG_URI}" alt="Warm studio room" draggable="false" />
      <div class="studio-empty-pill">尚无在岗成员 · 等待分配席位</div>
    </div>`;
  }
  const people = workers.slice(0, 6);
  const count = people.length;
  const usedChars = new Set<StaffAvatarId>();
  const animated = options.animated !== false;
  const seats = people
    .map((w, idx) => {
      const brand = color(w.backend);
      let charId = pickStudioCharId({
        backend: String(w.backend),
        model: w.model,
        name: w.name,
        role: w.role,
      });
      if (usedChars.has(charId) && usedChars.size < STUDIO_CHAR_IDS.length) {
        const nextUnused = STUDIO_CHAR_IDS.find((candidate) => !usedChars.has(candidate));
        if (nextUnused) charId = nextUnused;
      }
      usedChars.add(charId);
      const gifOrStaticUri = animated
        ? (STUDIO_DESK_GIFS[charId] ?? STUDIO_DESK_STATIC_URIS[charId]!)
        : (STUDIO_DESK_STATIC_URIS[charId] ?? STUDIO_DESK_GIFS[charId]!);
      const stateLabel = options.statusTexts?.[w.name] ?? (w.state === "working" ? "执行中" : w.state === "error" ? "异常" : "待命");
      const activeCls = options.selectedName === w.name ? " is-selected" : "";
      const animCls = animated ? " is-animated" : "";
      return `<button type="button" class="studio-seat is-${esc(w.state)}${activeCls}${animCls}" style="--brand:${brand};--seat-idx:${idx}" data-action="studio-peek-worker" data-worker="${esc(w.name)}" title="@${esc(w.name)} · ${esc(w.backend)}">
        ${renderStatusBubble(w.state, stateLabel)}
        <span class="studio-desk-wrap"><img class="studio-desk-gif" src="${gifOrStaticUri}" alt="@${esc(w.name)}" draggable="false" /></span>
        <span class="studio-seat-name"><em></em><span>@${esc(w.name)}</span></span>
      </button>`;
    })
    .join("");
  return `<div class="studio-stage count-${count}" role="group" aria-label="Studio Office">
    <img class="studio-backdrop" src="${STUDIO_BG_URI}" alt="" aria-hidden="true" draggable="false" />
    <div class="studio-seats">${seats}</div>
  </div>`;
}
