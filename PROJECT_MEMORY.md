# 项目持久记忆 Project Memory

> 本文件由 dsh-memoir 插件维护：记录本项目历次会话的工作归纳、经验教训与行动指南，
> 作为未来 AGENTS 接手本项目时的行动指南；它是人类可读的投影，不是 system prompt 的完整注入内容。
> 新会话只注入有界的 Hot Memory，完整历史通过 memoir_read 按需检索。

## 工作记录 Work Log

- [2026-08-25 11:34] [工作记录] XIT FLEET 环线进度与ACT脚本改造 — 本轮完成 XIT FLEET 环线系列修复：1) 序一列补齐出发(序0)/归航(末行)完成标记，完成记录短暂保留10秒展示✓后自动清理；2) 载重列改为按持久化计划快照显示当前阶段载重(chainRuns.plan)，页面刷新后仍可还原，旧记录仍回退实时舱载；3) ACT 脚本按阶段编号(0 Chain 船名 / N 站点 Loop 船名 / M Chain Return 船名)，主包 autoDelete=true，执行新环线时清理旧版残留脚本与一次性触发器；4) 新增 chain-state.ts 的 markChainStageDone，ExecuteActionPackage 执行成功后写回持久化 stop/origin/final 状态，删除 ACT 包或触发器后列表站点与操作内容不再丢失；5) 导出JSON新增 chainRuns 全局状态(站点/操作/进度快照)，导入按 shipId 覆盖恢复，同时仍保留 triggers+actionPackages；6) 旧版逆推环线在 watchEffect 中兜底持久化到 chainRuns，防删触发器丢站点。涉及 ChainView.vue / chain-planner.ts / chain-state.ts(新增) / ExecuteActionPackage.vue / ImportTriggerConfig.vue / user-data.types.d.ts。
- [2026-08-25 11:50] [工作记录] 修复导入旧JSON后删除全部ACT/触发器仍显示预留列表 — 在 ChainView.vue 的清理 watchEffect 中新增孤立预留列表检测：若某条 chainRun 对应的主包(mainPkgName)/各站包(stops.pkgName)/归航包(finalPkgName)及触发器全部不存在，则直接从 userData.chainRuns 删除该记录；已完成(finalState=done)的记录仍保留10秒展示✓后再清理。解决导入旧JSON后删除全部ACT和触发器时列表一直残留空表的问题。
- [2026-08-25 11:53] [工作记录] 旧JSON/旧环线载重列改为阶段载重 — 导入旧JSON或旧环线记录无plan快照时，ChainView.vue 新增 buildPlanFromPackages/materialsLoad 从现有ACT包(主包装载、站点包卸货/提取、归航包)反推计划快照并写入 userData.chainRuns(plan与stop.plan)，使载重列显示各阶段规划载重而非实时舱载；舱容数据未加载前不落盘，快照落盘后删除ACT/触发器不再回退实时显示。
- [2026-08-25 12:05] [工作记录] 修复清空全部ACT/触发器后列表仍残留 — ChainView.vue 清理逻辑重构：先把 hasAnyScript(主包/站点包/归航包及触发器任一项存在)算出来，若全不存在则立即 delete userData.chainRuns；仅“新格式且已正常完成(mainPkgName存在+originState/finalState均done)”的记录保留10秒展示✓。同时 tables 渲染 planSnapshot 时按 progressByShip 过滤，只显示仍存在于 chainRuns 的船，避免残留已删除船舶的旧快照。
- [2026-08-25 12:25] [工作记录] 统一环线进度表列宽 — ChainView.vue 进度表改为 table-layout:fixed 并加 colgroup 固定列宽(序36px/星球150px/操作auto/飞行120px/载重180px)；narrowCol 改为 white-space:normal + word-break:break-word 防溢出。解决多船独立<table>因内容长短不同导致列宽不一致。
- [2026-08-25 12:35] [工作记录] 提交 FLEET 环线改动并更新 CHANGELOG — 已提交 commit cbb26e95 feat(XIT/FLEET): 环线列表全局状态持久化与进度展示增强（8文件，含新增 chain-state.ts）；CHANGELOG Unreleased 已按用户指示补充条目。提交前 prettier/eslint/compile 通过。

## 经验教训 Lessons Learned

- [2026-08-25 11:34] [经验教训] Volar 报错与 CHANGELOG 管理 — 教训：1) pnpm run compile 的 tsc --noEmit 不检查 .vue 文件，VSCode TS 插件(Volar) 才能暴露 .vue 内 string|undefined、g.name 可能 undefined 等类型错误，改 .vue 后要人工检查或看插件报错；2) 用户明确要求不要直接改 CHANGELOG.md，需等其发指令后再改，可用 git restore 回退并 git pull 拉取最新；3) 删除被列表引用的 ACT/触发器会导致执行列表丢内容，正确做法是把列表全局状态(站点+操作+进度)持久化为 JSON 并让 UI 优先读持久化状态，而不是从 actionPackages/triggers 实时推导。
- [2026-08-25 11:50] [经验教训] 列表持久化与“全部删除即清理”的边界 — 设计教训：删除单个ACT/触发器时列表应保留站点与操作(持久化chainRuns全局状态)，但删除全部脚本与触发器时属于“孤立预留列表”，应立即清理，否则旧JSON导入后空列表永远残留；清理顺序上完成态(finalState=done)优先走10秒延时清理，未完成且无任何关联脚本/触发器才走孤儿清理。logicprobe策略模型验证0 error，A3顺序依赖warning为模型抽象产物(真实代码中executed事件在脚本删除后不可触发)。
- [2026-08-25 11:53] [经验教训] 旧数据载重还原方法 — 旧版单船主包未写入ACT列表时无法直接读主包装载组，可用「各站包卸货之和+最终卸货」近似原始装载；已完成站包已删除时无法精确还原该站历史载重，只能以现有包为基准估算并持久化，避免继续显示实时舱载。
- [2026-08-25 12:05] [经验教训] 残留列表的第二个来源 — 教训：除了 chainRuns 未删除，planSnapshot(内存快照)也会导致“已删除的船”继续渲染——旧代码只在所有 chainRuns 清空时才清 planSnapshot，若其他船仍有运行，已删除的快照会一直显示。修复方式是渲染时用 progressByShip 过滤 planSnapshot，而不是等全部清空；且孤立记录应立即删除，不要走“完成态10秒保留”分支，否则用户会看到短暂/反复残留。
- [2026-08-25 12:25] [经验教训] 多个独立表格列宽不一致的原因 — 默认 table-layout:auto 按内容自适应分配列宽，多个独立<table>即使样式相同也会因内容长短不同列宽不一致；要统一需 table-layout:fixed + colgroup 固定各列宽度，弹性列留auto；同时注意 nowrap 在固定窄列会溢出，应允许换行。
- [2026-08-25 12:28] [经验教训] Vue SFC style 不支持 // 注释 — Vue 单文件组件的 <style module> 是普通 CSS，不识别 // 行注释；写入会触发 Volar css 解析错误(} expected / 空规则)。注释必须用 /* */。本次已把 ChainView.vue 中两处 // 注释改回块注释。

## 行动指南 Action Guide

- [2026-08-25 11:34] [行动指南] 待办与下一步 — 当前本地未提交改动包括 docs/feature-patterns.md 与上述 FLEET 相关文件(chain-state.ts 为新增)；CHANGELOG 未动(待用户指令)。后续：用户确认功能后按需提交，提交前跑 eslint/prettier/compile；如需补充 CHANGELOG 条目等用户明确指示再改。
- [2026-08-25 12:35] [行动指南] 工作区剩余未提交项 — 当前工作区仍有未提交：PRIVACY.md（与FLEET无关，疑似外部改动，未纳入提交）与 PROJECT_MEMORY.md（dsh-memoir 生成，建议不入库）。后续若用户要求推送 git push，先确认 PRIVACY.md 是否保留；CHANGELOG 由用户明确指示后再改。
