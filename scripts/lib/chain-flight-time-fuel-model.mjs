// ftc-compute.ts 从 './fuel-model' 一次性「值导入」了函数**和** FuelOption / ShipPerformance
// 两个 interface（未写 `import type`，打包器会擦除类型位）。Node 的类型剥离不擦除普通
// import 里的类型名 → 直接导入真实模块会报 "does not provide an export named 'FuelOption'"。
//
// 生产代码零改动：本 shim 原样再导出真实模型（纯函数、无模块级可变状态，见 fuel-model.ts
// 文件头），并补上仅存在于类型位的同名占位导出（运行时永不被读取）。
//
// 与 scripts/lib/ftc-node-fuel-model.mjs 同形：**新建**而不是复用它，避免两个脚本的
// 依赖面互相牵制（改一处替身就影响另一条用例）。
export * from '../../src/features/XIT/FTC/fuel-model.ts';
export const FuelOption = undefined;
export const ShipPerformance = undefined;
export const RouteMetrics = undefined;
