// ftc-compute.ts 从 './fuel-model' 同时「值导入」了函数**和** FuelOption / ShipPerformance
// 两个 interface（未写 `import type`，打包器会擦除类型位）。Node 的类型剥离不擦除普通
// import 中的类型名 → 直接导入真实模块会报 "does not provide an export named 'FuelOption'"。
//
// 生产代码零改动：本 shim 原样再导出真实模型，并补上两个**仅存在于类型位**的同名占位导出
// （运行时永不被读取；万一被读取会立刻以等价形式报错，而不是静默给错值）。
export * from '../../src/features/XIT/FTC/fuel-model.ts';
export const FuelOption = undefined;
export const ShipPerformance = undefined;
