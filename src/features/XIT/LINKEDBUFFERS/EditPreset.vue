<script setup lang="ts">
import Header from '@src/components/Header.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { userData } from '@src/store/user-data';
import { createId } from '@src/store/create-id';
import { isEmpty } from 'ts-extras';
import { vDraggable } from 'vue-draggable-plus';
import { grip } from '@src/components/grip';
import GripCell from '@src/components/grip/GripCell.vue';
import GripHeaderCell from '@src/components/grip/GripHeaderCell.vue';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const rawParameters = useXitParameters();
// Parameters arrive as ["EDIT", "<presetId>", ...] — skip the "EDIT" prefix.
const parameters = rawParameters.slice(1);

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

function addCommand() {
  if (!preset.value) {
    return;
  }
  preset.value.commands.push({
    id: createId(),
    label: 'CMD',
    template: 'CMD {input}',
  });
}

function deleteCommand(cmd: UserData.LinkedBuffersCommand) {
  if (!preset.value) {
    return;
  }
  preset.value.commands = preset.value.commands.filter(x => x !== cmd);
}
</script>

<template>
  <div v-if="!preset" :class="$style.center">
    <span>{{ getI18nValue('RP.LB.presetNotFound', 'Preset not found.') }}</span>
  </div>
  <div v-else :class="$style.root">
    <Header>{{ getI18nValue('RP.LB.editPrefix', 'Edit: ') }}{{ preset.name }}</Header>
    <table>
      <thead>
        <tr>
          <GripHeaderCell />
          <th>{{ getI18nValue('RP.LB.label', 'Label') }}</th>
          <th>{{ getI18nValue('RP.LB.template', 'Template') }}</th>
          <th />
        </tr>
      </thead>
      <template v-if="preset.commands.length === 0">
        <tbody>
          <tr>
            <td colspan="4">{{ getI18nValue('RP.LB.noCommands', 'No commands.') }}</td>
          </tr>
        </tbody>
      </template>
      <template v-else>
        <tbody v-draggable="[preset.commands, grip.draggable]">
          <tr v-for="cmd in preset.commands" :key="cmd.id">
            <GripCell />
            <td>
              <input
                v-model="cmd.label"
                type="text"
                :class="[$style.gameInput, $style.labelInput]"
                autocomplete="off"
                data-1p-ignore="true"
                data-lpignore="true" />
            </td>
            <td>
              <input
                v-model="cmd.template"
                type="text"
                :class="[$style.gameInput, $style.templateInput]"
                autocomplete="off"
                data-1p-ignore="true"
                data-lpignore="true" />
            </td>
            <td>
              <PrunButton danger @click="deleteCommand(cmd)">{{
                getI18nValue('RP.LB.delete', 'DELETE')
              }}</PrunButton>
            </td>
          </tr>
        </tbody>
      </template>
    </table>
    <ActionBar>
      <PrunButton primary @click="addCommand">{{
        getI18nValue('RP.LB.addCommand', 'ADD COMMAND')
      }}</PrunButton>
    </ActionBar>
    <div :class="$style.hint">{{
      getI18nValue(
        'RP.LB.reopenHint',
        'Close and reopen the LB control panel to apply layout changes.',
      )
    }}</div>
  </div>
</template>

<style module>
.root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.center {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gameInput {
  box-sizing: border-box;
  padding: 3px 6px;
  background: #222e31;
  border: 1px solid #5a8a4a;
  color: #bfbfbf;
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  outline: none;

  &:focus {
    border-color: #8cc63f;
  }
}

.labelInput {
  width: 10ch;
}

.templateInput {
  width: 20ch;
}

.hint {
  padding: 4px;
  opacity: 0.5;
  font-size: 0.9em;
}
</style>
