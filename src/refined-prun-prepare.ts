// This separate content script is required because it must be processed
// superfast, before the PrUn script gets the chance to load.
function prepare() {
  if (document.documentElement.classList.contains('refined-prun')) {
    return;
  }
  const observer = new MutationObserver(() => serializeScripts());
  observer.observe(document, { childList: true, subtree: true });
  const serializeScripts = () => {
    // Serialize app scripts to prevent PrUn loading before client-side proxies
    // are injected. The scripts will be attached back to head in the client script.
    for (const s of Array.from(document.head?.getElementsByTagName('script') ?? [])) {
      // Idempotency guard: a script without src was either already serialized
      // by another run/copy of this extension or was never loadable. Note that
      // URL('') resolves to the page host, so without this guard a second run
      // would wipe the serialized URL from textContent.
      if (s.getAttribute('src') === null || s.dataset.rpSerialized !== undefined) {
        continue;
      }
      let host = '';
      try {
        host = new URL(s.src, location.href).hostname;
      } catch {
        continue;
      }
      if (host === 'apex.prosperousuniverse.com') {
        s.dataset.rpSerialized = '1';
        s.dataset.rpType = s.type;
        // Mark as non-executing BEFORE moving the URL into text content, and
        // never assign src = '': an empty src resolves to the page URL and the
        // browser would execute the HTML document as a script.
        s.type = 'application/json';
        s.textContent = new URL(s.src, location.href).href;
        s.removeAttribute('src');
        observer.disconnect();
      }
    }
  };
  serializeScripts();
}

prepare();
