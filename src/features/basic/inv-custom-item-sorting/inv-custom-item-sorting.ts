import css from '@src/utils/css-utils.module.css';
import $style from './inv-custom-item-sorting.module.css';
import { BurnValues, getPlanetBurn } from '@src/core/burn';
import CategoryHeader from './CategoryHeader.vue';
import InventorySortControls from './InventorySortControls.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import GridMaterialIcon from '@src/components/GridMaterialIcon.vue';
import SORT from '@src/features/XIT/SORT/SORT.vue';
import { FragmentAppScope } from '@src/utils/vue-fragment-app';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sortByMaterial, sortMaterials } from '@src/core/sort-materials';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { isEmpty } from 'ts-extras';
import SortCriteria from '@src/features/basic/inv-custom-item-sorting/SortCriteria.vue';
import { getSortingData } from '@src/store/user-data-sorting';
import { getInvStore } from '@src/core/store-id';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.InventoryView.container), container =>
    applyCustomSorting(tile, container),
  );
}

async function applyCustomSorting(tile: PrunTile, container: HTMLElement) {
  const parameter = tile.parameter;
  if (!parameter) {
    return;
  }

  const store = getInvStore(parameter);
  const sortingData = getSortingData(parameter);
  const catSort = computed({
    get: () => sortingData.cat ?? true,
    set: value => (sortingData.cat = value ? undefined : false),
  });
  const reverseSort = computed({
    get: () => sortingData.reverse ?? false,
    set: value => (sortingData.reverse = value ? true : undefined),
  });
  const sortOptions = await $(container, C.InventorySortControls.controls);
  const inventory = await $(container, C.InventoryView.grid);

  // 提前枚举子元素，因为循环中会修改集合。
  const criterion = Array.from(sortOptions.children);

  // 跳过第一个排序选项，因为它是网格/列表视图切换。
  for (let i = 1; i < criterion.length; i++) {
    const option = criterion[i] as HTMLElement;
    option.addEventListener('click', () => {
      sortingData.active = undefined;
      catSort.value = false;
    });
    const isCategorySort = i === 2;
    if (!isCategorySort) {
      continue;
    }
    createFragmentApp(
      SortCriteria,
      reactive({
        label: option.textContent ?? 'CAT',
        active: catSort,
        reverse: reverseSort,
        onClick: () => {
          if (catSort.value) {
            reverseSort.value = !reverseSort.value;
          } else {
            sortingData.active = undefined;
            catSort.value = true;
            reverseSort.value = false;
          }
        },
      }),
    ).after(option);
    option.style.display = 'none';
  }

  // 参数可能是仓库 id 前缀、星球编码或飞船注册号，
  // 统一用 getInvStore 解析出仓库，否则按自然编号传参会拿不到 burn 数据、BRN 不出现。
  const burn = computed(() => getPlanetBurn(getInvStore(parameter)?.addressableId));

  const modes = computed(() => {
    const modes = sortingData.modes.slice();
    if (burn.value) {
      modes.push(burnSortingMode);
    }
    return modes;
  });

  watchEffectWhileNodeAlive(sortOptions, () => {
    if (sortingData.active || catSort.value) {
      sortOptions.classList.add($style.custom);
    } else {
      sortOptions.classList.remove($style.custom);
    }
  });

  createFragmentApp(
    InventorySortControls,
    reactive({
      sorting: modes,
      activeSort: toRef(() => sortingData.active),
      reverse: reverseSort,
      onModeClick: (mode: string) => {
        if (sortingData.active === mode) {
          reverseSort.value = !reverseSort.value;
        } else {
          sortingData.active = mode;
          catSort.value = false;
          reverseSort.value = false;
        }
      },
      onAddClick: () => showBuffer(`XIT SORT ${store?.id.substring(0, 8) ?? parameter}`),
    }),
  ).appendTo(sortOptions);

  const activeMode = computed(() => modes.value.find(x => x.label === sortingData.active));

  const scope = new FragmentAppScope();
  const runSort = () => {
    observer.disconnect();
    scope.begin();
    sortInventory(
      inventory,
      catSort.value ? categorySortingMode : activeMode.value,
      burn.value?.burn,
      reverseSort.value,
    );
    scope.end();
    setTimeout(() => observer.observe(inventory, { childList: true, subtree: true }), 0);
  };
  const observer = new MutationObserver(runSort);
  let first = true;
  watchEffectWhileNodeAlive(inventory, () => {
    // 触发响应式值。
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = [sortingData.reverse, sortingData.active, sortingData.cat, burn.value];
    if (first) {
      first = false;
      runSort();
      return;
    }
    setTimeout(runSort, 50);
  });
}

function sortInventory(
  inventory: Element,
  sorting: UserData.SortingMode | undefined,
  burn: BurnValues | undefined,
  reverse: boolean,
) {
  if (!sorting) {
    return;
  }

  const gridItems = _$$(inventory, C.GridItemView.container).map(div => ({
    div,
    ticker: _$(div, C.ColoredIcon.label)?.textContent,
  }));
  const categories = sorting.categories.slice();

  if (sorting.burn && burn) {
    const tickers = Object.keys(burn);
    const inputs = new Set(tickers.filter(x => burn[x].type === 'input'));
    const outputs = new Set(tickers.filter(x => burn[x].type === 'output' && !inputs.has(x)));
    const workforce = tickers.filter(
      x => burn[x].type === 'workforce' && !inputs.has(x) && !outputs.has(x),
    );

    categories.push({
      name: 'Consumables',
      materials: workforce,
    });
    categories.push({
      name: 'Inputs',
      materials: [...inputs],
    });
    categories.push({
      name: 'Outputs',
      materials: [...outputs],
    });
  }

  const addedItems = new Set<string>();
  const remainingItems = new Set(gridItems);

  if (reverse) {
    categories.reverse();
  }

  for (const category of categories) {
    let materials = category.materials
      .filter(x => !addedItems.has(x))
      .map(x => materialsStore.getByTicker(x))
      .filter(x => x !== undefined);
    if (isEmpty(materials)) {
      continue;
    }

    createFragmentApp(CategoryHeader, { label: category.name }).appendTo(inventory);
    materials = sortMaterials(materials);
    if (reverse) {
      materials.reverse();
    }
    for (const material of materials) {
      const gridItem = gridItems.find(x => x.ticker === material.ticker);
      if (gridItem) {
        inventory.appendChild(gridItem.div);
        remainingItems.delete(gridItem);
      } else if (sorting.zero) {
        createFragmentApp(GridMaterialIcon, {
          ticker: material.ticker,
          amount: 0,
          warning: true,
        }).appendTo(inventory);
      }
      addedItems.add(material.ticker);
    }
  }

  if (remainingItems.size === 0) {
    return;
  }

  if (addedItems.size > 0) {
    createFragmentApp(CategoryHeader, { label: '其他' }).appendTo(inventory);
  }
  let otherItems = [...remainingItems].map(x => ({
    div: x.div,
    material: materialsStore.getByTicker(x.ticker),
  }));
  otherItems = sortByMaterial(otherItems, x => x.material);
  if (reverse) {
    otherItems.reverse();
  }
  for (const item of otherItems) {
    inventory.appendChild(item.div);
  }
}

const categorySortingMode = {
  label: 'CAT',
  categories: [],
  burn: false,
  zero: false,
};

const burnSortingMode = {
  label: 'BRN',
  categories: [],
  burn: true,
  zero: true,
};

function init() {
  applyCssRule(`.${$style.custom} .${C.InventorySortControls.order} > div`, css.hidden);
  tiles.observe(['INV', 'SHPI'], onTileReady);
  xit.add({
    command: 'SORT',
    name: '排序模式',
    description: '排序模式编辑器。',
    mandatoryParameters: '库存标识符',
    component: () => SORT,
  });
}

features.add(import.meta.url, init, 'INV/SHPI：为库存添加自定义排序模式。');
