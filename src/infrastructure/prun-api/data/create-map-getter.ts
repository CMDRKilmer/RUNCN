const upperCase = (value: string) => value.toUpperCase();

export function createMapGetter<T>(
  items: Ref<T[] | undefined>,
  selector: (item: T) => string,
  valueTransformer?: (value: string) => string,
) {
  valueTransformer ??= upperCase;
  const map = computed(() => {
    if (items.value === undefined) {
      return undefined;
    }
    const map = new Map<string, T>();
    for (const item of items.value) {
      // Skip items with empty/missing keys to avoid upperCase(undefined) crashes.
      const key = selector(item);
      if (key === undefined || key === null || key === '') {
        continue;
      }
      map.set(valueTransformer(key), item);
    }
    return map;
  });
  return (value?: string | null) =>
    map.value !== undefined && value ? map.value.get(valueTransformer(value)) : undefined;
}

export function createGroupMapGetter<T>(
  items: Ref<T[] | undefined>,
  selector: (item: T) => string,
  valueTransformer?: (value: string) => string,
) {
  valueTransformer ??= upperCase;
  const map = computed(() => {
    if (items.value === undefined) {
      return undefined;
    }
    const map = new Map<string, T[]>();
    for (const item of items.value) {
      const raw = selector(item);
      // Skip items with empty/missing keys to avoid upperCase(undefined) crashes.
      if (raw === undefined || raw === null || raw === '') {
        continue;
      }
      const key = valueTransformer(raw);
      let group = map.get(key);
      if (!group) {
        group = [];
        map.set(key, group);
      }
      group.push(item);
    }
    return map;
  });
  return (value?: string | null) =>
    map.value !== undefined && value ? map.value.get(valueTransformer(value)) : undefined;
}
