// XIT GOVH 的「我作为管理者的政府」读取层。
// 运行时零外部请求：只把游戏本地两处已有信息拼成 政府 context → 星球编码 映射：
//   1. userDataStore.contexts 里的 type === 'GOVERNMENT'（权限事实源，排除公司上下文）；
//   2. 游戏原生顶部「视图」菜单里 a[href*="context="] 的显示名，形如
//      「位于 Shardonia b (VH-192b) 的管理方」，其内层 span 带星球 naturalId。
// 不硬编码任何 context id / 星球编码；账户换了政府会随 DOM / USER_DATA 自动更新。

import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';

export interface ManagedGovernment {
  contextId: string;
  planet: string;
  name: string;
  label: string;
}

const PARENTHESIZED_ID = /[（(]\s*([A-Z]{1,5}-\d{1,5}[a-z]?)\s*[)）]/i;
const LOOSE_ID = /\b([A-Z]{1,5}-\d{1,5}[a-z]?)\b/i;
const CONTEXT_ID = /context=([0-9a-f]+)/i;

function parsePlanet(
  rawLabel: string,
): Pick<ManagedGovernment, 'planet' | 'name' | 'label'> | undefined {
  const label = rawLabel.trim();
  if (label === '') {
    return undefined;
  }
  const match = PARENTHESIZED_ID.exec(label) ?? LOOSE_ID.exec(label);
  if (!match) {
    return undefined;
  }
  // planetsStore 的 getter 按大写匹配，并回传服务端原始大小写（VH-192b）。
  const planet = planetsStore.getByNaturalId(match[1]);
  const naturalId = planet?.naturalId ?? match[1];
  const name = label.replace(/\s*[（(][^)）]*[)）]\s*$/, '').trim() || planet?.name || naturalId;
  return { planet: naturalId, name, label: `${name} (${naturalId})` };
}

// 只读 DOM + 本地 store，返回当前账号有管理权限的全部政府。
export function readManagedGovernments(): ManagedGovernment[] {
  const governmentIds = new Set(
    (userDataStore.contexts ?? []).filter(x => x.type === 'GOVERNMENT').map(x => x.id),
  );
  if (governmentIds.size === 0) {
    return [];
  }

  const scoped = document.querySelectorAll(
    '[class*="ContextControls__contexts"] a[href*="context="]',
  );
  const links = scoped.length > 0 ? scoped : document.querySelectorAll('a[href*="context="]');
  const found = new Map<string, ManagedGovernment>();
  for (const link of links) {
    const id = CONTEXT_ID.exec(link.getAttribute('href') ?? '')?.[1];
    if (!id || !governmentIds.has(id)) {
      continue;
    }
    const rawLabel =
      link.querySelector('span')?.textContent?.trim() || link.textContent?.trim() || '';
    const parsed = parsePlanet(rawLabel);
    if (parsed) {
      found.set(id, { contextId: id, ...parsed });
    }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function sameGovernments(a: ManagedGovernment[], b: ManagedGovernment[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.contextId === b[i].contextId && x.planet === b[i].planet && x.label === b[i].label,
    )
  );
}

// 面板内使用：自动跟随「视图」菜单和 USER_DATA 变化，卸载时释放 observer。
export function useManagedGovernments() {
  const governments = shallowRef<ManagedGovernment[]>([]);
  const loaded = ref(false);
  let timer: number | undefined;

  const refresh = () => {
    const next = readManagedGovernments();
    // 只有内容真变了才换引用，避免面板自己的 DOM 更新触发 observer 再刷新导致回环。
    if (!sameGovernments(governments.value, next)) {
      governments.value = next;
    }
    loaded.value = true;
  };

  refresh();

  const observer = new MutationObserver(() => {
    if (timer !== undefined) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      refresh();
    }, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const stopStoreWatch = watch(() => userDataStore.contexts, refresh);

  onScopeDispose(() => {
    observer.disconnect();
    stopStoreWatch();
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  });

  return { governments, loaded, refresh };
}
