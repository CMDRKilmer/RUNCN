// CONTD 合同草案详情：把原生「条件」SectionHeader 与下一行的「选择模板」按钮
// 视觉上合并到同一水平行，消除两者之间的垂直留白。
//
// 背景/约束：
// - 「条件」标题是 ScrollView 下的 SectionHeader，与紧随其后的 Draft__form
//   （内含「选择模板」ActionBar）是兄弟容器，跨容器无法纯 CSS 选中目标标题。
// - 不能移动「选择模板」按钮节点：contd-auto-fill 依赖它在原 form 内定位点击。
// - 因此只加 data 标记，实际重排交给 refined-prun.css：把 form 上移使按钮行
//   进入标题行，再用 padding 补回让条件表头位置不变。React 重绘只重建节点，
//   subscribe 会在新节点上重新打标记，幂等。
const TITLE_MARK = 'data-rp-cond-title';
const FORM_MARK = 'data-rp-cond-form';
const SEND_FORM_MARK = 'data-rp-send-form';
const SEND_ROW_MARK = 'data-rp-send-row';
const SEND_BTN_MARK = 'data-rp-send-btn';
const SEND_TITLE_MARK = 'data-rp-send-title';
const SEND_RECIPIENT_MARK = 'data-rp-send-recipient';

function markConditionHeader(tile: PrunTile) {
  if (!tile.parameter) {
    return;
  }
  subscribe($$(tile.anchor, C.SectionHeader.container), header => {
    const text = header.textContent?.trim();
    if (text === '发送合同草案') {
      header.setAttribute(SEND_TITLE_MARK, 'true');
      return;
    }
    if (text !== '条件') {
      return;
    }
    header.setAttribute(TITLE_MARK, 'true');
    // 紧随标题的兄弟 form 就是含「选择模板」按钮的条件表单。
    // 不用 class token 匹配（运行时哈希类名可能变化），改为按内容判定。
    // 按钮可能是异步渲染的，用 rAF 重试几帧直到出现。
    let attempts = 0;
    const tryMark = () => {
      const form = header.nextElementSibling;
      if (form !== null && form.textContent?.includes('选择模板')) {
        form.setAttribute(FORM_MARK, 'true');
        return;
      }
      if (attempts++ < 20 && header.isConnected) {
        requestAnimationFrame(tryMark);
      }
    };
    tryMark();
  });

  // 「发送合同草案」区块：只给相关节点打 data 标记，实际布局交给 refined-prun.css。
  // 相关 form 按内容（含「接收方」+「发送」）定位，避免依赖运行时哈希类名。
  //
  // 关键约束：**绝不移动任何 DOM 节点**。标题、按钮、行都是 React 渲染的；
  // React 卸载/重绘时按原父子关系调用 removeChild，一旦节点被 prepend/append
  // 到别处就会抛 NotFoundError，导致整个 CONTD tile「部件渲染失败」（点击
  // 「选择模板」触发重绘时必现）。标题的 data-rp-send-title 标记在上方
  // SectionHeader 订阅里已打，这里只处理 form 内的行与按钮。
  subscribe($$(tile.anchor, C.Draft.form), form => {
    if (!form.textContent?.includes('接收方') || !form.textContent?.includes('发送')) {
      return;
    }
    if (form.hasAttribute(SEND_FORM_MARK)) {
      return;
    }
    form.setAttribute(SEND_FORM_MARK, 'true');
    let attempts = 0;
    const tryMark = () => {
      if (!form.isConnected) {
        return;
      }
      // 指令行：含「指令」label 且含「发送」按钮的 FormComponent 行。
      const rows = [...form.querySelectorAll<HTMLElement>('[class*="FormComponent__container"]')];
      const cmdRow = rows.find(
        r => r.textContent?.trim().startsWith('指令') && r.querySelector('button'),
      );
      const sendBtn = cmdRow?.querySelector<HTMLElement>('button');
      if (cmdRow !== undefined && sendBtn !== null && sendBtn !== undefined) {
        cmdRow.setAttribute(SEND_ROW_MARK, 'true');
        sendBtn.setAttribute(SEND_BTN_MARK, 'true');
        // 接收方行打标记，供 CSS 作为按钮定位包含块与整行布局目标。
        const recipient = form.querySelector<HTMLElement>(
          '[class*="FormComponent__containerActive"]',
        );
        recipient?.setAttribute(SEND_RECIPIENT_MARK, 'true');
        return;
      }
      if (attempts++ < 20) {
        requestAnimationFrame(tryMark);
      }
    };
    tryMark();
  });
}

function init() {
  tiles.observe('CONTD', markConditionHeader);
}

features.add(
  import.meta.url,
  init,
  'CONTD：合并「条件」标题与「选择模板」按钮行；将「发送」按钮移到接收方框右侧并隐藏指令行。',
);
