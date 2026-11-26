import fs from "node:fs";
import path from "node:path";
import { areRoleSkillPaths, MAX_ROLE_SKILLS, READONLY_BUILTIN_IDENTITY_IDS } from "../shared/role_skills.js";
import type {
  BackendId,
  BackendPolicyOverride,
  CapabilityTag,
  DispatchIdentityPatch,
  DispatchIdentitySpec,
  DispatchPolicyLayerConfig,
  FieldProvenance,
  PlannedGraphLink,
  PlannedGraphLinkKind,
  PolicyLayer,
  PolicyLayerStatus,
  PromptMergeMode,
  ResolvedBackendPolicy,
  ResolvedDispatchIdentity,
  ResolvedDispatchPolicy,
  WorkerPolicySnapshot,
  WorkerRole,
  WorkspaceMode,
} from "../shared/types.js";
import { REAL_BACKEND_IDS } from "./adapters/registry.js";
import {
  DEFAULT_ROUTES,
  roleToDefaultCapability,
  writeJsonAtomic,
  type PolySwarmConfig,
} from "./config.js";

export const LAYER_WEIGHTS: Record<PolicyLayer, number> = {
  builtin: 100,
  global_ui: 200,
  project: 300,
  session: 400,
  worker_explicit: 500,
};

export const LAYER_LABELS: Record<Exclude<PolicyLayer, "worker_explicit">, string> = {
  builtin: "全局默认 (内置)",
  global_ui: "主配置界面",
  project: "项目级规划",
  session: "会话级指定",
};

export function inferVendorFamily(backend: BackendId, model?: string | null): string {
  if (backend === "mock") return "mock";
  const id = model?.trim().toLowerCase().split("/").at(-1) || backend;
  if (/^(gpt-|o[134]|codex)/.test(id)) return "openai";
  if (id.startsWith("claude-")) return "anthropic";
  if (id === "agy" || id.startsWith("gemini-")) return "google";
  if (id === "grok" || id.startsWith("grok-")) return "xai";
  if (id.startsWith("deepseek-") || (backend === "qoder" && id === "dfmodel")) return "deepseek";
  if (/^(kimi-|moonshot-)/.test(id)) return "moonshot";
  if (/^(hy4|hunyuan)/.test(id)) return "tencent";
  if (id.startsWith("qwen")) return "alibaba";
  if (id.startsWith("glm")) return "zhipu";
  if (
    id === "trae" ||
    id.startsWith("trae-") ||
    id.startsWith("doubao-") ||
    id.startsWith("seed-") ||
    (backend === "trae" && id === "auto")
  ) {
    return "bytedance";
  }
  if (id.startsWith("minimax")) return "minimax";
  if (id === "mock") return "mock";
  return backend;
}

const ALL_KNOWN_BACKENDS: BackendId[] = [...REAL_BACKEND_IDS, "mock"];
const VALID_BACKENDS = new Set<string>(ALL_KNOWN_BACKENDS);
const VALID_CAPABILITIES = new Set<string>([
  "architect",
  "author",
  "verifier",
  "research",
  "enterprise",
  "fanout",
]);
const VALID_ROLES = new Set<string>(["author", "verifier", "researcher", "worker"]);
const VALID_WORKSPACE_MODES = new Set<string>(["inherit", "share", "branch"]);
const VALID_PROMPT_MODES = new Set<string>(["replace", "append"]);
const VALID_LINK_KINDS = new Set<string>([
  "dispatch",
  "review",
  "reports_to",
  "depends_on",
  "handoff",
]);

const IDENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_IDENTITY_IDS = new Set(["all", "coordinator", "watchdog", "user", "repo"]);
// L3/L4（项目级/会话级）策略不得把只读岗位降级为可写角色。
const READONLY_BUILTIN_IDENTITIES = new Set<string>(READONLY_BUILTIN_IDENTITY_IDS);

export const BUILTIN_IDENTITIES: Record<string, DispatchIdentitySpec> = {
  architect: {
    id: "architect",
    label: "架构设计师",
    description: "只读系统架构设计、模块边界规划、ADR 决策与方案评审",
    base_role: "researcher",
    capability: "architect",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是只读架构设计师，负责把模糊需求收敛为可验证的系统架构与模块边界，不实现任何代码。
【核心职责与方法】先用调用关系、数据流与不变量描述现状，再提出两到三套带权衡的候选方案；明确模块职责、接口契约、失败模式与回滚路径；以 ADR 记录决策上下文、备选方案与放弃理由；对高风险假设给出验证实验与可度量指标。
【边界禁令】严禁修改仓库文件、执行写命令或提交代码；不得越权替实现者拍板技术细节；缺少证据时不得编造依赖版本、性能数据或外部 API 行为；发现越权请求立即回报并拒绝。
【交付标准】输出固定为「现状事实 → 约束与不变量 → 候选方案对比 → 推荐方案与 ADR → 风险与验证计划」，结论应能被实现者直接拆解为任务。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "tech-lead": {
    id: "tech-lead",
    label: "技术负责人",
    description: "只读技术方向把控、任务拆分、质量门禁与合并顺序规划",
    base_role: "researcher",
    capability: "architect",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是只读技术负责人，对技术方向、任务拆分与质量门槛负责，通过评审与计划驱动团队，不直接写业务代码。
【核心职责与方法】把目标拆成可并行、所有权不重叠的任务，为每个任务定义输入、产出、依赖与验收标准；识别跨模块耦合与阻塞点，提前安排接口对齐；审查实现方案的一致性与可维护性，必要时退回重做；用风险清单跟踪配额、兼容性与回滚成本。
【边界禁令】禁止修改代码、配置或工作树；不得绕过跨厂商验证直接放行；不得以个人偏好替代项目既定规范；对不确定的进度与外部依赖不做虚假承诺。
【交付标准】交付「目标 → 任务分解表（负责人/依赖/验收）→ 关键决策与风险 → 合并顺序与门禁」四段，每个任务都能被独立派发与验收。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "product-analyst": {
    id: "product-analyst",
    label: "产品需求分析师",
    description: "只读需求澄清、用户故事、验收标准与非目标界定",
    base_role: "researcher",
    capability: "research",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是只读产品需求分析师，把用户诉求转译为边界清晰、可验收的需求，不参与实现。
【核心职责与方法】澄清目标用户、使用场景与成功指标；区分必须、应当与可选需求，显式列出非目标；用用户故事与 Given/When/Then 表达行为；挖掘隐含约束、异常路径与权限差异；识别需求冲突并向协调者提出取舍建议。
【边界禁令】禁止修改仓库或代写代码；不得虚构用户反馈、埋点数据或竞品事实；不得擅自扩大范围；无法确认的需求必须标注为待确认，而非自行假设。
【交付标准】输出「问题陈述 → 用户与场景 → 需求清单（含优先级与非目标）→ 验收标准 → 待确认问题」，可直接用于任务拆分与测试设计。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  researcher: {
    id: "researcher",
    label: "代码调研员",
    description: "只读代码库探索、证据定位、多源情报盘点与置信度标注",
    base_role: "researcher",
    capability: "research",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是只读源码与情报调研员，负责用可复现的证据回答“现状是什么”，不做任何修改。
【核心职责与方法】先给出检索范围与关键词，再逐条定位文件与行号；交叉验证多处引用，区分定义、调用与死代码；对外部资料注明来源与版本，区分事实与推测；维护证据到结论的映射，标注置信度与未覆盖区域。
【边界禁令】严禁写入文件、安装依赖或执行有副作用的命令；不得仅凭文件名或猜测下结论；不得把训练记忆当作仓库事实；遇到访问受限应如实报告而非绕过。
【交付标准】输出「问题 → 检索路径 → 证据（文件:行号）→ 结论与置信度 → 未决问题」，每条结论都可被他人按路径复核。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  verifier: {
    id: "verifier",
    label: "跨厂商代码审校官",
    description: "跨厂商只读独立代码审查、缺陷复现、测试验收与退回裁定",
    base_role: "verifier",
    capability: "verifier",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: true,
    system_prompt: `【角色定位】你是跨厂商只读代码审校官，独立于实现者对提交做对抗性审查，对阻断性问题拥有一票否决权。
【核心职责与方法】先核对改动范围与声明的交付是否一致；逐项检查正确性、边界条件、错误处理、并发与资源释放；验证测试是否真正覆盖风险而非仅通过；复现可疑缺陷并给出最小反例；区分阻断问题与建议项。
【边界禁令】严禁修改代码或替作者修复；不得在证据不足时放行；不得因同厂商或同会话来源降低标准；不得只做风格评论而遗漏语义缺陷。
【交付标准】结论必须是 [review_pass] 或 [review_fail]，附「阻断问题（含复现步骤与文件:行号）→ 建议项 → 已验证项 → 结论依据」，失败时写明退回条件。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "sec-auditor": {
    id: "sec-auditor",
    label: "安全与红队审计官",
    description: "只读安全审计、越权与注入红队推演、供应链与凭据风险检查",
    base_role: "verifier",
    capability: "verifier",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: true,
    system_prompt: `【角色定位】你是只读安全与红队审计官，从攻击者视角寻找越权、注入、泄密与供应链风险。
【核心职责与方法】枚举信任边界与数据流，检查输入校验、路径穿越、命令注入、SSRF 与反序列化；审查凭据、日志与错误信息是否泄露敏感数据；核对依赖来源与权限最小化；为每个假设构造可执行攻击场景并评估影响。
【边界禁令】严禁攻击外部系统、写入文件或植入后门；不得提供可直接滥用的利用代码；不得以“只是理论风险”淡化已验证问题；发现真实密钥只能报告位置，不得回显内容。
【交付标准】输出「资产与信任边界 → 风险清单（等级/触发条件/影响/证据）→ 最小复现 → 修复建议 → 残留风险」，按严重度排序。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "perf-reviewer": {
    id: "perf-reviewer",
    label: "性能与并发评审专家",
    description: "只读性能瓶颈定位、并发与竞态审查、以基准数据驱动优化排序",
    base_role: "verifier",
    capability: "verifier",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: true,
    system_prompt: `【角色定位】你是只读性能与并发评审专家，专注吞吐、延迟、内存与竞态，不重写实现。
【核心职责与方法】识别热路径与算法复杂度，检查 N+1 查询、无界缓存、频繁分配与阻塞调用；审查锁粒度、竞态条件、背压与超时；要求以基准数据支撑结论，严格区分实测与估算；给出可度量的优化优先级。
【边界禁令】禁止修改代码或擅自跑压测冲击共享环境；不得用未标注的猜测数字冒充测量结果；不得以微优化掩盖架构级瓶颈；缺少基线时应先要求补测。
【交付标准】输出「场景与基线 → 瓶颈定位（文件:行号与证据）→ 影响量化 → 优化建议与收益预估 → 回归验证方法」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "qa-challenger": {
    id: "qa-challenger",
    label: "QA 验收与反例挑战官",
    description: "只读验收反推、边界与反例构造、失败证据驱动的放行或阻断",
    base_role: "verifier",
    capability: "verifier",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: true,
    system_prompt: `【角色定位】你是只读 QA 验收与反例挑战官，任务是证明交付“不成立”，而不是帮忙通过。
【核心职责与方法】从验收标准反推测试矩阵，覆盖正常、边界、异常与权限路径；主动构造反例、竞态与幂等性场景；检查测试是否可重复、是否依赖顺序或外部状态；对“已通过”的结论追问证据与覆盖面。
【边界禁令】严禁修改被测代码或测试来迁就实现；不得用一次手动成功替代可复现验证；不得把已知失败标记为偶发而不追根因；不得越权放宽验收标准。
【交付标准】输出「验收标准 → 测试矩阵 → 已执行用例与结果 → 反例与失败证据 → 放行或阻断结论」，阻断须给出最小复现。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  author: {
    id: "author",
    label: "全栈核心开发",
    description: "独立 git worktree 隔离写实现、补充测试、自检与原子提交",
    base_role: "author",
    capability: "author",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是全栈核心开发，在独立 git worktree 中实现已确认的需求，对正确性与可维护性负责。
【核心职责与方法】先读相关代码与约定再动手；遵循现有架构与命名，最小化改动面；为新增行为补充针对性测试；保持提交原子化并写清动机；自查边界条件、错误处理与兼容性，交付前跑通类型检查与测试。
【边界禁令】严禁改动他人负责的文件或越界重构；不得提交密钥、调试日志或生成物；不得用禁用检查、跳过测试的方式“变绿”；遇到需求歧义先回报而非自行扩展范围。
【交付标准】交付「改动摘要 → 关键设计与取舍 → 测试与验证命令及结果 → 已知限制 → 需要评审关注点」，保证可被独立审校与合并。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "backend-author": {
    id: "backend-author",
    label: "后端与分布式工程师",
    description: "隔离写服务端逻辑、接口契约、数据一致性与并发安全",
    base_role: "author",
    capability: "author",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是后端与分布式工程师，负责服务端逻辑、接口契约、数据一致性与并发安全。
【核心职责与方法】先明确接口输入输出与错误语义，再实现幂等、重试与超时；关注事务边界、竞态、死锁与资源释放；对跨服务调用设计降级与补偿；用集成测试覆盖故障路径；日志结构化输出且不泄露敏感信息。
【边界禁令】严禁修改前端与他人模块；不得引入未评审的重依赖或擅自变更公共契约；不得以吞异常掩盖失败；禁止在生产路径写入明文密钥或冗余日志。
【交付标准】交付「接口契约 → 数据与一致性设计 → 异常与降级策略 → 测试覆盖（含故障注入）→ 可观测性说明」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "frontend-author": {
    id: "frontend-author",
    label: "前端与交互工程师",
    description: "隔离写界面实现、状态管理、转义安全与可访问性保障",
    base_role: "author",
    capability: "author",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是前端与交互工程师，负责界面实现、状态管理与可访问性，保证体验一致且安全。
【核心职责与方法】先对齐设计意图与现有组件规范，再实现最小可用交互；严格管理加载、空态、错误与边界状态；所有动态内容渲染前转义以避免注入；保证键盘可达与响应式布局；为关键交互补充测试。
【边界禁令】严禁修改服务端契约或越界改动他人组件；不得引入外链资源破坏单文件约束；不得用 innerHTML 拼接未转义数据；不得为赶进度牺牲可访问性。
【交付标准】交付「交互与状态图 → 组件改动 → 安全与可访问性检查 → 视觉与行为验证 → 已知限制」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "refactor-specialist": {
    id: "refactor-specialist",
    label: "重构与代码整洁专家",
    description: "隔离写小步重构、消除重复与耦合，以测试证明行为不变",
    base_role: "author",
    capability: "author",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是重构与代码整洁专家，在不改变外部行为的前提下降低复杂度与耦合。
【核心职责与方法】先建立行为基线（测试与调用点）再重构；小步提交，每步可独立验证；消除重复、收紧类型、拆分过长函数、明确模块边界；保留必要的兼容层并标注移除条件；拒绝为抽象而抽象。
【边界禁令】严禁在重构中夹带功能变更；不得删除无测试覆盖的可疑代码而不先确认调用方；不得大范围改写导致评审不可读；不得改动公共 API 语义。
【交付标准】交付「重构动机 → 行为不变性证据 → 分步改动清单 → 复杂度与重复度改善 → 回归测试结果」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "test-engineer": {
    id: "test-engineer",
    label: "测试开发工程师 SDET",
    description: "隔离写自动化测试体系、夹具治理、缺陷回归与稳定性保障",
    base_role: "author",
    capability: "author",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是测试开发工程师（SDET），负责构建可靠、快速、可维护的自动化测试体系。
【核心职责与方法】按风险分层设计单元、集成与端到端测试；用夹具与工厂消除脆弱依赖；确保测试隔离、可重复且无外部付费调用；为每个缺陷补充回归用例；度量覆盖率缺口而非追求数字。
【边界禁令】严禁修改业务代码来迁就测试；不得用 sleep、随机或真实网络制造不稳定；不得提交被跳过的测试充数；不得触碰生产凭据或外部计费接口。
【交付标准】交付「测试策略与分层 → 新增或修改用例 → 覆盖的风险点 → 运行命令与耗时 → 未覆盖项与后续计划」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "devops-sre": {
    id: "devops-sre",
    label: "构建与基础设施工程师",
    description: "隔离写可重复构建、部署流水线、回滚与运行可靠性保障",
    base_role: "author",
    capability: "enterprise",
    workspace_mode: "share",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是构建与基础设施工程师，负责可重复构建、部署流水线与运行可靠性。
【核心职责与方法】保证构建确定性：锁定依赖、固定工具版本、最小权限；设计健康检查、回滚与灰度策略；审查配置与密钥注入路径；用脚本自动化重复操作并加防护（幂等、dry-run、失败即停）。
【边界禁令】严禁在未授权环境执行变更或删除资源；不得把密钥写入仓库或日志；不得跳过校验直接强推；不得修改他人负责的应用代码。
【交付标准】交付「变更目标 → 影响面与回滚方案 → 脚本或配置改动 → 验证与演练结果 → 监控与告警项」。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  "enterprise-worker": {
    id: "enterprise-worker",
    label: "企业规范与文档专员",
    description: "协同执行企业规范对齐、变更说明、操作手册与文档一致性核对",
    base_role: "worker",
    capability: "enterprise",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是企业规范与文档专员，负责把工程产出对齐组织标准并沉淀为可复用文档。
【核心职责与方法】先确认适用的规范、命名与合规模板；把变更整理为清晰的说明、变更记录与操作手册；统一术语与格式，补全前置条件与回滚步骤；交叉核对文档与实现的一致性。
【边界禁令】严禁修改代码逻辑或替他人做技术决策；不得编造未经验证的流程与合规结论；不得泄露内部敏感信息；文档与实现冲突时应报告而非静默改写。
【交付标准】交付「规范依据 → 文档结构 → 关键说明与示例 → 一致性核对结果 → 待补全项」，确保新成员可依文档独立操作。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
  worker: {
    id: "worker",
    label: "高并发扇出执行员",
    description: "协同执行单任务边界内扇出、最小改动、自检与如实汇报",
    base_role: "worker",
    capability: "fanout",
    workspace_mode: "inherit",
    auto_fallback: true,
    require_cross_vendor: false,
    system_prompt: `【角色定位】你是高并发扇出执行员，在明确边界内独立完成被指派的单一子任务。
【核心职责与方法】严格按简报的范围、文件所有权与验收标准执行；先确认输入与依赖再开始；保持改动最小、可回滚；完成后自检并如实汇报进度、阻塞与偏差。
【边界禁令】严禁越界修改非我方文件或擅自扩大任务；不得重复他人已声明的工作；遇到歧义或冲突立即上报而非自行猜测；不得伪造完成状态。
【交付标准】交付「任务与范围 → 实际改动 → 验证结果 → 阻塞与风险 → 下一步建议」，以 [done] 或 [blocked] 标签回报。`,
    prompt_mode: "replace",
    enabled: true,
    weight: LAYER_WEIGHTS.builtin,
  },
};

export function validateIdentityId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!IDENTITY_ID_RE.test(normalized)) {
    throw new Error(
      `Invalid identity ID '${id}'. Must match /^[a-z0-9][a-z0-9_-]{0,31}$/.`,
    );
  }
  if (RESERVED_IDENTITY_IDS.has(normalized) || normalized.startsWith("coordinator-")) {
    throw new Error(`Identity ID '${normalized}' is reserved.`);
  }
  return normalized;
}

function isInsideDir(parentDir: string, candidatePath: string): boolean {
  const parent = path.resolve(parentDir);
  const child = path.resolve(candidatePath);
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function resolveProjectConfigPaths(repoRoot: string): {
  readPath: string | null;
  writePath: string;
  legacyPath: string;
} {
  const root = path.resolve(repoRoot);
  const primary = path.join(root, ".poly-swarm", "config.json");
  const legacy = path.join(root, ".poly-swarm.json");
  if (!isInsideDir(root, primary) || !isInsideDir(root, legacy)) {
    throw new Error(`Invalid repository root path '${repoRoot}'.`);
  }
  if (fs.existsSync(primary)) {
    return { readPath: primary, writePath: primary, legacyPath: legacy };
  }
  if (fs.existsSync(legacy)) {
    return { readPath: legacy, writePath: primary, legacyPath: legacy };
  }
  return { readPath: null, writePath: primary, legacyPath: legacy };
}

function sanitizeIdentityPatch(
  raw: unknown,
  id: string,
  layerLabel: string,
  warnings: string[],
): DispatchIdentityPatch | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`[${layerLabel}] 身份 '${id}' 配置格式无效，已忽略。`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const out: DispatchIdentityPatch = {};

  if (obj.label === null) out.label = null;
  else if (typeof obj.label === "string") out.label = obj.label.trim().slice(0, 80);

  if (obj.description === null) out.description = null;
  else if (typeof obj.description === "string") out.description = obj.description.trim().slice(0, 240);

  if (obj.base_role === null) out.base_role = null;
  else if (typeof obj.base_role === "string") {
    if (VALID_ROLES.has(obj.base_role)) {
      out.base_role = obj.base_role as WorkerRole;
    } else {
      warnings.push(`[${layerLabel}] 身份 '${id}' 的 base_role '${obj.base_role}' 非法，已忽略。`);
    }
  }

  if (obj.capability === null) out.capability = null;
  else if (typeof obj.capability === "string") {
    if (VALID_CAPABILITIES.has(obj.capability)) {
      out.capability = obj.capability as CapabilityTag;
    } else {
      warnings.push(`[${layerLabel}] 身份 '${id}' 的 capability '${obj.capability}' 非法，已忽略。`);
    }
  }

  if (obj.preferred_backends === null) out.preferred_backends = null;
  else if (Array.isArray(obj.preferred_backends)) {
    const validList = [
      ...new Set(
        obj.preferred_backends.filter(
          (b): b is BackendId => typeof b === "string" && VALID_BACKENDS.has(b),
        ),
      ),
    ];
    out.preferred_backends = validList;
  }

  if (obj.model === null) out.model = null;
  else if (typeof obj.model === "string") {
    const trimmed = obj.model.trim();
    out.model = trimmed || null;
  }

  if (obj.effort === null) out.effort = null;
  else if (typeof obj.effort === "string") {
    const trimmed = obj.effort.trim();
    out.effort = trimmed || null;
  }

  if (obj.workspace_mode === null) out.workspace_mode = null;
  else if (typeof obj.workspace_mode === "string") {
    if (VALID_WORKSPACE_MODES.has(obj.workspace_mode)) {
      out.workspace_mode = obj.workspace_mode as WorkspaceMode;
    } else {
      warnings.push(
        `[${layerLabel}] 身份 '${id}' 的 workspace_mode '${obj.workspace_mode}' 非法，已忽略。`,
      );
    }
  }

  if (obj.auto_fallback === null) out.auto_fallback = null;
  else if (typeof obj.auto_fallback === "boolean") out.auto_fallback = obj.auto_fallback;

  if (obj.require_cross_vendor === null) out.require_cross_vendor = null;
  else if (typeof obj.require_cross_vendor === "boolean") {
    out.require_cross_vendor = obj.require_cross_vendor;
  }

  if (obj.reports_to === null) out.reports_to = null;
  else if (typeof obj.reports_to === "string") {
    const trimmed = obj.reports_to.trim().toLowerCase();
    out.reports_to = trimmed || null;
  }

  if (obj.review_by === null) out.review_by = null;
  else if (typeof obj.review_by === "string") {
    const trimmed = obj.review_by.trim().toLowerCase();
    out.review_by = trimmed || null;
  }

  if (obj.system_prompt === null) out.system_prompt = null;
  else if (typeof obj.system_prompt === "string") {
    out.system_prompt = obj.system_prompt.slice(0, 8000);
  }

  if (obj.skill_paths === null) out.skill_paths = null;
  else if (obj.skill_paths !== undefined) {
    if (areRoleSkillPaths(obj.skill_paths)) {
      out.skill_paths = [...new Set(obj.skill_paths)];
    } else {
      warnings.push(`[${layerLabel}] 身份 '${id}' 的 skill_paths 必须是最多 ${MAX_ROLE_SKILLS} 条工作区相对 SKILL.md 路径，已忽略此项。`);
    }
  }

  if (obj.prompt_mode === null) out.prompt_mode = null;
  else if (typeof obj.prompt_mode === "string" && VALID_PROMPT_MODES.has(obj.prompt_mode)) {
    out.prompt_mode = obj.prompt_mode as PromptMergeMode;
  }

  if (obj.enabled === null) out.enabled = null;
  else if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;

  if (obj.weight === null) out.weight = null;
  else if (typeof obj.weight === "number" && Number.isFinite(obj.weight)) {
    out.weight = Math.floor(obj.weight);
  }

  return out;
}

export function sanitizePolicyLayer(
  raw: unknown,
  opts: { layer: "global_ui" | "project" | "session" },
): { policy: DispatchPolicyLayerConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === null || raw === undefined) {
    return { policy: {}, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`[${opts.layer}] 策略配置必须是 JSON 对象，已忽略。`);
    return { policy: {}, warnings };
  }

  const obj = raw as Record<string, unknown>;
  const policy: DispatchPolicyLayerConfig = {};

  if (obj.routes && typeof obj.routes === "object" && !Array.isArray(obj.routes)) {
    const routesOut: Partial<Record<CapabilityTag, BackendId[] | null>> = {};
    for (const [cap, list] of Object.entries(obj.routes as Record<string, unknown>)) {
      if (!VALID_CAPABILITIES.has(cap)) continue;
      if (list === null) {
        routesOut[cap as CapabilityTag] = null;
        continue;
      }
      if (!Array.isArray(list)) continue;
      const clean = [
        ...new Set(
          list.filter((b): b is BackendId => typeof b === "string" && VALID_BACKENDS.has(b)),
        ),
      ];
      if (clean.length > 0) {
        routesOut[cap as CapabilityTag] = clean;
      }
    }
    if (Object.keys(routesOut).length > 0) {
      policy.routes = routesOut;
    }
  }

  if (obj.backends && typeof obj.backends === "object" && !Array.isArray(obj.backends)) {
    const backendsOut: Partial<Record<BackendId, BackendPolicyOverride | null>> = {};
    for (const [bKey, bVal] of Object.entries(obj.backends as Record<string, unknown>)) {
      if (!VALID_BACKENDS.has(bKey)) continue;
      if (bVal === null) {
        backendsOut[bKey as BackendId] = null;
        continue;
      }
      if (!bVal || typeof bVal !== "object" || Array.isArray(bVal)) continue;
      const bObj = bVal as Record<string, unknown>;
      if (
        (opts.layer === "project" || opts.layer === "session") &&
        ("command" in bObj || "extraArgs" in bObj || "env" in bObj)
      ) {
        warnings.push(
          `安全拦截 [${opts.layer}]：后端 '${bKey}' 不允许覆写 command/extraArgs/env，已自动剥离。`,
        );
      }
      const entry: BackendPolicyOverride = {};
      if (bObj.enabled === null) entry.enabled = null;
      else if (typeof bObj.enabled === "boolean") entry.enabled = bObj.enabled;

      if (bObj.defaultModel === null) entry.defaultModel = null;
      else if (typeof bObj.defaultModel === "string") {
        entry.defaultModel = bObj.defaultModel.trim() || null;
      }

      if (bObj.defaultEffort === null) entry.defaultEffort = null;
      else if (typeof bObj.defaultEffort === "string") {
        entry.defaultEffort = bObj.defaultEffort.trim() || null;
      }

      if (Object.keys(entry).length > 0) {
        backendsOut[bKey as BackendId] = entry;
      }
    }
    if (Object.keys(backendsOut).length > 0) {
      policy.backends = backendsOut;
    }
  }

  if (obj.identities && typeof obj.identities === "object" && !Array.isArray(obj.identities)) {
    const idsOut: Record<string, DispatchIdentityPatch | null> = {};
    for (const [rawId, patchVal] of Object.entries(obj.identities as Record<string, unknown>)) {
      let cleanId: string;
      try {
        cleanId = validateIdentityId(rawId);
      } catch (err) {
        warnings.push(
          `[${opts.layer}] 非法身份 ID '${rawId}' 已忽略：${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (patchVal === null) {
        idsOut[cleanId] = null;
        continue;
      }
      const sanitized = sanitizeIdentityPatch(patchVal, cleanId, opts.layer, warnings);
      if (sanitized) {
        idsOut[cleanId] = sanitized;
      }
    }
    if (Object.keys(idsOut).length > 0) {
      policy.identities = idsOut;
    }
  }

  if (Array.isArray(obj.topology)) {
    const linksOut: PlannedGraphLink[] = [];
    for (const item of obj.topology) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const link = item as Record<string, unknown>;
      const from = typeof link.from === "string" ? link.from.trim().toLowerCase() : "";
      const to = typeof link.to === "string" ? link.to.trim().toLowerCase() : "";
      const kind = typeof link.kind === "string" ? link.kind.trim() : "";
      if (!from || !to || !VALID_LINK_KINDS.has(kind)) {
        warnings.push(`[${opts.layer}] 无效拓扑边定义，已忽略。`);
        continue;
      }
      const label =
        typeof link.label === "string" && link.label.trim()
          ? link.label.trim().slice(0, 80)
          : undefined;
      linksOut.push({
        from,
        to,
        kind: kind as PlannedGraphLinkKind,
        ...(label ? { label } : {}),
      });
    }
    if (obj.topology.length === 0 || linksOut.length > 0) {
      policy.topology = linksOut;
    }
  }

  return { policy, warnings };
}

export function loadProjectPolicy(repoRoot: string): {
  path: string | null;
  policy: DispatchPolicyLayerConfig | null;
  warnings: string[];
} {
  if (!repoRoot || !repoRoot.trim()) {
    return { path: null, policy: null, warnings: [] };
  }
  try {
    const { readPath } = resolveProjectConfigPaths(repoRoot);
    if (!readPath || !fs.existsSync(readPath)) {
      return { path: null, policy: null, warnings: [] };
    }
    const rawText = fs.readFileSync(readPath, "utf8");
    const parsed = JSON.parse(rawText) as unknown;
    const { policy, warnings } = sanitizePolicyLayer(parsed, { layer: "project" });
    return { path: readPath, policy, warnings };
  } catch (err) {
    return {
      path: null,
      policy: null,
      warnings: [
        `读取项目级配置失败 (${repoRoot}): ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

export function hasPolicyOverrides(policy: DispatchPolicyLayerConfig | null | undefined): boolean {
  if (!policy) return false;
  if (policy.routes && Object.keys(policy.routes).length > 0) return true;
  if (policy.backends && Object.keys(policy.backends).length > 0) return true;
  if (policy.identities && Object.keys(policy.identities).length > 0) return true;
  if (policy.topology && policy.topology.length > 0) return true;
  return false;
}

export function countPolicyOverrides(policy: DispatchPolicyLayerConfig | null | undefined): number {
  if (!policy) return 0;
  let count = 0;
  if (policy.routes) count += Object.keys(policy.routes).length;
  if (policy.backends) count += Object.keys(policy.backends).length;
  if (policy.identities) count += Object.keys(policy.identities).length;
  if (policy.topology) count += policy.topology.length;
  return count;
}

export function saveProjectPolicy(
  repoRoot: string,
  policy: DispatchPolicyLayerConfig | null,
): string {
  const { writePath, legacyPath } = resolveProjectConfigPaths(repoRoot);
  const clearProjectFiles = () => {
    if (fs.existsSync(writePath)) {
      fs.rmSync(writePath, { force: true });
    }
    if (fs.existsSync(legacyPath)) {
      fs.rmSync(legacyPath, { force: true });
    }
  };
  if (policy === null || !hasPolicyOverrides(policy)) {
    clearProjectFiles();
    return writePath;
  }
  const { policy: clean } = sanitizePolicyLayer(policy, { layer: "project" });
  if (!hasPolicyOverrides(clean)) {
    clearProjectFiles();
    return writePath;
  }
  writeJsonAtomic(writePath, clean, 0o644);
  return writePath;
}

export function mergePolicyLayerPatch(
  existing: DispatchPolicyLayerConfig | null | undefined,
  patch: DispatchPolicyLayerConfig | null | undefined,
): DispatchPolicyLayerConfig {
  if (patch === null) return {};
  const next: DispatchPolicyLayerConfig = structuredClone(existing ?? {});
  if (!patch) return next;

  if (patch.routes !== undefined) {
    const routes = { ...(next.routes ?? {}) };
    for (const [cap, arr] of Object.entries(patch.routes)) {
      if (arr === null || (Array.isArray(arr) && arr.length === 0)) {
        delete routes[cap as CapabilityTag];
      } else if (Array.isArray(arr)) {
        routes[cap as CapabilityTag] = [...arr];
      }
    }
    if (Object.keys(routes).length > 0) next.routes = routes;
    else delete next.routes;
  }

  if (patch.backends !== undefined) {
    const backends = { ...(next.backends ?? {}) };
    for (const [bKey, bPatch] of Object.entries(patch.backends)) {
      if (bPatch === null) {
        delete backends[bKey as BackendId];
        continue;
      }
      if (!bPatch || typeof bPatch !== "object") continue;
      const cur = { ...(backends[bKey as BackendId] ?? {}) };
      if (bPatch.enabled !== undefined) {
        if (bPatch.enabled === null) delete cur.enabled;
        else cur.enabled = bPatch.enabled;
      }
      if (bPatch.defaultModel !== undefined) {
        if (bPatch.defaultModel === null) cur.defaultModel = null;
        else cur.defaultModel = bPatch.defaultModel;
      }
      if (bPatch.defaultEffort !== undefined) {
        if (bPatch.defaultEffort === null) cur.defaultEffort = null;
        else cur.defaultEffort = bPatch.defaultEffort;
      }
      if (Object.keys(cur).length > 0) {
        backends[bKey as BackendId] = cur;
      } else {
        delete backends[bKey as BackendId];
      }
    }
    if (Object.keys(backends).length > 0) next.backends = backends;
    else delete next.backends;
  }

  if (patch.identities !== undefined) {
    const identities = { ...(next.identities ?? {}) };
    for (const [id, ipatch] of Object.entries(patch.identities)) {
      if (ipatch === null) {
        delete identities[id];
        continue;
      }
      if (!ipatch || typeof ipatch !== "object") continue;
      const prev = identities[id];
      const merged: DispatchIdentityPatch = {
        ...(prev && typeof prev === "object" ? prev : {}),
        ...ipatch,
      };
      identities[id] = merged;
    }
    if (Object.keys(identities).length > 0) next.identities = identities;
    else delete next.identities;
  }

  if (patch.topology !== undefined) {
    if (patch.topology.length > 0) {
      next.topology = structuredClone(patch.topology);
    } else {
      delete next.topology;
    }
  }

  return next;
}

export function buildEffectiveGlobalUiLayer(config: PolySwarmConfig): DispatchPolicyLayerConfig {
  const raw = config.globalUiRaw;
  const out: DispatchPolicyLayerConfig = {};

  // Routes: take explicit raw routes, plus any programmatic in-memory route diff from DEFAULT_ROUTES
  const routes: Partial<Record<CapabilityTag, BackendId[]>> = {};
  if (raw?.routes) {
    for (const [k, v] of Object.entries(raw.routes)) {
      if (Array.isArray(v) && v.length > 0) routes[k as CapabilityTag] = [...v];
    }
  }
  for (const cap of Object.keys(DEFAULT_ROUTES) as CapabilityTag[]) {
    if (!routes[cap]) {
      const current = config.routes[cap];
      if (
        Array.isArray(current) &&
        current.length > 0 &&
        JSON.stringify(current) !== JSON.stringify(DEFAULT_ROUTES[cap])
      ) {
        routes[cap] = [...current];
      }
    }
  }
  if (Object.keys(routes).length > 0) out.routes = routes;

  // Backends: combine raw backends + in-memory config.backends
  const backends: Partial<Record<BackendId, BackendPolicyOverride>> = {};
  const allKeys = new Set<string>([
    ...Object.keys(raw?.backends ?? {}),
    ...Object.keys(config.backends ?? {}),
  ]);
  for (const bKey of allKeys) {
    if (!VALID_BACKENDS.has(bKey)) continue;
    const r = raw?.backends?.[bKey as BackendId];
    const c = config.backends[bKey as BackendId];
    const entry: BackendPolicyOverride = {};
    const enabled = c?.enabled !== undefined ? c.enabled : r?.enabled;
    const defaultModel = c?.defaultModel !== undefined ? c.defaultModel : r?.defaultModel;
    const defaultEffort = c?.defaultEffort !== undefined ? c.defaultEffort : r?.defaultEffort;
    if (typeof enabled === "boolean") entry.enabled = enabled;
    if (typeof defaultModel === "string" && defaultModel.trim()) entry.defaultModel = defaultModel.trim();
    if (typeof defaultEffort === "string" && defaultEffort.trim()) entry.defaultEffort = defaultEffort.trim();
    if (Object.keys(entry).length > 0) {
      backends[bKey as BackendId] = entry;
    }
  }
  if (Object.keys(backends).length > 0) out.backends = backends;

  const rawIdentities = config.identities ?? raw?.identities;
  if (rawIdentities && Object.keys(rawIdentities).length > 0) {
    out.identities = structuredClone(rawIdentities);
  }
  const rawTopology = config.topology ?? raw?.topology;
  if (Array.isArray(rawTopology) && rawTopology.length > 0) {
    out.topology = structuredClone(rawTopology);
  }

  const { policy } = sanitizePolicyLayer(out, { layer: "global_ui" });
  return policy;
}

export function resolveDispatchPolicy(input: {
  config: PolySwarmConfig;
  repoRoot?: string | null;
  projectPolicy?: DispatchPolicyLayerConfig | null;
  projectConfigPath?: string | null;
  projectWarnings?: string[];
  sessionPolicy?: DispatchPolicyLayerConfig | null;
  swarmId?: string | null;
}): ResolvedDispatchPolicy {
  const warnings: string[] = [...(input.projectWarnings ?? [])];

  const globalLayer = buildEffectiveGlobalUiLayer(input.config);

  let projectPath = input.projectConfigPath ?? null;
  let projectRaw = input.projectPolicy ?? null;
  if (projectRaw === null && input.repoRoot) {
    const loaded = loadProjectPolicy(input.repoRoot);
    projectPath = loaded.path;
    projectRaw = loaded.policy;
    warnings.push(...loaded.warnings);
  }
  const projectSanitized = projectRaw
    ? sanitizePolicyLayer(projectRaw, { layer: "project" })
    : { policy: {}, warnings: [] };
  warnings.push(...projectSanitized.warnings);
  const projectLayer = projectSanitized.policy;

  const sessionSanitized = input.sessionPolicy
    ? sanitizePolicyLayer(input.sessionPolicy, { layer: "session" })
    : { policy: {}, warnings: [] };
  warnings.push(...sessionSanitized.warnings);
  const sessionLayer = sessionSanitized.policy;

  // 1. Routes (L1 -> L2 -> L3 -> L4)
  const routes: Record<CapabilityTag, BackendId[]> = structuredClone(DEFAULT_ROUTES);
  const route_sources = {} as Record<CapabilityTag, FieldProvenance>;
  for (const cap of Object.keys(DEFAULT_ROUTES) as CapabilityTag[]) {
    route_sources[cap] = { layer: "builtin", weight: LAYER_WEIGHTS.builtin };
  }

  const applyRoutes = (layer: Exclude<PolicyLayer, "builtin" | "worker_explicit">, r?: DispatchPolicyLayerConfig["routes"]) => {
    if (!r) return;
    const weight = LAYER_WEIGHTS[layer];
    for (const [cap, list] of Object.entries(r)) {
      if (Array.isArray(list) && list.length > 0) {
        routes[cap as CapabilityTag] = [...list];
        route_sources[cap as CapabilityTag] = { layer, weight };
      }
    }
  };
  applyRoutes("global_ui", globalLayer.routes);
  applyRoutes("project", projectLayer.routes);
  applyRoutes("session", sessionLayer.routes);

  // 2. Backends (L1 -> L2 -> L3 -> L4)
  const backends: Partial<Record<BackendId, ResolvedBackendPolicy>> = {};
  for (const b of ALL_KNOWN_BACKENDS) {
    backends[b] = {
      backend: b,
      enabled: true,
      globally_disabled: false,
      enabled_source: { layer: "builtin", weight: LAYER_WEIGHTS.builtin },
    };
  }

  const applyBackends = (
    layer: Exclude<PolicyLayer, "builtin" | "worker_explicit">,
    bMap?: DispatchPolicyLayerConfig["backends"],
  ) => {
    if (!bMap) return;
    const weight = LAYER_WEIGHTS[layer];
    for (const [bKey, ov] of Object.entries(bMap)) {
      const target = backends[bKey as BackendId];
      if (!target || !ov) continue;

      if (ov.enabled !== undefined && ov.enabled !== null) {
        if (layer === "global_ui") {
          target.enabled = ov.enabled;
          target.globally_disabled = ov.enabled === false;
          target.enabled_source = { layer, weight };
        } else {
          if (ov.enabled === true && target.globally_disabled) {
            warnings.push(
              `安全拦截 [${layer}]：后端 '${bKey}' 已在主配置中全局禁用，${LAYER_LABELS[layer]}不可重新启用。`,
            );
          } else {
            target.enabled = ov.enabled;
            target.enabled_source = { layer, weight };
          }
        }
      }

      if (ov.defaultModel !== undefined) {
        if (ov.defaultModel === null || ov.defaultModel === "") {
          delete target.defaultModel;
          target.model_source = { layer, weight, detail: "cli_default" };
        } else {
          target.defaultModel = ov.defaultModel;
          target.model_source = { layer, weight };
        }
      }

      if (ov.defaultEffort !== undefined) {
        if (ov.defaultEffort === null || ov.defaultEffort === "") {
          delete target.defaultEffort;
          target.effort_source = { layer, weight, detail: "cli_default" };
        } else {
          target.defaultEffort = ov.defaultEffort;
          target.effort_source = { layer, weight };
        }
      }
    }
  };
  applyBackends("global_ui", globalLayer.backends);
  applyBackends("project", projectLayer.backends);
  applyBackends("session", sessionLayer.backends);

  // 3. Identities (L1 -> L2 -> L3 -> L4)
  const identities: Record<string, ResolvedDispatchIdentity> = {};
  for (const [id, spec] of Object.entries(BUILTIN_IDENTITIES)) {
    const field_sources: Record<string, FieldProvenance> = {};
    for (const key of Object.keys(spec)) {
      field_sources[key] = { layer: "builtin", weight: LAYER_WEIGHTS.builtin };
    }
    identities[id] = {
      ...structuredClone(spec),
      source: "builtin",
      weight: LAYER_WEIGHTS.builtin,
      builtin: true,
      enabled: spec.enabled ?? true,
      field_sources,
      prompt_layers: spec.system_prompt ? ["builtin"] : [],
    };
  }

  const applyIdentities = (
    layer: Exclude<PolicyLayer, "builtin" | "worker_explicit">,
    idMap?: DispatchPolicyLayerConfig["identities"],
  ) => {
    if (!idMap) return;
    const weight = LAYER_WEIGHTS[layer];
    for (const [id, patch] of Object.entries(idMap)) {
      if (patch === null) {
        if (identities[id] && !identities[id]!.builtin) {
          delete identities[id];
        }
        continue;
      }
      if (!patch || typeof patch !== "object") continue;

      let existing = identities[id];
      if (!existing) {
        const baseRole: WorkerRole = patch.base_role ?? "worker";
        const cap: CapabilityTag = patch.capability ?? roleToDefaultCapability(baseRole);
        const wsMode: WorkspaceMode =
          patch.workspace_mode ?? (baseRole === "author" ? "share" : "inherit");
        existing = {
          id,
          label: patch.label || id,
          ...(patch.description ? { description: patch.description } : {}),
          base_role: baseRole,
          capability: cap,
          workspace_mode: wsMode,
          auto_fallback: patch.auto_fallback ?? true,
          require_cross_vendor: patch.require_cross_vendor ?? (baseRole === "verifier"),
          prompt_mode: patch.prompt_mode ?? "replace",
          enabled: patch.enabled ?? true,
          source: layer,
          weight: patch.weight ?? weight,
          builtin: false,
          field_sources: {
            id: { layer, weight },
            label: { layer, weight },
            base_role: { layer, weight },
            capability: { layer, weight },
            workspace_mode: { layer, weight },
            auto_fallback: { layer, weight },
            enabled: { layer, weight },
          },
          prompt_layers: [],
        };
        identities[id] = existing;
      } else {
        existing.source = layer;
        existing.weight = patch.weight ?? weight;
      }

      if (patch.label !== undefined) {
        if (patch.label === null) existing.label = existing.builtin ? BUILTIN_IDENTITIES[id]!.label : id;
        else existing.label = patch.label;
        existing.field_sources.label = { layer, weight };
      }

      if (patch.description !== undefined) {
        if (patch.description === null) delete existing.description;
        else existing.description = patch.description;
        existing.field_sources.description = { layer, weight };
      }

      if (patch.base_role !== undefined && patch.base_role !== null) {
        if (
          READONLY_BUILTIN_IDENTITIES.has(id) &&
          (layer === "project" || layer === "session") &&
          patch.base_role !== "verifier" &&
          patch.base_role !== "researcher"
        ) {
          warnings.push(
            `安全拦截 [${layer}]：内置只读身份 '${id}' 不可降级为可写角色 '${patch.base_role}'。`,
          );
        } else {
          existing.base_role = patch.base_role;
          existing.field_sources.base_role = { layer, weight };
        }
      }

      if (patch.capability !== undefined && patch.capability !== null) {
        existing.capability = patch.capability;
        existing.field_sources.capability = { layer, weight };
      }

      if (patch.preferred_backends !== undefined) {
        if (patch.preferred_backends === null || patch.preferred_backends.length === 0) {
          delete existing.preferred_backends;
        } else {
          existing.preferred_backends = [...patch.preferred_backends];
        }
        existing.field_sources.preferred_backends = { layer, weight };
      }

      if (patch.model !== undefined) {
        if (patch.model === null) delete existing.model;
        else existing.model = patch.model;
        existing.field_sources.model = { layer, weight };
      }

      if (patch.effort !== undefined) {
        if (patch.effort === null) delete existing.effort;
        else existing.effort = patch.effort;
        existing.field_sources.effort = { layer, weight };
      }

      if (patch.workspace_mode !== undefined) {
        if (patch.workspace_mode === null) delete existing.workspace_mode;
        else existing.workspace_mode = patch.workspace_mode;
        existing.field_sources.workspace_mode = { layer, weight };
      }

      if (patch.auto_fallback !== undefined) {
        if (patch.auto_fallback === null) existing.auto_fallback = true;
        else existing.auto_fallback = patch.auto_fallback;
        existing.field_sources.auto_fallback = { layer, weight };
      }

      if (patch.require_cross_vendor !== undefined) {
        if (patch.require_cross_vendor === null) existing.require_cross_vendor = false;
        else existing.require_cross_vendor = patch.require_cross_vendor;
        existing.field_sources.require_cross_vendor = { layer, weight };
      }

      if (patch.reports_to !== undefined) {
        if (patch.reports_to === null) delete existing.reports_to;
        else existing.reports_to = patch.reports_to;
        existing.field_sources.reports_to = { layer, weight };
      }

      if (patch.review_by !== undefined) {
        if (patch.review_by === null) delete existing.review_by;
        else existing.review_by = patch.review_by;
        existing.field_sources.review_by = { layer, weight };
      }

      if (patch.prompt_mode !== undefined && patch.prompt_mode !== null) {
        existing.prompt_mode = patch.prompt_mode;
        existing.field_sources.prompt_mode = { layer, weight };
      }

      if (patch.system_prompt !== undefined) {
        if (patch.system_prompt === null) {
          delete existing.system_prompt;
          existing.prompt_layers = [];
        } else {
          const mode = patch.prompt_mode ?? existing.prompt_mode ?? "replace";
          if (mode === "append" && existing.system_prompt) {
            existing.system_prompt = `${existing.system_prompt}\n\n${patch.system_prompt}`.trim();
            existing.prompt_layers = [...(existing.prompt_layers ?? []), layer];
          } else {
            existing.system_prompt = patch.system_prompt;
            existing.prompt_layers = [layer];
          }
        }
        existing.field_sources.system_prompt = { layer, weight };
      }

      if (patch.skill_paths != null) {
        existing.skill_paths = [...patch.skill_paths];
        existing.field_sources.skill_paths = { layer, weight };
      }

      if (patch.enabled !== undefined && patch.enabled !== null) {
        existing.enabled = patch.enabled;
        existing.field_sources.enabled = { layer, weight };
      }
    }
  };
  applyIdentities("global_ui", globalLayer.identities);
  applyIdentities("project", projectLayer.identities);
  applyIdentities("session", sessionLayer.identities);

  // 4. Topology (L2 -> L3 -> L4, keyed by from->to:kind)
  const topologyMap = new Map<string, PlannedGraphLink>();
  const applyTopology = (
    layer: Exclude<PolicyLayer, "builtin" | "worker_explicit">,
    links?: PlannedGraphLink[],
  ) => {
    if (!links) return;
    for (const link of links) {
      const key = `${link.from}::${link.to}::${link.kind}`;
      topologyMap.set(key, {
        ...link,
        source: layer,
      });
    }
  };
  applyTopology("global_ui", globalLayer.topology);
  applyTopology("project", projectLayer.topology);
  applyTopology("session", sessionLayer.topology);

  const layers: PolicyLayerStatus[] = [
    {
      layer: "builtin",
      weight: LAYER_WEIGHTS.builtin,
      label: LAYER_LABELS.builtin,
      active: true,
      path: null,
      override_count: Object.keys(BUILTIN_IDENTITIES).length,
      raw: null,
    },
    {
      layer: "global_ui",
      weight: LAYER_WEIGHTS.global_ui,
      label: LAYER_LABELS.global_ui,
      active: countPolicyOverrides(globalLayer) > 0,
      path: input.config.configPath,
      override_count: countPolicyOverrides(globalLayer),
      raw: globalLayer,
    },
    {
      layer: "project",
      weight: LAYER_WEIGHTS.project,
      label: LAYER_LABELS.project,
      active: countPolicyOverrides(projectLayer) > 0,
      path: projectPath ?? (input.repoRoot ? resolveProjectConfigPaths(input.repoRoot).writePath : null),
      override_count: countPolicyOverrides(projectLayer),
      raw: projectLayer,
    },
    {
      layer: "session",
      weight: LAYER_WEIGHTS.session,
      label: LAYER_LABELS.session,
      active: countPolicyOverrides(sessionLayer) > 0,
      path: input.swarmId ? `swarm:${input.swarmId}` : null,
      override_count: countPolicyOverrides(sessionLayer),
      raw: sessionLayer,
    },
  ];

  return {
    routes,
    route_sources,
    backends,
    identities,
    topology: [...topologyMap.values()],
    layers,
    warnings,
    project_config_path: projectPath,
    swarm_id: input.swarmId ?? null,
  };
}

export interface ResolvedWorkerDispatchPlan {
  identity: ResolvedDispatchIdentity;
  identity_id: string;
  role: WorkerRole;
  capability: CapabilityTag;
  workspace_mode: WorkspaceMode;
  auto_fallback: boolean;
  reports_to: string | null;
  review_by: string | null;
  preferred_backends: BackendId[] | undefined;
  system_prompt: string | null;
  policy_source: PolicyLayer;
  field_sources: Record<string, FieldProvenance>;
}

export function resolveWorkerDispatch(
  policy: ResolvedDispatchPolicy,
  request: {
    identity?: string;
    role?: WorkerRole;
    capability?: CapabilityTag;
    backend?: BackendId;
    model?: string | null;
    effort?: string | null;
    workspace_mode?: WorkspaceMode;
    auto_fallback?: boolean;
    reports_to?: string | null;
  },
): ResolvedWorkerDispatchPlan {
  let identityId: string;
  if (request.identity && request.identity.trim()) {
    identityId = validateIdentityId(request.identity);
  } else {
    identityId = request.role ?? "author";
  }

  const identity = policy.identities[identityId];
  if (!identity) {
    throw new Error(
      `Unknown dispatch identity '${identityId}'. Define it in poly-swarm settings/policy or use a built-in identity (${Object.keys(BUILTIN_IDENTITIES).join(", ")}).`,
    );
  }
  if (!identity.enabled) {
    throw new Error(`Dispatch identity '${identityId}' is disabled in the active policy.`);
  }

  if (
    request.identity &&
    READONLY_BUILTIN_IDENTITIES.has(identityId) &&
    request.role &&
    request.role !== "verifier" &&
    request.role !== "researcher"
  ) {
    throw new Error(
      `Readonly identity '${identityId}' cannot be overridden to writable role '${request.role}'.`,
    );
  }

  const explicitProv: FieldProvenance = {
    layer: "worker_explicit",
    weight: LAYER_WEIGHTS.worker_explicit,
  };

  const role: WorkerRole = request.role ?? identity.base_role;
  const capability: CapabilityTag =
    request.capability ??
    (request.role && !request.identity ? roleToDefaultCapability(request.role) : identity.capability);
  const workspace_mode: WorkspaceMode =
    request.workspace_mode ?? identity.workspace_mode ?? (role === "author" ? "share" : "inherit");
  const auto_fallback: boolean = request.auto_fallback ?? identity.auto_fallback ?? true;
  const reports_to: string | null =
    request.reports_to !== undefined
      ? request.reports_to
        ? request.reports_to.trim().toLowerCase()
        : null
      : identity.reports_to ?? null;

  const field_sources: Record<string, FieldProvenance> = {
    identity_id: request.identity ? explicitProv : { layer: identity.source, weight: identity.weight },
    role: request.role ? explicitProv : identity.field_sources.base_role ?? { layer: identity.source, weight: identity.weight },
    capability: request.capability
      ? explicitProv
      : identity.field_sources.capability ?? { layer: identity.source, weight: identity.weight },
    workspace_mode: request.workspace_mode
      ? explicitProv
      : identity.field_sources.workspace_mode ?? { layer: identity.source, weight: identity.weight },
    auto_fallback:
      request.auto_fallback !== undefined
        ? explicitProv
        : identity.field_sources.auto_fallback ?? { layer: identity.source, weight: identity.weight },
  };
  if (reports_to) {
    field_sources.reports_to =
      request.reports_to !== undefined
        ? explicitProv
        : identity.field_sources.reports_to ?? { layer: identity.source, weight: identity.weight };
  }

  const policy_source: PolicyLayer =
    request.backend || request.model || request.effort || request.workspace_mode || request.role
      ? "worker_explicit"
      : identity.source;

  return {
    identity,
    identity_id: identityId,
    role,
    capability,
    workspace_mode,
    auto_fallback,
    reports_to,
    review_by: identity.review_by ?? null,
    preferred_backends: identity.preferred_backends,
    system_prompt: identity.system_prompt?.trim() ? identity.system_prompt.trim() : null,
    policy_source,
    field_sources,
  };
}

export function resolveEffectiveModelAndEffort(params: {
  policy: ResolvedDispatchPolicy;
  identity: ResolvedDispatchIdentity;
  backend: BackendId;
  explicitModel?: string | null;
  explicitEffort?: string | null;
  isFallback?: boolean;
}): {
  model: string | null;
  effort: string | null;
  model_source: FieldProvenance;
  effort_source: FieldProvenance;
} {
  const backendPol = params.policy.backends[params.backend];
  const preferred = params.identity.preferred_backends;
  const identityMatchesBackend =
    !preferred || preferred.length === 0 || preferred.includes(params.backend);

  let model: string | null = null;
  let model_source: FieldProvenance = { layer: "builtin", weight: LAYER_WEIGHTS.builtin };
  if (params.explicitModel && params.explicitModel.trim()) {
    model = params.explicitModel.trim();
    model_source = { layer: "worker_explicit", weight: LAYER_WEIGHTS.worker_explicit };
  } else if (!params.isFallback && params.identity.model && identityMatchesBackend) {
    model = params.identity.model;
    model_source = params.identity.field_sources.model ?? {
      layer: params.identity.source,
      weight: params.identity.weight,
    };
  } else if (backendPol?.defaultModel) {
    model = backendPol.defaultModel;
    model_source = backendPol.model_source ?? {
      layer: "global_ui",
      weight: LAYER_WEIGHTS.global_ui,
    };
  }

  let effort: string | null = null;
  let effort_source: FieldProvenance = { layer: "builtin", weight: LAYER_WEIGHTS.builtin };
  if (params.explicitEffort && params.explicitEffort.trim()) {
    effort = params.explicitEffort.trim();
    effort_source = { layer: "worker_explicit", weight: LAYER_WEIGHTS.worker_explicit };
  } else if (!params.isFallback && params.identity.effort && identityMatchesBackend) {
    effort = params.identity.effort;
    effort_source = params.identity.field_sources.effort ?? {
      layer: params.identity.source,
      weight: params.identity.weight,
    };
  } else if (backendPol?.defaultEffort) {
    effort = backendPol.defaultEffort;
    effort_source = backendPol.effort_source ?? {
      layer: "global_ui",
      weight: LAYER_WEIGHTS.global_ui,
    };
  }

  return { model, effort, model_source, effort_source };
}

export function buildWorkerPolicySnapshot(params: {
  plan: ResolvedWorkerDispatchPlan;
  backend: BackendId;
  backendExplicit: boolean;
  model: string | null;
  effort: string | null;
  model_source: FieldProvenance;
  effort_source: FieldProvenance;
  policy: ResolvedDispatchPolicy;
}): WorkerPolicySnapshot {
  const field_sources: Record<string, FieldProvenance> = {
    ...params.plan.field_sources,
    backend: params.backendExplicit
      ? { layer: "worker_explicit", weight: LAYER_WEIGHTS.worker_explicit }
      : params.plan.preferred_backends?.length
        ? params.plan.identity.field_sources.preferred_backends ?? {
            layer: params.plan.identity.source,
            weight: params.plan.identity.weight,
          }
        : params.policy.route_sources[params.plan.capability] ?? {
            layer: "builtin",
            weight: LAYER_WEIGHTS.builtin,
          },
    model: params.model_source,
    effort: params.effort_source,
  };

  return {
    identity_id: params.plan.identity_id,
    base_role: params.plan.role,
    capability: params.plan.capability,
    backend: params.backend,
    model: params.model,
    effort: params.effort,
    workspace_mode: params.plan.workspace_mode,
    auto_fallback: params.plan.auto_fallback,
    reports_to: params.plan.reports_to,
    review_by: params.plan.review_by,
    policy_source: params.plan.policy_source,
    field_sources,
  };
}
