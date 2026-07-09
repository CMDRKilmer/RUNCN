function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.MessageList.messages), messages => {
    subscribe($$(messages, C.Link.link), processLink);
  });
}

function processLink(element: HTMLElement) {
  const link = element.textContent;
  if (!link || !isSafeImage(link)) {
    return;
  }

  const style = {
    maxHeight: '300px',
    maxWidth: '90%',
  };

  createFragmentApp(() => (
    <>
      <br />
      <img src={link} alt="Chat image" style={style} />
    </>
  )).appendTo(element.parentElement!);
}

function isSafeImage(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return /\.(jpg|jpeg|png|webp|avif|gif|svg)$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function init() {
  tiles.observe(['COMG', 'COMP', 'COMU'], onTileReady);
}

features.add(import.meta.url, init, '在包含图片链接的聊天消息中显示图片。');
