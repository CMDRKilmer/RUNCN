// Helper that drives the "create a new contract draft and auto-fill
// it" flow end-to-end. Shared between CONTGEN.vue (form-driven
// generation) and ORG/utils.ts (task-driven generation): both
// produce a contract JSON, both want the same UX — a fresh draft
// opened in CONTD with the fields pre-filled.
//
// The flow is:
//
//   1. Park the JSON on the 'contgen-output' workspace key. The
//      contd-auto-fill feature reads this on every CONTD panel
//      mount, so it works regardless of whether a panel is already
//      open or we have to create one.
//
//   2. Make sure a CONTD list panel is open. We always use the
//      list view (no parameter) because the "新建" button lives
//      there — the detailed view (CONTD <naturalId>) only has the
//      per-draft editing tools.
//
//   3. Click PrUn's native "新建" button. This is the same button
//      a player would press; the server then pushes a
//      CONTRACT_DRAFTS_DRAFT message containing the new naturalId.
//
//   4. Wait for the new naturalId to appear in
//      contractDraftsStore. We snapshot the known IDs first so
//      we can distinguish "freshly created" from "already there
//      from a previous tab/session".
//
//   5. Switch the same list panel to the new draft's detailed
//      view. PrUn re-renders the panel in place, which causes
//      contd-auto-fill's onTileReady to inject the JSON auto-fill
//      panel and run the fill (it also auto-clicks the "填写"
//      button when it sees the contgen-output workspace key is
//      populated — see contd-auto-fill.ts).
//
// Why we don't dispatch a "create draft" client message directly:
// we don't know PrUn's private message name. Driving the UI keeps
// us on the supported path and survives future PrUn client
// changes that only ever adjust the button, not the protocol.

import { getTileState } from '@src/store/user-data-tiles';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import tiles from '@src/infrastructure/prun-ui/tiles';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { contractDraftsStore } from '@src/infrastructure/prun-api/data/contract-drafts';
import { clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';

// Localized text of the "New Draft" button on the CONTD list view.
// The in-game text is localized — only "新建" was confirmed in
// devtools. Other locales are best-effort: if a user sees nothing
// happen, the most likely cause is a missing entry here. We rely on
// the ActionBar position (not row <td> buttons) to disambiguate
// from the per-row "查看 / 复制 / 删除" buttons.
const NEW_DRAFT_LABELS = [
  '新建', // zh — confirmed in devtools
  'New Draft', // en
  'Neuer Entwurf', // de (likely)
  'Nouveau brouillon', // fr (likely)
  'Nuevo borrador', // es (likely)
];

// Returns the first button inside `actionBar` whose trimmed text
// matches a known "New Draft" label, or null if none is present.
function findNewDraftButton(actionBar: HTMLElement): HTMLButtonElement | null {
  for (const btn of Array.from(actionBar.querySelectorAll('button'))) {
    const text = (btn.textContent ?? '').trim();
    if (NEW_DRAFT_LABELS.includes(text)) {
      return btn;
    }
  }
  return null;
}

// Polls `produce()` until it returns a non-null/non-undefined value
// or the timeout elapses. Used to wait for DOM/store conditions
// after a DOM mutation we don't have a proper event for. Each poll
// re-evaluates `produce()` so we always see fresh data.
async function waitForStore<T>(
  produce: () => T | null | undefined,
  description: string,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value !== null && value !== undefined) {
      return value as T;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(50);
  }
}

export interface NewContractDraftResult {
  // The naturalId of the freshly-created draft (e.g. "CD-NRHS-7461").
  newNaturalId: string;
}

// Drives the "create a new contract draft and auto-fill it" flow.
// See the file header for the rationale. Throws on any failure —
// callers should be prepared to surface the error to the user.
//
// `json` is the contract JSON string that will be parked on the
// contgen-output workspace key. The auto-fill panel reads it on
// mount; the value is consumed and cleared by the consumer, so a
// second call without re-mounting the panel leaves the previous
// draft untouched.
export async function newContractDraftAndFill(json: string): Promise<NewContractDraftResult> {
  // Snapshot the naturalIds we already know about so we can detect
  // the freshly-created one when the server pushes the
  // CONTRACT_DRAFTS_DRAFT message.
  const knownNaturalIds = new Set<string>(
    (contractDraftsStore.all.value ?? []).map(d => d.naturalId),
  );
  // Park the JSON BEFORE opening the panel, because the consumer
  // reads the workspace key synchronously on SectionHeader mount
  // and clears it immediately. Writing later would race with the
  // mount and lose the value.
  const workspace = getTileState<{ json?: string }>('contgen-output');
  workspace.json = json;
  // Make sure a CONTD list panel is open. showBuffer focuses an
  // existing one or opens a new one — the call returns once the
  // Window div is mounted, but the TileFrame registration (which
  // populates activeTiles) happens in a microtask after the DOM
  // mutation. We poll for the tile to be ready.
  await showBuffer('CONTD');
  // tiles.find('CONTD') only matches tiles whose fullCommand is
  // exactly "CONTD" (no parameter) — i.e. the list view, not an
  // individual draft. We need that one because that's where the
  // "新建" button lives.
  const listTile = await waitForStore(
    () => tiles.find('CONTD').find(t => !t.docked),
    'CONTD 列表面板注册',
  );
  // The ActionBar (containing the "新建" button) is rendered by
  // React after the tile frame is mounted. Wait for it.
  const actionBar = await waitForStore(
    () => _$(listTile.anchor, C.ActionBar.container) as HTMLElement | null,
    'CONTD ActionBar',
  );
  const newBtn = await waitForStore(() => findNewDraftButton(actionBar), 'CONTD 「新建」按钮');
  await clickElement(newBtn);
  // The server pushes a CONTRACT_DRAFTS_DRAFT message containing
  // the new draft's naturalId. Watch the store for any naturalId
  // we haven't seen before.
  const newNaturalId = await waitForStore(() => {
    const fresh = (contractDraftsStore.all.value ?? []).find(
      d => !knownNaturalIds.has(d.naturalId),
    );
    return fresh?.naturalId ?? null;
  }, '新合同草稿 naturalId');
  // Switch the same list panel to the new draft's detailed view.
  // PrUn re-renders the panel in place, which causes
  // contd-auto-fill's onTileReady to inject the JSON auto-fill
  // panel and run the fill (and auto-click "填写" because the
  // contgen-output key was just populated by us).
  dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(listTile.id, `CONTD ${newNaturalId}`));
  return { newNaturalId };
}
