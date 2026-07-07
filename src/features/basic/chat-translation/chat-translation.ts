import TranslateMessageButton from './TranslateMessageButton.vue';
import TranslateInputButton from './TranslateInputButton.vue';

function onTileReady(tile: PrunTile) {
  // Input translate button: one per channel controls bar.
  subscribe($$(tile.anchor, C.Channel.controls), () => {
    subscribe($$(tile.anchor, C.Channel.prompt), async prompt => {
      // The chat input is an <input> inside the prompt area.
      const input = await $(prompt, 'input');
      // 将翻译按钮放入输入框内部（通过绝对定位在父容器中实现）
      const parent = input.parentElement!;
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.position === 'static') {
        parent.style.position = 'relative';
      }
      createFragmentApp(TranslateInputButton, reactive({ input })).appendTo(parent);
    });
  });

  // Per-message translate button.
  subscribe($$(tile.anchor, C.MessageList.messages), messages => {
    subscribe($$(messages, C.Message.message), message => {
      // Skip system join/left messages — they have no translatable text.
      const system = _$(message, C.Message.system);
      if (system) {
        return;
      }
      const textEl = _$(message, C.Message.text);
      if (!textEl) {
        return;
      }
      const text = textEl.textContent ?? '';
      if (text.length === 0) {
        return;
      }
      createFragmentApp(TranslateMessageButton, reactive({ text, textElement: textEl })).appendTo(
        textEl.parentElement!,
      );
    });
  });
}

function init() {
  tiles.observe(['COMG', 'COMP', 'COMU'], onTileReady);
}

features.add(
  import.meta.url,
  init,
  'COMG/COMP/COMU: 为聊天消息和输入框添加显式触发的 AI 翻译按钮。',
);
