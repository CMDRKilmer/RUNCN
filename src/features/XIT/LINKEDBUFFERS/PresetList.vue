<script setup lang="ts">
import { showTileOverlay, showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import CreatePresetOverlay from './CreatePresetOverlay.vue';
import PrunButton from '@src/components/PrunButton.vue';
import ActionBar from '@src/components/ActionBar.vue';
import { showBuffer, setBufferSize } from '@src/infrastructure/prun-ui/buffers';
import { useTile } from '@src/hooks/use-tile';
import { userData } from '@src/store/user-data';
import { vDraggable } from 'vue-draggable-plus';
import { grip } from '@src/components/grip';
import GripCell from '@src/components/grip/GripCell.vue';
import GripHeaderCell from '@src/components/grip/GripHeaderCell.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { createId } from '@src/store/create-id';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const tile = useTile();
const isFloating = tile.container.classList.contains(C.Window.body);
if (isFloating) {
  setBufferSize(tile.id, 400, 300);
}

function createNew(ev: Event) {
  showTileOverlay(ev, CreatePresetOverlay, {
    onCreate: name => {
      const id = createId();
      userData.linkedBuffersPresets.push({
        id,
        name,
        commands: [],
      });
      return showBuffer(`XIT LB ${id.substring(0, 8)}`);
    },
  });
}

function confirmDelete(ev: Event, preset: UserData.LinkedBuffersPreset) {
  showConfirmationOverlay(
    ev,
    () => (userData.linkedBuffersPresets = userData.linkedBuffersPresets.filter(x => x !== preset)),
    {
      message: getI18nValue(
        'RP.LB.confirmDelete',
        'Are you sure you want to delete the preset "${name}"?',
      ).replace('${name}', preset.name),
    },
  );
}
</script>

<template>
  <ActionBar>
    <PrunButton primary @click="createNew">{{
      getI18nValue('RP.LB.createNew', 'CREATE NEW')
    }}</PrunButton>
  </ActionBar>
  <table>
    <thead>
      <tr>
        <GripHeaderCell />
        <th>{{ getI18nValue('RP.LB.name', 'Name') }}</th>
        <th>{{ getI18nValue('RP.LB.presetCount', 'Commands') }}</th>
        <th />
      </tr>
    </thead>
    <tbody v-draggable="[userData.linkedBuffersPresets, grip.draggable]">
      <tr v-for="preset in userData.linkedBuffersPresets" :key="preset.id">
        <GripCell />
        <td>
          <PrunLink inline :command="`XIT LB ${preset.id.substring(0, 8)}`">
            {{ preset.name }}
          </PrunLink>
        </td>
        <td>
          <span>
            {{ preset.commands.length }} {{ getI18nValue('RP.LB.commands', 'command')
            }}{{ preset.commands.length !== 1 ? 's' : '' }}
          </span>
        </td>
        <td>
          <PrunButton danger @click="confirmDelete($event, preset)">{{
            getI18nValue('RP.LB.delete', 'DELETE')
          }}</PrunButton>
        </td>
      </tr>
    </tbody>
  </table>
</template>
