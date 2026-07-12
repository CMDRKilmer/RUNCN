import { parseSafeImage } from './parse-safe-image';

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

function init() {
  tiles.observe(['COMG', 'COMP', 'COMU'], onTileReady);
}

features.add(import.meta.url, init, '在包含图片链接的聊天消息中显示图片。');
