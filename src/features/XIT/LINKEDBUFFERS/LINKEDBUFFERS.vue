<script setup lang="ts">
import Header from '@src/components/Header.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PresetList from './PresetList.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { useTile } from '@src/hooks/use-tile';
import { userData } from '@src/store/user-data';
import { createId } from '@src/store/create-id';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { showBuffer, setBufferSize } from '@src/infrastructure/prun-ui/buffers';
import {
  UI_TILES_CHANGE_COMMAND,
  UI_WINDOWS_REQUEST_FOCUS,
} from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { changeInputValue } from '@src/util';
import { sleep } from '@src/utils/sleep';
import { isEmpty } from 'ts-extras';
import onNodeDisconnected from '@src/utils/on-node-disconnected';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const tile = useTile();
const parameters = useXitParameters();

const preset = computed(() => {
  if (isEmpty(parameters)) {
    return undefined;
  }
  const byId = userData.linkedBuffersPresets.find(x => x.id.startsWith(parameters[0]));
  if (byId) {
    return byId;
  }
  const name = parameters.join(' ');
  return userData.linkedBuffersPresets.find(x => x.name === name);
});

const inputText = ref('');
const isProcessing = ref(false);
const spawning = ref(false);

interface ChildWindow {
  window: HTMLDivElement;
  commandIndex: number;
  commandId: string;
}
const childWindows = ref<ChildWindow[]>([]);

const isFloating = tile.container.classList.contains(C.Window.body);

const DEFAULT_CHILD_WIDTH = 400;
const DEFAULT_CHILD_HEIGHT = 300;
const H_GAP = 15;
const V_GAP = 35;

onMounted(async () => {
  if (!isFloating || !preset.value) {
    return;
  }

  // Position control panel near top-left.
  const controlWindow = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
  if (controlWindow) {
    const saved = preset.value.controlPosition;
    if (saved) {
      controlWindow.style.left = `${saved[0]}px`;
      controlWindow.style.top = `${saved[1]}px`;
    } else {
      controlWindow.style.left = '30px';
      controlWindow.style.top = '50px';
    }
  }

  if (preset.value.commands.length > 0) {
    await spawnChildWindows();
  }
});

onBeforeUnmount(() => {
  closeAllChildren();
});

function getSavedLayout(commandId: string): UserData.LinkedBuffersChildLayout | undefined {
  return preset.value?.childLayouts?.find(l => l.commandId === commandId);
}

function getChildSize(commandId: string): [number, number] {
  const saved = getSavedLayout(commandId);
  if (saved) {
    return [saved.width, saved.height];
  }
  return [DEFAULT_CHILD_WIDTH, DEFAULT_CHILD_HEIGHT];
}

async function spawnChildWindows() {
  spawning.value = true;
  const commands = preset.value!.commands;
  const created: ChildWindow[] = [];

  for (let i = 0; i < commands.length; i++) {
    const window = await showBuffer(' ', { force: true, autoSubmit: false });
    const input = _$(window, C.PanelSelector.input) as HTMLInputElement | undefined;
    if (input) {
      changeInputValue(input, '');
    }
    const child: ChildWindow = {
      window: window as HTMLDivElement,
      commandIndex: i,
      commandId: commands[i].id,
    };
    created.push(child);

    onNodeDisconnected(window, () => {
      childWindows.value = childWindows.value.filter(c => c !== child);
    });
  }

  childWindows.value = created;
  layoutChildren();

  // Size each child window.
  for (const child of created) {
    const tileEl = _$(child.window, C.Tile.tile);
    if (tileEl) {
      const id = getPrunId(tileEl);
      if (id) {
        const [w, h] = getChildSize(child.commandId);
        setBufferSize(id, w, h);
      }
    }
  }

  dispatchClientPrunMessage(UI_WINDOWS_REQUEST_FOCUS(tile.id));
  spawning.value = false;
}

function layoutChildren() {
  const controlWindow = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
  if (!controlWindow) {
    return;
  }
  const rect = controlWindow.getBoundingClientRect();
  const count = childWindows.value.length;
  const hasSavedLayouts = preset.value?.childLayouts && preset.value.childLayouts.length > 0;

  for (let i = 0; i < count; i++) {
    const child = childWindows.value[i];
    const saved = getSavedLayout(child.commandId);
    const win = child.window;

    if (hasSavedLayouts && saved) {
      // Use saved position.
      win.style.left = `${saved.left}px`;
      win.style.top = `${saved.top}px`;
    } else {
      // Default grid layout: 2 columns when 3+ commands.
      const cols = count <= 2 ? count : 2;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const [w, h] = getChildSize(child.commandId);
      const left = rect.right + H_GAP + col * (w + H_GAP);
      const top = rect.top + row * (h + V_GAP);
      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
    }
  }
}

function closeAllChildren() {
  for (const child of childWindows.value) {
    if (child.window.isConnected) {
      const closeButton = _$$(child.window, C.Window.button).find(x => x.textContent === 'x');
      closeButton?.click();
    }
  }
  childWindows.value = [];
}

function resolveCommand(template: string) {
  return template.replace(/\{input\}/g, inputText.value.trim()).toUpperCase();
}

async function changeTileCommand(windowEl: HTMLDivElement, command: string, commandId: string) {
  const tileEl = _$(windowEl, C.Tile.tile) as HTMLElement | undefined;
  if (!tileEl) {
    return;
  }
  const id = getPrunId(tileEl)!;
  const [w, h] = getChildSize(commandId);

  const existingInput = _$(windowEl, C.PanelSelector.input) as HTMLInputElement | undefined;
  if (existingInput?.form?.isConnected) {
    changeInputValue(existingInput, command);
    existingInput.form.requestSubmit();
    await sleep(200);
    setBufferSize(id, w, h);
    return;
  }

  let message = UI_TILES_CHANGE_COMMAND(id, null);
  if (!dispatchClientPrunMessage(message)) {
    const changeButton = _$$(tileEl, C.TileControls.control).find(x => x.textContent === ':');
    if (changeButton) {
      changeButton.click();
    }
  } else {
    await sleep(0);
  }
  message = UI_TILES_CHANGE_COMMAND(id, command);
  if (!dispatchClientPrunMessage(message)) {
    const input = (await $(windowEl, C.PanelSelector.input)) as HTMLInputElement;
    changeInputValue(input, command);
    input.form!.requestSubmit();
  }
  await sleep(200);
  const newTileEl = _$(windowEl, C.Tile.tile) as HTMLElement | undefined;
  const newId = newTileEl ? getPrunId(newTileEl) : id;
  setBufferSize(newId ?? id, w, h);
}

async function onCommandClick(cmd: UserData.LinkedBuffersCommand, index: number) {
  if (!inputText.value.trim() || isProcessing.value) {
    return;
  }

  const resolved = resolveCommand(cmd.template);
  isProcessing.value = true;

  try {
    const child = childWindows.value.find(c => c.commandIndex === index);
    if (child?.window.isConnected) {
      await changeTileCommand(child.window, resolved, child.commandId);
    }
  } finally {
    isProcessing.value = false;
  }
}

function saveLayout() {
  if (!preset.value) {
    return;
  }

  // Save control panel position.
  const controlWindow = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
  if (controlWindow) {
    const rect = controlWindow.getBoundingClientRect();
    preset.value.controlPosition = [Math.round(rect.left), Math.round(rect.top)];
  }

  // Save child window positions and sizes.
  const layouts: UserData.LinkedBuffersChildLayout[] = [];
  for (const child of childWindows.value) {
    if (!child.window.isConnected) {
      continue;
    }
    const rect = child.window.getBoundingClientRect();
    layouts.push({
      commandId: child.commandId,
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  preset.value.childLayouts = layouts;
}

async function openEditor() {
  if (!preset.value) {
    return;
  }
  const window = await showBuffer(`XIT LB EDIT ${preset.value.id.substring(0, 8)}`);
  const tileEl = _$(window, C.Tile.tile);
  if (tileEl) {
    const id = getPrunId(tileEl);
    if (id) {
      setBufferSize(id, 500, 400);
    }
  }
}

function onCreateClick() {
  if (isEmpty(parameters)) {
    return;
  }
  const name = parameters.join(' ');
  userData.linkedBuffersPresets.push({
    id: createId(),
    name,
    commands: [],
  });
}
</script>

<template>
  <PresetList v-if="isEmpty(parameters)" />
  <div v-else-if="!preset" :class="$style.create">
    <span>{{
      getI18nValue('RP.LB.presetNotFound', `Preset "${parameters.join(' ')}" not found.`)
    }}</span>
    <PrunButton primary :class="$style.createButton" @click="onCreateClick">{{
      getI18nValue('RP.LB.createBtn', 'CREATE')
    }}</PrunButton>
  </div>
  <div v-else :class="$style.root">
    <Header>{{ preset.name }}</Header>
    <div :class="$style.inputSection">
      <label :class="$style.label">{{ getI18nValue('RP.LB.input', 'Input') }}</label>
      <input
        v-model="inputText"
        type="text"
        :class="$style.gameInput"
        autocomplete="off"
        data-1p-ignore="true"
        data-lpignore="true" />
    </div>
    <div v-if="spawning" :class="$style.status">{{
      getI18nValue('RP.LB.openingBuffers', 'Opening buffers...')
    }}</div>
    <table>
      <thead>
        <tr>
          <th>{{ getI18nValue('RP.LB.commands', 'Commands') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="preset.commands.length === 0">
          <td>{{ getI18nValue('RP.LB.noCommands', 'No commands.') }}</td>
        </tr>
        <template v-else>
          <tr
            v-for="(cmd, index) in preset.commands"
            :key="cmd.id"
            @click="onCommandClick(cmd, index)">
            <td :class="$style.commandCell">
              <span :class="[C.Link.link, $style.commandLink]">
                {{ resolveCommand(cmd.template) || cmd.template }}
              </span>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <ActionBar>
      <PrunButton primary @click="openEditor">{{
        getI18nValue('RP.LB.editCmds', 'EDIT CMDS')
      }}</PrunButton>
      <PrunButton primary @click="saveLayout">{{
        getI18nValue('RP.LB.saveLayout', 'SAVE LAYOUT')
      }}</PrunButton>
    </ActionBar>
  </div>
</template>

<style module>
.root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 4px;
  min-width: 0;
  overflow: hidden;
}

.inputSection {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  gap: 4px;
}

.label {
  white-space: nowrap;
  font-size: 0.9em;
}

.gameInput {
  width: 20ch;
  max-width: 20ch;
  box-sizing: border-box;
  padding: 3px 6px;
  background: #222e31;
  border: 1px solid #5a8a4a;
  color: #bfbfbf;
  font-family: inherit;
  font-size: inherit;
  text-transform: uppercase;
  text-align: left;
  outline: none;

  &:focus {
    border-color: #8cc63f;
  }
}

.commandCell {
  cursor: pointer;
  padding: 1px 4px;
  white-space: nowrap;
}

.commandLink {
  cursor: pointer;
}

.status {
  padding: 4px;
  opacity: 0.7;
}

.create {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.createButton {
  margin-top: 5px;
}
</style>
