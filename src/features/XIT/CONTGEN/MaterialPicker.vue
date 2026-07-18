<script setup lang="ts">
// Material ticker picker with client-side fuzzy search. Replaces a
// plain <input> where the player would have to type the exact ticker
// (or memorize localized names). Filters across both the ticker and
// the localized material name so Chinese, English and ticker prefixes
// all match. Falls back to free text when nothing matches so we don't
// accidentally swallow typos.

import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { CSSProperties } from 'vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';

const model = defineModel<string>({ required: true });

const query = ref(model.value);
const open = ref(false);
const activeIndex = ref(0);
const rootEl = ref<HTMLDivElement>();
const inputEl = ref<HTMLInputElement>();

// Filter the materials list against the current query. We match:
//   1. Ticker prefix (case-insensitive) — best UX, matches what the
//      user types in PrUn's own selectors
//   2. Localized name contains the query (substring)
//   3. Bare ticker contains the query (substring, for mid-string typos)
// The first bucket wins so ticker-prefix matches rank above fuzzy
// name matches, mirroring PrUn's own listbox behaviour.
const candidates = computed(() => {
  const all = materialsStore.all.value ?? [];
  const q = query.value.trim();
  if (q.length === 0) {
    // Show a curated shortlist when the field is empty but focused, so
    // the user has somewhere to start. We pick a handful of the most
    // common categories first, falling back to the head of the list.
    return all.slice(0, 12);
  }
  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const prefix: PrunApi.Material[] = [];
  const nameHit: PrunApi.Material[] = [];
  const tickerHit: PrunApi.Material[] = [];
  for (const m of all) {
    if (m.ticker.toUpperCase().startsWith(upper)) {
      prefix.push(m);
      continue;
    }
    const name = getMaterialName(m) ?? m.name;
    if (name.toLowerCase().includes(lower)) {
      nameHit.push(m);
      continue;
    }
    if (m.ticker.toUpperCase().includes(upper)) {
      tickerHit.push(m);
    }
  }
  return [...prefix, ...nameHit, ...tickerHit].slice(0, 30);
});

function displayName(m: PrunApi.Material): string {
  return getMaterialName(m) ?? m.name;
}

function pick(m: PrunApi.Material) {
  model.value = m.ticker;
  query.value = m.ticker;
  open.value = false;
}

// Keep `query` in sync if the model is changed from outside (e.g.
// loading from workspace). We only overwrite the visible text when the
// input isn't focused, otherwise we'd stomp on the player's typing.
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
}

function onInput() {
  model.value = query.value.trim().toUpperCase();
  open.value = true;
  activeIndex.value = 0;
  // Recompute dropdown position on each keystroke — the input might
  // shift width (e.g. due to layout changes) or the player might
  // resize the window between characters.
  void nextTick(updateDropdownPosition);
}

// Position the dropdown beneath the input. We use `position: fixed`
// instead of `absolute` to escape any `overflow: hidden` ancestor
// (PrUn's FormComponent sometimes clips overlays), and recompute from
// the input's bounding rect on every relevant change.
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
    width: `${Math.max(rect.width, 220)}px`,
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

// Close the dropdown when the player clicks outside the picker.
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
      :placeholder="model || '搜索材料...'"
      :aria-label="`材料 ticker`"
      autocomplete="off"
      spellcheck="false"
      @focus="onFocus"
      @input="onInput"
      @keydown="onKeyDown" />
    <Teleport to="body">
      <ul v-if="open && candidates.length > 0" :class="$style.dropdown" :style="dropdownStyle">
        <li
          v-for="(m, idx) in candidates"
          :key="m.ticker"
          :class="[$style.option, idx === activeIndex ? $style.active : null]"
          @mousedown.prevent="pick(m)"
          @mouseenter="activeIndex = idx">
          <span :class="$style.ticker">{{ m.ticker }}</span>
          <span :class="$style.name">{{ displayName(m) }}</span>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style module>
.root {
  position: relative;
  flex: 0 0 80px;
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
  min-width: 40px;
}

.name {
  color: #ccc;
}
</style>
