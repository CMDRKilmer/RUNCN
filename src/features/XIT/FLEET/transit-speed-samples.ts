import { persistedRef } from '@src/utils/persisted-ref';
import {
  addTransitSpeedSample,
  restoreTransitSpeedSamples,
  transitSpeedSamplesSnapshot,
} from '@src/features/XIT/FTC/fuel-model';

// BTF 试飞顺带采到的转移速度样本（q, aEff, v），落盘后叠加到 FTC 的转移速度查询表。
// 远端表只覆盖少数 aEff 行（节油/超推引擎甚至只有单一值），自己采的样本能让该船
// 后续的 FTC 计算恢复正常——之前这些船会因为「转移速度查询表超出可靠范围」整段跳过。
type StoredSamples = Record<string, [number, number, number][]>;

const stored = persistedRef<StoredSamples>('rprun.ftc.transit-samples.v1', {});
restoreTransitSpeedSamples(stored.value);

export function recordTransitSpeedSample(engine: string, q: number, aEff: number, v: number) {
  if (!addTransitSpeedSample(engine, q, aEff, v)) {
    return;
  }
  stored.value = transitSpeedSamplesSnapshot();
}
