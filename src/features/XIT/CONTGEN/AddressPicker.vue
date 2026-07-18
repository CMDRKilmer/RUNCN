<script setup lang="ts">
// Address picker (planet naturalId) with fuzzy search. Wraps a plain
// <input> in a dropdown that filters across the full planet list
// (loaded from FIO via planetsStore). The player can type either a
// planet naturalId (e.g. VH-331a) or a planet/system name; the picker
// prefers naturalId prefix matches but also surfaces name hits for
// discovery.
//
// Notes:
//   - PrUn's own AddressSelector only renders matches that the server
//     returns, which excludes stations (Hortus Station, ZV-307c, etc).
//     This picker only knows planets, mirroring that constraint.
//   - When the player types something that matches nothing we keep
//     the raw text in the model (rather than overwriting it with
//     `''`), so partial / placeholder input doesn't get eaten.

import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { CSSProperties } from 'vue';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';

interface PlanetRow {
  naturalId: string;
  name: string;
}

const model = defineModel<string>({ required: true });

const query = ref(model.value);
const open = ref(false);
const activeIndex = ref(0);
const rootEl = ref<HTMLDivElement>();
const inputEl = ref<HTMLInputElement>();

// Materialize the planets list once. planetsStore.all.value may be
// undefined until FIO finishes loading; we just show nothing in that
// case rather than blocking the picker.
const candidates = computed<PlanetRow[]>(() => {
  const all = (planetsStore.all.value ?? []) as PlanetRow[];
  const q = query.value.trim();
  if (q.length === 0) {
    // Empty query → shortlist of "common" planets first. There isn't
    // a clean popularity signal available, so we just show the head
    // of the naturalId-sorted list. Better than nothing.
    return all.slice(0, 12);
  }
  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const idPrefix: PlanetRow[] = [];
  const idContains: PlanetRow[] = [];
  const nameHit: PlanetRow[] = [];
  for (const p of all) {
    if (p.naturalId.toUpperCase().startsWith(upper)) {
      idPrefix.push(p);
      continue;
    }
    if (p.naturalId.toUpperCase().includes(upper)) {
      idContains.push(p);
      continue;
    }
    if (p.name.toLowerCase().includes(lower)) {
      nameHit.push(p);
    }
  }
  return [...idPrefix, ...idContains, ...nameHit].slice(0, 30);
});

function pick(p: PlanetRow) {
  model.value = p.naturalId;
  query.value = p.naturalId;
  open.value = false;
}

// Keep `query` in sync if the model is changed from outside. We only
// overwrite the visible text when the input isn't focused, otherwise
// we'd stomp on the player's typing.
watch(
  () => model.value,
  next => {
    if (document.activeElement !== inputEl.value) {
      query.value = next;
    }
  },
);

function onFocus() {
  open.value = true;
  activeIndex.value = 0;
  void nextTick(updateDropdownPosition);
}

function onInput() {
  // PrUn's AddressSelector accepts lowercase naturalIds but is
  // case-insensitive on lookup. We keep the player's casing for
  // display purposes and uppercase only when committing to JSON.
  model.value = query.value.trim();
  open.value = true;
  activeIndex.value = 0;
  void nextTick(updateDropdownPosition);
}

// Position the dropdown beneath the input via `position: fixed` so
// it escapes any `overflow: hidden` ancestor (PrUn's FormComponent
// sometimes clips overlays).
const dropdownStyle = ref<CSSProperties>({ display: 'none' });

function updateDropdownPosition() {
  if (inputEl.value === undefined) {
    return;
  }
  const rect = inputEl.value.getBoundingClientRect();
  dropdownStyle.value = {
    position: 'fixed',
    top: `${rect.bottom}px`,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 240)}px`,
  };
}

function onScroll() {
  if (open.value) {
    updateDropdownPosition();
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!open.value) {
      open.value = true;
      return;
    }
    activeIndex.value = Math.min(activeIndex.value + 1, candidates.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
  } else if (e.key === 'Enter') {
    if (open.value) {
      const pickItem = candidates.value[activeIndex.value];
      if (pickItem !== undefined) {
        e.preventDefault();
        pick(pickItem);
      }
    }
  } else if (e.key === 'Escape') {
    open.value = false;
  }
}

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('scroll', onScroll, true);
  void nextTick(() => inputEl.value?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('scroll', onScroll, true);
});
</script>

<template>
  <div ref="rootEl" :class="$style.root">
    <input
      ref="inputEl"
      v-model="query"
      type="text"
      :class="$style.input"
      :placeholder="model || '搜索行星...'"
      :aria-label="`地址 naturalId`"
      autocomplete="off"
      spellcheck="false"
      @focus="onFocus"
      @input="onInput"
      @keydown="onKeyDown" />
    <Teleport to="body">
      <ul v-if="open && candidates.length > 0" :class="$style.dropdown" :style="dropdownStyle">
        <li
          v-for="(p, idx) in candidates"
          :key="p.naturalId"
          :class="[$style.option, idx === activeIndex ? $style.active : null]"
          @mousedown.prevent="pick(p)"
          @mouseenter="activeIndex = idx">
          <span :class="$style.ticker">{{ p.naturalId }}</span>
          <span :class="$style.name">{{ p.name }}</span>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style module>
.root {
  position: relative;
  flex: 1;
}

.input {
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  padding: 2px 4px;
  font-family: inherit;
  font-size: inherit;
  text-transform: uppercase;
}

.input:focus {
  outline: none;
  border-color: #66afe9;
}

.dropdown {
  z-index: 10000;
  margin: 0;
  padding: 2px;
  list-style: none;
  background: #1e1e1e;
  border: 1px solid #555;
  border-radius: 2px;
  max-height: 260px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.option {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 6px;
  cursor: pointer;
  font-size: 11px;
}

.option:hover {
  background: rgba(255, 255, 255, 0.05);
}

.option.active {
  background: rgba(102, 175, 233, 0.25);
}

.ticker {
  font-family: monospace;
  font-weight: bold;
  color: #f0ad4e;
  min-width: 64px;
}

.name {
  color: #ccc;
}
</style>
