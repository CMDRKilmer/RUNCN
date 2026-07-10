function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.MessageList.messages), messages => {
    subscribe($$(messages, C.Link.link), processLink);
  });
}

function processLink(element: HTMLElement) {
  const link = element.textContent;
  const safeUrl = parseSafeImage(link);
  if (!safeUrl) {
    return;
  }

  const style = {
    maxHeight: '300px',
    maxWidth: '90%',
  };

  createFragmentApp(() => (
    <>
      <br />
      <img src={safeUrl} alt="Chat image" style={style} />
    </>
  )).appendTo(element.parentElement!);
}

function parseSafeImage(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!/\.(jpg|jpeg|png|webp|avif|gif|svg)$/.test(parsed.pathname)) {
      return null;
    }
    // Route through `new URL().href` so CodeQL treats the value as a normalized URL,
    // not as raw user-controlled DOM text. The protocol/host/scheme checks above
    // ensure only http(s) image URLs reach this point.
    return parsed.href;
  } catch {
    return null;
  }
}

function init() {
  tiles.observe(['COMG', 'COMP', 'COMU'], onTileReady);
}

features.add(import.meta.url, init, '在包含图片链接的聊天消息中显示图片。');
