<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import PrunButton from '@src/components/PrunButton.vue';

// Gap kept between the column label and the 加注燃料 button.
const buttonGap = 6;

const { showButton = true } = defineProps<{ showButton?: boolean }>();
const emit = defineEmits<{ refuel: [] }>();

const root = ref<HTMLElement>();
const label = ref<HTMLElement>();
const button = ref<HTMLElement>();
const fits = ref(false);

let observer: ResizeObserver | undefined;

onMounted(() => {
  observer = new ResizeObserver(measure);
  for (const element of [root.value, label.value, button.value]) {
    if (element !== undefined) {
      observer.observe(element);
    }
  }
  measure();
});

onUnmounted(() => observer?.disconnect());

// The button is taken out of flow so it never widens the column. It is only
// revealed when the header is wide enough to hold it beside the label.
function measure() {
  const rootElement = root.value;
  const labelElement = label.value;
  const buttonElement = button.value;
  if (rootElement === undefined || labelElement === undefined || buttonElement === undefined) {
    return;
  }
  fits.value =
    rootElement.clientWidth >= labelElement.offsetWidth + buttonGap + buttonElement.offsetWidth;
}
</script>

<template>
  <span ref="root" :class="$style.container">
    <span ref="label" :class="$style.label"><slot /></span>
    <span ref="button" :class="[$style.button, { [$style.hiddenButton]: !showButton || !fits }]">
      <PrunButton dark inline @click.stop="emit('refuel')">加注燃料</PrunButton>
    </span>
  </span>
</template>

<style module>
.container {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  white-space: nowrap;
}

.label {
  flex: 0 1 auto;
}

.button {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}

/* visibility (not display/v-if) so the button keeps a measurable width while
   hidden — that measurement is what decides when to show it again. */
.hiddenButton {
  visibility: hidden;
}
</style>
