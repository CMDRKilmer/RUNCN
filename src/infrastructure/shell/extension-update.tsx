import { fetchJson } from '@src/utils/fetch';

if (import.meta.env.PROD) {
  const container = document.getElementById('container')!;
  const manifestUrl = config.url.manifest;
  // Skip the update poll entirely if the manifest URL is not a real
  // extension URL. Chrome yields chrome-extension://..., Firefox and
  // Gecko-based browsers yield moz-extension://...
  const isExtensionUrl =
    typeof manifestUrl === 'string' &&
    (manifestUrl.startsWith('chrome-extension://') || manifestUrl.startsWith('moz-extension://'));
  if (!isExtensionUrl) {
    console.warn('refined-prun: skipping extension update check, invalid manifest URL');
  } else {
    let consecutiveFailures = 0;
    const id = setInterval(async () => {
      let manifest: chrome.runtime.ManifestV3;
      try {
        manifest = (await fetchJson(manifestUrl)) as chrome.runtime.ManifestV3;
      } catch {
        // Stop polling after persistent failures so we don't spam the
        // console with net::ERR_FAILED every second.
        if (++consecutiveFailures >= 3) {
          clearInterval(id);
        }
        return;
      }
      consecutiveFailures = 0;
      if (!manifest.version || config.version === manifest.version) {
        return;
      }
      void setTimeout(() => window.location.reload(), 3000);
      clearInterval(id);
      if (C.Connecting === undefined) {
        // There might be a case where PrUn CSS was not parsed yet.
        return;
      }
      createFragmentApp(() => (
        <div class={[C.Connecting.processing, C.Connecting.overlay]} style={{ zIndex: '999999' }}>
          <span class={[C.Connecting.message, C.fonts.fontRegular, C.type.typeLarger]}>
            Reloading Refined PrUn...
          </span>
        </div>
      )).appendTo(container);
    }, 1000);
  }
}
