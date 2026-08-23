<script setup lang="ts">
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import Header from '@src/components/Header.vue';

const { note } = defineProps<{ note: UserData.Note }>();

const $style = useCssModule();

const LINK_REGEXP = /\b(?:[a-zA-Z0-9]{1,3}\.(?:CI1|IC1|AI1|NC1|CI2|NC2))\b/g;

function parseSegments(text?: string) {
  if (!text) {
    return [];
  }

  if (text[text.length - 1] === '\n') {
    text += ' ';
  }

  const segments: { text: string; isLink: boolean }[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(LINK_REGEXP)) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isLink: false });
    }
    segments.push({ text: match[0], isLink: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isLink: false });
  }

  return segments;
}

const textbox = useTemplateRef<HTMLTextAreaElement>('textbox');
const overlay = useTemplateRef<HTMLPreElement>('overlay');

onMounted(() => {
  textbox.value!.addEventListener('scroll', () => {
    overlay.value!.scrollTop = textbox.value!.scrollTop;
    overlay.value!.scrollLeft = textbox.value!.scrollLeft;
  });
});

watch(
  () => note.text,
  async () => {
    await nextTick();
    const el = overlay.value;
    if (!el) {
      return;
    }

    // Clear existing content
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }

    const segments = parseSegments(note.text);
    for (const seg of segments) {
      if (seg.isLink) {
        const span = document.createElement('span');
        span.className = `${C.Link.link} ${$style.link}`;
        span.textContent = seg.text;
        span.addEventListener('click', () => {
          showBuffer(`CXPO ${seg.text}`);
        });
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(seg.text));
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <Header v-model="note.name" editable :class="$style.header" />
  <div :class="$style.header">{{ note.name }}</div>
  <div>
    <textarea ref="textbox" v-model="note.text" :class="$style.textarea" spellcheck="false" />
    <pre ref="overlay" :class="$style.overlay" />
  </div>
</template>

<style module>
.header {
  padding-top: 5px;
  margin-left: 10px;
  margin-bottom: 2px;
}

.textarea {
  color: transparent;
  background: transparent;
  caret-color: white;
  margin: 10px;
  padding: 10px;
  border: 0;
  width: calc(100% - 20px);
  height: calc(100% - 20px - 20px);
  position: absolute;
  top: 20px;
  left: 0;
  overflow-y: scroll;
  font-family: 'Droid Sans', sans-serif;
  font-size: 13px;
  line-height: 1.5;
  tab-size: 4;
  resize: none;
  z-index: 1;
}

.textarea:focus {
  outline: none;
}

.textarea::-webkit-scrollbar {
  width: 0;
}

.overlay {
  background-color: #42361d;
  color: #cccccc;
  margin: 10px;
  padding: 10px;
  border: 0;
  width: calc(100% - 20px);
  height: calc(100% - 20px - 20px);
  position: absolute;
  top: 20px;
  left: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  overflow-y: scroll;
  font-family: 'Droid Sans', sans-serif;
  font-size: 13px;
  line-height: 1.5;
  tab-size: 4;
}

.overlay::-webkit-scrollbar {
  width: 0;
}

.link {
  position: relative;
  z-index: 2;
}
</style>
