// 共享的「相对无扩展名导入 → .ts」解析兜底，供 scripts/lib/*-loader.mjs 复用。
//
// 生产侧由 Vite 补扩展名，Node ESM 必须显式写 `.ts`。各 loader 的显式映射（REAL / STUBBED）
// 仍然优先执行；本函数只在最后一步兜底，所以不会掩盖替身映射。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveTsRelative(specifier, context) {
  if (!specifier.startsWith('.') || context.parentURL === undefined) {
    return undefined;
  }
  const base = new URL(specifier, context.parentURL);
  const candidate = base.href.endsWith('.ts') ? base.href : `${base.href}.ts`;
  return existsSync(fileURLToPath(candidate)) ? candidate : undefined;
}
