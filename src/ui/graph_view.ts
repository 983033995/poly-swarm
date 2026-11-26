import type {
  DispatchGraph,
  DispatchGraphEdge,
  DispatchGraphNode,
  GraphEdgeKind,
} from "../shared/types.js";
import { BACKEND_COLORS } from "./avatars_3d.js";
import { getLanguage } from "./i18n.js";
import { esc } from "./markdown.js";
import { graphEdgeKindLabel, policyLayerShortLabel } from "./swarm_view_model.js";

export type GraphFilterMode = "all" | "actual" | "planned";

export interface PositionedGraphNode {
  node: DispatchGraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  colIndex: number;
}

export interface PositionedGraphEdge {
  edge: DispatchGraphEdge;
  path: string;
  labelX: number;
  labelY: number;
  markerId: string;
  strokeColor: string;
  isCrossLayer?: boolean;
  srcPort?: { x: number; y: number };
  dstPort?: { x: number; y: number };
}

export interface DispatchGraphLane {
  colIndex: number;
  x: number;
  w: number;
  layer: number;
  count: number;
  titleZh: string;
  titleEn: string;
}

export interface DispatchGraphLayout {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
  edges: PositionedGraphEdge[];
  lanes?: DispatchGraphLane[];
}

const NODE_W = 196;
const NODE_H = 82;
const COL_GAP = 92;
const ROW_GAP = 22;
const PAD_X = 28;
const PAD_Y = 64;
const PORT_MARGIN_Y = 20;
const BUS_TRACK_STEP = 14;
const LANE_HEADER_CLEARANCE = 48;

export const graphEventKey = (from: string, to: string, kind: GraphEdgeKind) =>
  JSON.stringify([from, to, kind]);

export function projectDispatchReplay(graph: DispatchGraph, count: number): DispatchGraph {
  const shown = graph.timeline.slice(0, Math.max(0, count));
  const byRoute = new Map<string, { last: typeof graph.timeline[number]; count: number }>();
  const seen = new Set(["coordinator"]);
  for (const event of shown) {
    seen.add(event.from_node);
    seen.add(event.to_node);
    const key = graphEventKey(event.from_node, event.to_node, event.kind);
    byRoute.set(key, { last: event, count: (byRoute.get(key)?.count ?? 0) + 1 });
  }
  return {
    ...graph,
    timeline: shown,
    nodes: graph.nodes.map((node) => ({
      ...node,
      state: seen.has(node.id) ? "active" : "planned",
      review_status: null,
      turns: undefined,
      total_tokens: undefined,
    })),
    edges: graph.edges.flatMap((edge) => {
      if (edge.mode !== "actual") return [];
      const record = byRoute.get(graphEventKey(edge.from, edge.to, edge.kind));
      if (!record) return [];
      return [
        {
          ...edge,
          count: record.count,
          seq: record.last.seq ?? null,
          label: record.last.label ?? undefined,
          created_at: record.last.created_at,
        },
      ];
    }),
  };
}

function clampLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

function estimateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0x7f ? 10.5 : 6.2;
  }
  return Math.ceil(width);
}

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

function edgeColorAndMarker(edge: DispatchGraphEdge): {
  stroke: string;
  markerId: string;
} {
  if (edge.mode === "planned") {
    return { stroke: "var(--tx-3)", markerId: "arrow-muted" };
  }
  switch (edge.kind) {
    case "review_pass":
    case "merge":
      return { stroke: "var(--ok)", markerId: "arrow-ok" };
    case "review_fail":
      return { stroke: "var(--err)", markerId: "arrow-err" };
    case "fallback":
    case "review":
      return { stroke: "var(--warn)", markerId: "arrow-warn" };
    case "depends_on":
    case "reports_to":
      return { stroke: "var(--tx-2)", markerId: "arrow-muted" };
    default:
      return { stroke: "var(--info)", markerId: "arrow-info" };
  }
}

function nodeStatusColor(state: DispatchGraphNode["state"]): string {
  switch (state) {
    case "working":
    case "running":
    case "active":
      return "var(--info)";
    case "waiting":
    case "completed":
    case "merged":
      return "var(--ok)";
    case "error":
    case "failed":
      return "var(--err)";
    case "stopped":
      return "var(--warn)";
    default:
      return "var(--tx-3)";
  }
}

function deriveLaneTitle(layer: number, group: DispatchGraphNode[]): { titleZh: string; titleEn: string } {
  if (layer === 0 || group.some((n) => n.kind === "coordinator" || n.kind === "user")) {
    return { titleZh: "调度核心", titleEn: "ORCHESTRATE" };
  }
  if (layer === 1) {
    return { titleZh: "架构调研", titleEn: "ARCHITECT" };
  }
  if (layer === 2) {
    return { titleZh: "研发执行", titleEn: "EXECUTE" };
  }
  if (layer === 3) {
    return { titleZh: "独立审校", titleEn: "VERIFY" };
  }
  if (layer >= 4 || group.some((n) => n.kind === "repo")) {
    return { titleZh: "主干合流", titleEn: "MERGE" };
  }
  return { titleZh: "协同执行", titleEn: "COLLABORATE" };
}

function filterGraphElements(
  graph: DispatchGraph,
  filterMode: GraphFilterMode,
): { nodes: DispatchGraphNode[]; edges: DispatchGraphEdge[] } {
  const edges =
    filterMode === "all"
      ? graph.edges
      : graph.edges.filter((e) => e.mode === filterMode);

  if (filterMode === "all") {
    return { nodes: graph.nodes, edges };
  }

  const endpointIds = new Set<string>();
  for (const e of edges) {
    endpointIds.add(e.from);
    endpointIds.add(e.to);
  }

  const nodes = graph.nodes.filter((n) => {
    if (filterMode === "actual") return !n.is_planned_only;
    return n.is_planned_only || endpointIds.has(n.id);
  });

  return { nodes, edges };
}

interface PortEntry {
  edgeId: string;
  peerCenterY: number;
  y: number;
}

function assignPortPositions(
  node: PositionedGraphNode,
  entries: PortEntry[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (entries.length === 0) return result;
  if (entries.length === 1) {
    result.set(entries[0]!.edgeId, node.y + node.h / 2);
    return result;
  }
  const sorted = [...entries].sort(
    (a, b) => a.peerCenterY - b.peerCenterY || a.edgeId.localeCompare(b.edgeId),
  );
  const minY = node.y + PORT_MARGIN_Y;
  const maxY = node.y + node.h - PORT_MARGIN_Y;
  const span = Math.max(0, maxY - minY);
  sorted.forEach((entry, index) => {
    const ratio = sorted.length > 1 ? index / (sorted.length - 1) : 0.5;
    result.set(entry.edgeId, minY + span * ratio);
  });
  return result;
}

export function layoutDispatchGraph(
  graph: DispatchGraph,
  filterMode: GraphFilterMode = "all",
): DispatchGraphLayout {
  const { nodes: rawNodes, edges: rawEdges } = filterGraphElements(graph, filterMode);

  if (rawNodes.length === 0) {
    return {
      width: 360,
      height: 120,
      nodes: [],
      edges: [],
      lanes: [],
    };
  }

  const layers = [...new Set(rawNodes.map((n) => n.layer))].sort((a, b) => a - b);
  const byLayer = new Map<number, DispatchGraphNode[]>();
  for (const l of layers) byLayer.set(l, []);
  for (const n of rawNodes) {
    byLayer.get(n.layer)!.push(n);
  }

  let maxRows = 1;
  for (const group of byLayer.values()) {
    if (group.length > maxRows) maxRows = group.length;
  }

  const contentHeight = maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  let totalHeight = Math.max(196, PAD_Y * 2 + contentHeight);
  const baseWidth = PAD_X * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * COL_GAP;
  let totalWidth = Math.max(420, baseWidth);

  const posMap = new Map<string, PositionedGraphNode>();
  const positionedNodes: PositionedGraphNode[] = [];
  const lanes: DispatchGraphLane[] = [];

  layers.forEach((layerVal, colIdx) => {
    const group = byLayer.get(layerVal)!;
    const colHeight = group.length * NODE_H + (group.length - 1) * ROW_GAP;
    const startY = PAD_Y + (contentHeight - colHeight) / 2;
    const x = PAD_X + colIdx * (NODE_W + COL_GAP);
    const { titleZh, titleEn } = deriveLaneTitle(layerVal, group);

    lanes.push({
      colIndex: colIdx,
      x,
      w: NODE_W,
      layer: layerVal,
      count: group.length,
      titleZh,
      titleEn,
    });

    group.forEach((node, rowIdx) => {
      const y = startY + rowIdx * (NODE_H + ROW_GAP);
      const item: PositionedGraphNode = {
        node,
        x,
        y,
        w: NODE_W,
        h: NODE_H,
        colIndex: colIdx,
      };
      positionedNodes.push(item);
      posMap.set(node.id, item);
    });
  });

  const validEdges = rawEdges.filter((e) => posMap.has(e.from) && posMap.has(e.to));

  // Distribute I/O anchor points on left & right sides per node
  const leftBuckets = new Map<string, PortEntry[]>();
  const rightBuckets = new Map<string, PortEntry[]>();
  for (const pn of positionedNodes) {
    leftBuckets.set(pn.node.id, []);
    rightBuckets.set(pn.node.id, []);
  }

  for (const edge of validEdges) {
    const src = posMap.get(edge.from)!;
    const dst = posMap.get(edge.to)!;
    if (src.node.id === dst.node.id) continue;
    const srcCenterY = src.y + src.h / 2;
    const dstCenterY = dst.y + dst.h / 2;
    if (src.colIndex === dst.colIndex) {
      rightBuckets.get(src.node.id)!.push({ edgeId: edge.id, peerCenterY: dstCenterY, y: srcCenterY });
      rightBuckets.get(dst.node.id)!.push({ edgeId: edge.id, peerCenterY: srcCenterY, y: dstCenterY });
    } else if (src.colIndex < dst.colIndex) {
      rightBuckets.get(src.node.id)!.push({ edgeId: edge.id, peerCenterY: dstCenterY, y: srcCenterY });
      leftBuckets.get(dst.node.id)!.push({ edgeId: edge.id, peerCenterY: srcCenterY, y: dstCenterY });
    } else {
      // Backward edge: exit from left side of src -> enter right side of dst
      leftBuckets.get(src.node.id)!.push({ edgeId: edge.id, peerCenterY: dstCenterY, y: srcCenterY });
      rightBuckets.get(dst.node.id)!.push({ edgeId: edge.id, peerCenterY: srcCenterY, y: dstCenterY });
    }
  }

  const leftPortMap = new Map<string, Map<string, number>>();
  const rightPortMap = new Map<string, Map<string, number>>();
  for (const pn of positionedNodes) {
    leftPortMap.set(pn.node.id, assignPortPositions(pn, leftBuckets.get(pn.node.id)!));
    rightPortMap.set(pn.node.id, assignPortPositions(pn, rightBuckets.get(pn.node.id)!));
  }

  // Track parallel/reverse edges between same undirected pair for clean curve separation
  const pairTotals = new Map<string, number>();
  for (const e of validEdges) {
    const k = e.from <= e.to ? `${e.from}::${e.to}` : `${e.to}::${e.from}`;
    pairTotals.set(k, (pairTotals.get(k) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  // Pre-detect cross-layer edges that intersect middle column nodes so we can reserve top/bottom bus tracks cleanly
  const canvasCenterY = PAD_Y + contentHeight / 2;
  const crossRoutes = new Map<string, { side: "top" | "bottom"; trackIdx: number }>();
  let topTrackCount = 0;
  let bottomTrackCount = 0;

  for (const edge of validEdges) {
    const src = posMap.get(edge.from)!;
    const dst = posMap.get(edge.to)!;
    if (Math.abs(dst.colIndex - src.colIndex) <= 1) continue;

    const minCol = Math.min(src.colIndex, dst.colIndex);
    const maxCol = Math.max(src.colIndex, dst.colIndex);
    const forward = src.colIndex < dst.colIndex;
    const x1 = forward ? src.x + src.w : src.x;
    const x2 = forward ? dst.x : dst.x + dst.w;
    const y1 = (forward ? rightPortMap.get(src.node.id)?.get(edge.id) : leftPortMap.get(src.node.id)?.get(edge.id)) ?? src.y + src.h / 2;
    const y2 = (forward ? leftPortMap.get(dst.node.id)?.get(edge.id) : rightPortMap.get(dst.node.id)?.get(edge.id)) ?? dst.y + dst.h / 2;

    let intersectsMiddle = false;
    for (const mid of positionedNodes) {
      if (mid.colIndex <= minCol || mid.colIndex >= maxCol) continue;
      const midCenterX = mid.x + mid.w / 2;
      const t = x2 !== x1 ? Math.max(0, Math.min(1, (midCenterX - x1) / (x2 - x1))) : 0.5;
      const lineY = y1 + (y2 - y1) * t;
      if (lineY >= mid.y - 12 && lineY <= mid.y + mid.h + 12) {
        intersectsMiddle = true;
        break;
      }
    }

    if (intersectsMiddle) {
      const side: "top" | "bottom" = (y1 + y2) / 2 <= canvasCenterY ? "top" : "bottom";
      const trackIdx = side === "top" ? topTrackCount++ : bottomTrackCount++;
      crossRoutes.set(edge.id, { side, trackIdx });
    }
  }

  // Shift nodes downward if top bus channels need extra headroom below the lane header
  let minNodeTop = Infinity;
  let maxNodeBottom = 0;
  for (const pn of positionedNodes) {
    if (pn.y < minNodeTop) minNodeTop = pn.y;
    if (pn.y + pn.h > maxNodeBottom) maxNodeBottom = pn.y + pn.h;
  }
  if (!Number.isFinite(minNodeTop)) minNodeTop = PAD_Y;

  const topBusClearance = topTrackCount > 0 ? 22 + (topTrackCount - 1) * BUS_TRACK_STEP + 14 : 0;
  const requiredTopY = LANE_HEADER_CLEARANCE + topBusClearance;
  const shiftY = Math.max(0, requiredTopY - minNodeTop);
  if (shiftY > 0) {
    for (const pn of positionedNodes) {
      pn.y += shiftY;
    }
    for (const map of [leftPortMap, rightPortMap]) {
      for (const edgeMap of map.values()) {
        for (const [edgeId, yVal] of edgeMap.entries()) {
          edgeMap.set(edgeId, yVal + shiftY);
        }
      }
    }
    minNodeTop += shiftY;
    maxNodeBottom += shiftY;
  }

  const bottomBusClearance = bottomTrackCount > 0 ? 22 + (bottomTrackCount - 1) * BUS_TRACK_STEP + 24 : 24;
  totalHeight = Math.max(totalHeight + shiftY, maxNodeBottom + bottomBusClearance + 16);

  const positionedEdges: PositionedGraphEdge[] = [];
  for (const edge of validEdges) {
    const src = posMap.get(edge.from)!;
    const dst = posMap.get(edge.to)!;

    const { stroke, markerId } = edgeColorAndMarker(edge);
    const pairKey = edge.from <= edge.to ? `${edge.from}::${edge.to}` : `${eName(edge.to)}::${eName(edge.from)}`;
    const totalForPair = pairTotals.get(edge.from <= edge.to ? `${edge.from}::${edge.to}` : `${edge.to}::${edge.from}`) ?? 1;
    const idxForPair = pairSeen.get(pairKey) ?? 0;
    pairSeen.set(pairKey, idxForPair + 1);
    const spread =
      totalForPair > 1
        ? (idxForPair - (totalForPair - 1) / 2) * Math.min(18, 52 / totalForPair)
        : 0;

    let pathStr = "";
    let labelX = 0;
    let labelY = 0;
    let srcPort: { x: number; y: number } | undefined;
    let dstPort: { x: number; y: number } | undefined;
    let isCrossLayer = false;

    if (src.node.id === dst.node.id) {
      // Self-loop on top-right corner
      const sx = src.x + src.w - 26;
      const sy = src.y;
      const ex = src.x + src.w;
      const ey = src.y + 20;
      srcPort = { x: sx, y: sy };
      dstPort = { x: ex, y: ey };
      pathStr = `M ${sx} ${sy} C ${sx + 4} ${sy - 28}, ${ex + 30} ${ey - 24}, ${ex} ${ey}`;
      labelX = ex + 14;
      labelY = sy - 16;
      totalWidth = Math.max(totalWidth, labelX + PAD_X + 32);
    } else if (src.colIndex === dst.colIndex) {
      // Same column vertical arc on right side
      const xEdge = src.x + src.w;
      const y1 = rightPortMap.get(src.node.id)?.get(edge.id) ?? src.y + src.h / 2;
      const y2 = rightPortMap.get(dst.node.id)?.get(edge.id) ?? dst.y + dst.h / 2;
      srcPort = { x: xEdge, y: y1 };
      dstPort = { x: xEdge, y: y2 };
      const bulge = 36 + Math.abs(spread);
      pathStr = `M ${xEdge} ${y1} C ${xEdge + bulge} ${y1}, ${xEdge + bulge} ${y2}, ${xEdge} ${y2}`;
      labelX = xEdge + bulge * 0.78;
      labelY = (y1 + y2) / 2;
      totalWidth = Math.max(totalWidth, labelX + PAD_X + 36);
    } else {
      const forward = src.colIndex < dst.colIndex;
      const x1 = forward ? src.x + src.w : src.x;
      const x2 = forward ? dst.x : dst.x + dst.w;
      const y1 =
        (forward
          ? rightPortMap.get(src.node.id)?.get(edge.id)
          : leftPortMap.get(src.node.id)?.get(edge.id)) ?? src.y + src.h / 2;
      const y2 =
        (forward
          ? leftPortMap.get(dst.node.id)?.get(edge.id)
          : rightPortMap.get(dst.node.id)?.get(edge.id)) ?? dst.y + dst.h / 2;

      srcPort = { x: x1, y: y1 };
      dstPort = { x: x2, y: y2 };

      const crossInfo = crossRoutes.get(edge.id);
      if (crossInfo) {
        isCrossLayer = true;
        const dir = forward ? 1 : -1;
        const trackY =
          crossInfo.side === "top"
            ? minNodeTop - 22 - crossInfo.trackIdx * BUS_TRACK_STEP
            : maxNodeBottom + 22 + crossInfo.trackIdx * BUS_TRACK_STEP;
        const midX = (x1 + x2) / 2;
        const entryStub = Math.min(48, Math.max(26, Math.abs(x2 - x1) * 0.16));
        const exitStub = entryStub;
        const shoulderX1 = x1 + dir * entryStub;
        const shoulderX2 = x2 - dir * exitStub;
        pathStr =
          `M ${x1.toFixed(1)} ${y1.toFixed(1)} ` +
          `C ${shoulderX1.toFixed(1)} ${y1.toFixed(1)}, ${shoulderX1.toFixed(1)} ${trackY.toFixed(1)}, ${midX.toFixed(1)} ${trackY.toFixed(1)} ` +
          `C ${shoulderX2.toFixed(1)} ${trackY.toFixed(1)}, ${shoulderX2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
        labelX = midX;
        labelY = trackY + (crossInfo.side === "top" ? -6 : 6);
      } else if (forward) {
        const dx = Math.max(32, (x2 - x1) * 0.46);
        const ctrlYOffset = spread * 0.45;
        pathStr = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${(y1 + ctrlYOffset).toFixed(1)}, ${(x2 - dx).toFixed(1)} ${(y2 + ctrlYOffset).toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
        labelX = (x1 + x2) / 2;
        labelY = (y1 + y2) / 2 + ctrlYOffset * 0.65 - 6;
      } else {
        const dx = Math.max(32, (x1 - x2) * 0.42);
        const arch = (y1 <= y2 ? -22 : 22) + spread;
        pathStr = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 - dx).toFixed(1)} ${(y1 + arch).toFixed(1)}, ${(x2 + dx).toFixed(1)} ${(y2 + arch).toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
        labelX = (x1 + x2) / 2;
        labelY = (y1 + y2) / 2 + arch * 0.68 - 5;
      }
    }

    positionedEdges.push({
      edge,
      path: pathStr,
      labelX,
      labelY,
      markerId,
      strokeColor: stroke,
      isCrossLayer,
      srcPort,
      dstPort,
    });
  }

  return {
    width: totalWidth,
    height: totalHeight,
    nodes: positionedNodes,
    edges: positionedEdges,
    lanes,
  };
}

function eName(id: string): string {
  return id;
}

function edgeTextBadge(edge: DispatchGraphEdge): string {
  const kindLabel = getLanguage() === "en" ? edge.kind.replaceAll("_", " ") : graphEdgeKindLabel(edge.kind);
  const countSuffix = edge.count > 1 ? ` ×${edge.count}` : "";
  const prefix = edge.mode === "planned" && getLanguage() !== "en" ? "规划·" : "";
  return `${prefix}${kindLabel}${countSuffix}`;
}

export function renderDispatchGraphSvg(
  graph: DispatchGraph,
  opts: {
    filterMode?: GraphFilterMode;
    selectedNodeId?: string | null;
    selectedEdgeId?: string | null;
    activeEdgeIds?: ReadonlySet<string>;
    pulseNodeIds?: ReadonlySet<string>;
    zoom?: number;
  } = {},
): string {
  const filterMode = opts.filterMode ?? "all";
  const en = getLanguage() === "en";
  const layout = layoutDispatchGraph(graph, filterMode);
  if (layout.nodes.length === 0) {
    return `<p class="graph-empty">${en ? "No nodes in this view." : "当前视图没有协同节点。"}</p>`;
  }

  const hasSelection = Boolean(opts.selectedNodeId || opts.selectedEdgeId);
  const relatedNodeIds = new Set<string>();
  const focusedEdgeIds = new Set<string>();
  if (opts.selectedNodeId) {
    relatedNodeIds.add(opts.selectedNodeId);
    for (const pe of layout.edges) {
      if (pe.edge.from === opts.selectedNodeId || pe.edge.to === opts.selectedNodeId) {
        relatedNodeIds.add(pe.edge.from);
        relatedNodeIds.add(pe.edge.to);
        focusedEdgeIds.add(pe.edge.id);
      }
    }
  } else if (opts.selectedEdgeId) {
    for (const pe of layout.edges) {
      if (pe.edge.id === opts.selectedEdgeId) {
        relatedNodeIds.add(pe.edge.from);
        relatedNodeIds.add(pe.edge.to);
        focusedEdgeIds.add(pe.edge.id);
        break;
      }
    }
  }

  const hasLeftPort = new Set<string>();
  const hasRightPort = new Set<string>();
  const nodeOutCount = new Map<string, number>();
  for (const pe of layout.edges) {
    nodeOutCount.set(pe.edge.from, (nodeOutCount.get(pe.edge.from) ?? 0) + 1);
    if (pe.srcPort) {
      const srcNode = layout.nodes.find((pn) => pn.node.id === pe.edge.from);
      if (srcNode && Math.abs(pe.srcPort.x - srcNode.x) < 2) hasLeftPort.add(srcNode.node.id);
      if (srcNode && Math.abs(pe.srcPort.x - (srcNode.x + srcNode.w)) < 2) hasRightPort.add(srcNode.node.id);
    }
    if (pe.dstPort) {
      const dstNode = layout.nodes.find((pn) => pn.node.id === pe.edge.to);
      if (dstNode && Math.abs(pe.dstPort.x - dstNode.x) < 2) hasLeftPort.add(dstNode.node.id);
      if (dstNode && Math.abs(pe.dstPort.x - (dstNode.x + dstNode.w)) < 2) hasRightPort.add(dstNode.node.id);
    }
  }

  const markerDefs = [
    { id: "arrow-info", color: "var(--info)" },
    { id: "arrow-ok", color: "var(--ok)" },
    { id: "arrow-warn", color: "var(--warn)" },
    { id: "arrow-err", color: "var(--err)" },
    { id: "arrow-muted", color: "var(--tx-2)" },
  ]
    .map(
      (m) =>
        `<marker id="${m.id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 1.4 L 9 5 L 0 8.6 L 2.2 5 z" fill="${m.color}" /></marker>`,
    )
    .join("");

  const defsHtml = `<defs>
    ${markerDefs}
    <linearGradient id="pg-card-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--graph-card-top)" />
      <stop offset="100%" stop-color="var(--graph-card-bot)" />
    </linearGradient>
    <linearGradient id="pg-card-coord-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--graph-card-coord-top)" />
      <stop offset="100%" stop-color="var(--graph-card-coord-bot)" />
    </linearGradient>
    <linearGradient id="pg-card-draft-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--graph-card-planned-top)" />
      <stop offset="100%" stop-color="var(--graph-card-planned-bot)" />
    </linearGradient>
    <linearGradient id="pg-lane-rail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="var(--info)" stop-opacity="0.55" />
      <stop offset="55%" stop-color="var(--info)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--info)" stop-opacity="0" />
    </linearGradient>
    <filter id="pg-glow" x="-16%" y="-16%" width="132%" height="132%">
      <feGaussianBlur stdDeviation="2.2" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>`;

  const edgesHtml = layout.edges
    .map((pe) => {
      const e = pe.edge;
      const isSelected = opts.selectedEdgeId === e.id;
      const isFocused = hasSelection ? focusedEdgeIds.has(e.id) : false;
      const isDim = hasSelection && !isFocused;
      const isActive = e.mode === "actual" && opts.activeEdgeIds?.has(e.id) === true;
      const plannedClass = e.mode === "planned" ? "is-planned " : "";
      const dash = e.mode === "planned" ? ` stroke-dasharray="5 4"` : "";
      const strokeWidth = isSelected ? 2.6 : isFocused ? 2.1 : 1.65;
      const label = clampLabel(edgeTextBadge(e), 16);
      const pillW = Math.max(48, estimateTextWidth(label) + 14);
      const showFlow = isFocused && !isActive && e.mode === "actual";

      return `<g class="graph-edge-group ${plannedClass}${isSelected ? "is-selected" : ""}${isActive ? " is-active" : ""}${isFocused ? " is-focused" : ""}${isDim ? " is-dim" : ""}" data-graph-edge="${esc(e.id)}"
        tabindex="0" role="button" aria-pressed="${isSelected}" aria-label="${esc(`${e.from} → ${e.to} · ${edgeTextBadge(e)}`)}">
        <title>${esc(`${e.from} → ${e.to} · ${edgeTextBadge(e)}`)}</title>
        <path class="graph-edge-hit" d="${pe.path}" fill="none" stroke="transparent" stroke-width="14" />
        <path class="graph-edge-halo" d="${pe.path}" fill="none" stroke="${pe.strokeColor}" />
        <path class="graph-edge-track" d="${pe.path}" fill="none" stroke="${pe.strokeColor}" stroke-width="${strokeWidth}"${dash} marker-end="url(#${pe.markerId})" />
        ${showFlow ? `<path class="graph-edge-flow" d="${pe.path}" fill="none" stroke="${pe.strokeColor}" />` : ""}
        ${isActive ? `<path class="graph-edge-pulse" d="${pe.path}" fill="none" stroke="${pe.strokeColor}" />` : ""}
        <g class="graph-edge-label${isSelected || isActive || isFocused ? " is-emphasized" : ""}">
          <rect x="${(pe.labelX - pillW / 2).toFixed(1)}" y="${(pe.labelY - 9.5).toFixed(1)}" width="${pillW}" height="19" rx="6" fill="var(--graph-pill-bg)" stroke="${isSelected || isFocused ? pe.strokeColor : "var(--bd-1)"}" stroke-width="1" />
          <text x="${pe.labelX.toFixed(1)}" y="${(pe.labelY + 3.5).toFixed(1)}" text-anchor="middle" class="graph-edge-text" fill="${pe.strokeColor}">${esc(label)}</text>
        </g>
      </g>`;
    })
    .join("");

  const nodesHtml = layout.nodes
    .map((pn) => {
      const n = pn.node;
      const isSelected = opts.selectedNodeId === n.id;
      const isDim = hasSelection && !relatedNodeIds.has(n.id);
      const statusColor = nodeStatusColor(n.state);
      const vendorColor =
        n.kind === "coordinator"
          ? "var(--accent-hi)"
          : n.kind === "repo"
            ? "var(--ok)"
            : (n.backend && BACKEND_COLORS[n.backend]) || statusColor;
      const borderColor = isSelected
        ? "var(--info)"
        : n.is_planned_only
          ? "var(--bd-info)"
          : n.review_status === "pass"
            ? "var(--bd-ok)"
            : n.review_status === "fail"
              ? "var(--bd-err)"
              : "var(--bd-1)";
      const dash = n.is_planned_only ? ` stroke-dasharray="4 3"` : "";
      const cardGradId = n.is_planned_only
        ? "pg-card-draft-bg"
        : n.kind === "coordinator"
          ? "pg-card-coord-bg"
          : "pg-card-bg";
      const nodeLabel = n.kind === "coordinator" ? (en ? "Coordinator" : "主会话") : n.label;
      const badgeText = n.is_planned_only
        ? en ? "Plan" : "规划"
        : n.review_status === "pass"
          ? en ? "Pass✓" : "审校✓"
          : n.review_status === "fail"
            ? en ? "Fail✕" : "打回✕"
            : n.review_status === "pending"
              ? en ? "Review" : "待审"
              : n.policy_source
                ? policyLayerShortLabel(n.policy_source)
                : "";
      const pillW = badgeText ? Math.max(34, estimateTextWidth(badgeText) + 12) : 0;
      const titleBudget = badgeText ? Math.max(11, Math.floor((pn.w - pillW - 44) / 7)) : 19;
      const titleText = clampLabel(nodeLabel, titleBudget);
      const subParts =
        n.kind === "coordinator"
          ? [en ? "Orchestrator" : "统筹调度", n.backend || ""].filter(Boolean)
          : [n.identity_id || n.role || n.kind, n.backend || ""].filter(Boolean);
      const subText = clampLabel(subParts.join(" · "), 24);

      const footerLeft =
        n.kind === "coordinator"
          ? en
            ? "Dispatch & merge"
            : "派发 · 决策"
          : n.model
            ? clampLabel(n.model, 17)
            : n.workspace_mode || "";
      const telemetryParts: string[] = [];
      if (n.kind === "coordinator") {
        const outCount = nodeOutCount.get(n.id) ?? 0;
        if (outCount > 0) telemetryParts.push(en ? `${outCount} links` : `${outCount} 路`);
      } else {
        if ((n.turns ?? 0) > 0) telemetryParts.push(en ? `${n.turns}t` : `${n.turns}轮`);
        if ((n.total_tokens ?? 0) > 0) telemetryParts.push(formatCompactTokens(n.total_tokens!));
      }
      const telemetryText = telemetryParts.join(" · ");

      const badgeColor =
        n.review_status === "pass"
          ? "var(--ok)"
          : n.review_status === "fail"
            ? "var(--err)"
            : n.is_planned_only
              ? "var(--tx-2)"
              : "var(--info)";

      const isActive = opts.pulseNodeIds?.has(n.id) === true;
      const plannedClass = n.is_planned_only ? "is-planned " : "";
      const portY = pn.y + pn.h / 2;

      return `<g class="graph-node-group ${plannedClass}${isSelected ? "is-selected" : ""}${isActive ? " is-active" : ""}${isDim ? " is-dim" : ""}" data-graph-node="${esc(n.id)}"
        tabindex="0" role="button" aria-pressed="${isSelected}" aria-label="${esc(nodeLabel)}">
        <title>${esc([nodeLabel, subText, n.model, telemetryText].filter(Boolean).join(" · "))}</title>
        <rect class="graph-node-card" x="${pn.x}" y="${pn.y}" width="${pn.w}" height="${pn.h}" rx="10" fill="url(#${cardGradId})" stroke="${borderColor}" stroke-width="${isSelected ? 2 : 1.2}"${dash} />
        <line class="graph-node-sheen" x1="${pn.x + 12}" y1="${pn.y + 1}" x2="${pn.x + pn.w - 12}" y2="${pn.y + 1}" />
        <rect class="graph-node-rail" x="${pn.x + 3.5}" y="${pn.y + 12}" width="3.5" height="${pn.h - 24}" rx="1.75" fill="${vendorColor}" />
        ${
          hasLeftPort.has(n.id)
            ? `<g class="graph-port" aria-hidden="true"><circle cx="${pn.x}" cy="${portY}" r="3.6" fill="var(--graph-port-bg)" stroke="var(--bd-1)" stroke-width="1.2" /><circle cx="${pn.x}" cy="${portY}" r="1.5" fill="${vendorColor}" /></g>`
            : ""
        }
        ${
          hasRightPort.has(n.id)
            ? `<g class="graph-port" aria-hidden="true"><circle cx="${pn.x + pn.w}" cy="${portY}" r="3.6" fill="var(--graph-port-bg)" stroke="var(--bd-1)" stroke-width="1.2" /><circle cx="${pn.x + pn.w}" cy="${portY}" r="1.5" fill="${vendorColor}" /></g>`
            : ""
        }
        ${isActive ? `<circle class="graph-node-ring" cx="${pn.x + 17}" cy="${pn.y + 20}" r="7.5" fill="none" stroke="${statusColor}" stroke-width="1.4" />` : ""}
        <circle class="graph-node-status" cx="${pn.x + 17}" cy="${pn.y + 20}" r="3.8" fill="${statusColor}" />
        <text x="${pn.x + 27}" y="${pn.y + 23.5}" class="graph-node-title">${esc(titleText)}</text>
        ${
          badgeText
            ? `<g class="graph-node-pill">
                <rect x="${pn.x + pn.w - pillW - 9}" y="${pn.y + 10.5}" width="${pillW}" height="17" rx="5" fill="var(--graph-pill-bg)" stroke="${badgeColor}" stroke-opacity="0.45" stroke-width="1" />
                <text x="${pn.x + pn.w - 9 - pillW / 2}" y="${pn.y + 22}" text-anchor="middle" class="graph-node-badge" fill="${badgeColor}">${esc(badgeText)}</text>
              </g>`
            : ""
        }
        <circle cx="${pn.x + 16}" cy="${pn.y + 39}" r="2.6" fill="${vendorColor}" opacity="0.88" />
        <text x="${pn.x + 23}" y="${pn.y + 42.5}" class="graph-node-sub">${esc(subText)}</text>
        <line class="graph-node-divider" x1="${pn.x + 12}" y1="${pn.y + 53}" x2="${pn.x + pn.w - 10}" y2="${pn.y + 53}" />
        ${
          footerLeft
            ? `<text x="${pn.x + 13}" y="${pn.y + 69}" class="graph-node-meta">${esc(footerLeft)}</text>`
            : ""
        }
        ${
          telemetryText
            ? `<text x="${pn.x + pn.w - 10}" y="${pn.y + 69}" text-anchor="end" class="graph-node-telemetry">${esc(telemetryText)}</text>`
            : ""
        }
      </g>`;
    })
    .join("");

  const lanes = layout.lanes ?? [];
  const layersHtml = lanes
    .map((lane, i) => {
      const lx = lane.x - 10;
      const lw = lane.w + 20;
      const laneTitle = `${String(i + 1).padStart(2, "0")} / ${en ? lane.titleEn : lane.titleZh}`;
      const countText = `×${lane.count}`;
      return `<g class="graph-lane">
        <rect x="${lx}" y="12" width="${lw}" height="${layout.height - 24}" rx="12" />
        <line x1="${lx + 10}" y1="12.5" x2="${lx + lw - 10}" y2="12.5" stroke="url(#pg-lane-rail)" stroke-width="1.5" />
        <text x="${lane.x + 2}" y="31" class="graph-lane-title">${esc(laneTitle)}</text>
        <rect x="${lane.x + lane.w - 22}" y="19" width="24" height="16" rx="5" class="graph-lane-count-bg" />
        <text x="${lane.x + lane.w - 10}" y="30.5" text-anchor="middle" class="graph-lane-count">${esc(countText)}</text>
      </g>`;
    })
    .join("");

  const zoom = opts.zoom && Number.isFinite(opts.zoom) && opts.zoom > 0 ? opts.zoom : 1;
  const scaledW = Math.round(layout.width * zoom);
  const scaledH = Math.round(layout.height * zoom);
  const classes = [
    "graph-svg",
    zoom === 1 && lanes.length <= 2 ? "is-compact" : "",
    zoom !== 1 ? "is-zoomed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<svg class="${classes}" viewBox="0 0 ${layout.width} ${layout.height}" width="${scaledW}" height="${scaledH}" role="group" aria-label="${en ? "Collaboration graph" : "协同脉络图"}">
    ${defsHtml}
    <g aria-hidden="true">${layersHtml}</g>
    <g class="graph-edges-layer">${edgesHtml}</g>
    <g class="graph-nodes-layer">${nodesHtml}</g>
  </svg>`;
}

export function edgeKindCssClass(kind: GraphEdgeKind): string {
  if (kind === "review_pass" || kind === "merge") return "badge-ok";
  if (kind === "review_fail") return "badge-err";
  if (kind === "fallback" || kind === "review") return "badge-warn";
  if (kind === "dispatch" || kind === "handoff") return "badge-info";
  return "";
}
