// SFC → FTC 航线推送门（同键同签名去重 + 永远等服务器下发）。纯状态机，无任何依赖。
//
// 抽成独立模块的原因：`sfc-auto-fuel-settings.ts` 本体依赖 vue / DOM / 游戏 UI，无法在
// Node 里加载，而这道闸本身是纯逻辑 —— 抽出来后 `scripts/verify-ftc-geometry-source.mjs`
// 能直接驱动**真实实现**（不是替身复刻）。
//
// 时序（决定为什么需要这道闸）：
//   T1 `C.MissionPlan.table` 文本变化 —— 服务器重算完成；`SHIP_FLIGHT_MISSION` 的
//      store 监听同步执行，先于 DOM 刷新，所以此刻原生 STL 段已经入库。
//   T2 目的地输入框 value 变化 —— 用户选中项目，早于服务器重算。
// 两个信号都会触发一次完整计算（全量燃料网格扫描，非公司蓝图时还有
// `ensureShipBlueprint` 阻塞 6s），且都由外部 DOM 抖动（拖滑块、打字停顿、游戏自身
// 重渲染）驱动。旧实现只在「算出完整结果」时给该航线打 settled 标记 → 残缺航线永不
// 标记 → 每次抖动都完整重算一次，无退避、无上限（已确认无自激、无死循环，纯粹是重复
// 计算）。这里加闸而不改时序。
//
// 闸门判据 = 「同一航线 key + 同一几何签名」：
//   ① 同 key 同签名在途 → 'pending'（跳过；T1/T2 相邻触发只跑一次）；
//   ② 同 key 同签名已跑过一次（无论结果完整与否）→ 'settled'（不再重复计算）；
//   ③ 其余情况（新 key / 签名变化）→ 'run'。
// **永远等服务器下发**（2026-09-23 用户拍板「不需要回退，永远等服务器下发」）：
// 航线几何只信服务器下发的原生 STL 段记录，数据没到就算不出来 —— 此时保持现状
// （不写滑块、不动玩家已有设置），等下一次信号。签名 = 单调信息量计数（真实新增的原生
// STL 段 / 轨道数据），**签名变化 = 服务器数据到了（或补全了）→ 必须放行重算**。
// 因此这里**刻意没有**「试满 N 次就放弃」的上限：上限一旦在数据到达之前生效，该航线会
// 被永久放弃（数据到了也不再算，面板永远不写滑块）。「宁可不动」是设计取舍，
// 「永久放弃」是 bug。首次设置目的地时的「T2 先到 → 原生几何尚未入库 → 不写滑块 →
// T1 到达（签名变化）→ 重算成功」正是依赖「签名变化必放行」这条规则。
// 防「无上限重算」靠的是同签名抑制：**同一签名最多算一次**，而签名只随真实新数据
// 单调增长（不会因同一份数据反复下发而自增）—— 于是 DOM 抖动（签名不变）不再触发
// 计算，某条航线的计算次数上界 = 1 + 其后再入库的几何记录数（每次都对应真实新数据）。
export type RoutePushDecision =
  // 允许开跑；调用方必须在计算结束（含抛异常）后配对调用 finish()。
  | 'run'
  // 同 key 同签名已算过一次：抑制。已算出完整结果 → 该 key 永久抑制（防「写滑块 →
  // 服务器重算 → 再推送」反馈循环）；残缺 → 等签名变化（服务器数据到达）再放行。
  | 'settled'
  // 同 key 同签名已有一次计算在跑：跳过（防 T1/T2 对同一 key 并发双跑）。
  | 'pending';

// 每个 SFC 磁贴一个实例（调用方用 WeakMap 键控磁贴锚点元素）。
export class RoutePushGate {
  private key?: string;
  private signature?: string;
  // 同 key 同签名是否有一次计算在途。
  private pending = false;
  // 是否已算出完整结果（航线不变则永久抑制）。
  private complete = false;

  begin(key: string, signature: string): RoutePushDecision {
    if (this.key === key) {
      if (this.complete) {
        return 'settled';
      }
      if (this.signature === signature) {
        // 在途：并发第二次调用跳过。
        if (this.pending) {
          return 'pending';
        }
        // 已算过一次（残缺）：几何没变，再算还是同一结果 —— 不再重复计算，等签名变化。
        return 'settled';
      }
    }
    // 新 key 或签名变化（= 新的原生 STL 段 / 新几何入库，服务器数据到了）：放行。
    this.key = key;
    this.signature = signature;
    this.pending = true;
    this.complete = false;
    return 'run';
  }

  finish(key: string, signature: string, complete: boolean) {
    // 过期完成（航线已变、或几何已变且另一次计算在跑）：丢弃，不覆盖当前状态。
    // 被丢弃不会卡住闸门：下一次 begin 会用新签名重写状态（或按 settled/pending 正常判定）。
    if (this.key !== key || this.signature !== signature) {
      return;
    }
    this.pending = false;
    this.complete = complete;
  }
}

// 「输入不完整」提示的打印级别（2026-09-23 第四轮降噪）。
//
// 问题：tile ready（T3）时立即推送的那一次，服务器计划**尚未到达** —— 那一刻原生 STL 段
// 记录必然还没入库，判定「输入残缺」是**时序产物**、不是真问题。旧实现一律 console.warn
// → 每次打开 SFC 面板都刷一条无用警告（用户实机日志里那条 500 字警告正是 T3 触发的）。
// 策略：**表格刷新过（T1，服务器计划已到）仍残缺**才算真问题 → warn；
// 此前的推送（T3 首推、T2 目的地输入变化）降为 debug，不再刷屏。
//
// 抽在这里（而不是内联在 sfc-auto-fuel-settings.ts）的原因同 RoutePushGate：本模块无依赖，
// 能被 scripts/verify-ftc-geometry-source.mjs 在 Node 里直接驱动**真实实现**。
export type IncompleteLogLevel = 'debug' | 'warn';

export function incompleteLogLevel(serverPlanSeen: boolean): IncompleteLogLevel {
  return serverPlanSeen ? 'warn' : 'debug';
}
