import { changeInputValue } from '@src/utils/dom';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getSystemLineFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sleep } from '@src/utils/sleep';

// 轮询条件直到成立或超时，返回是否成立
async function waitFor(condition: () => boolean, timeout = 5000, interval = 100): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(interval);
  }
  return false;
}

// The station store keys getByNaturalId by the station's OWN natural id
// ("MOR" for Moria Station), but the AddressSelector canonicalizes a picked
// station to its SYSTEM id ("OT-580") — resolving the form value needs a
// search by the address's system line instead.
export function findStationBySystemId(id: string) {
  const needle = id.toUpperCase();
  return stationsStore.all.value?.find(
    x => getSystemLineFromAddress(x.address)?.entity.naturalId.toUpperCase() === needle,
  );
}

// AddressSelector suggestions are rendered in #autosuggest-portal outside the
// tile DOM. Only one portal can be open at a time, so we search it directly.
// Typing fires a read-only NOMENCLATURE_QUERY_ADDRESSES lookup to the game
// server; selecting a suggestion is pure local form state.
export async function selectAddress(container: Element, locationName: string): Promise<boolean> {
  const input = _$(container, C.AddressSelector.input) as HTMLInputElement | undefined;
  const portal = document.getElementById('autosuggest-portal');
  if (!input || !portal) {
    return false;
  }

  // Bare station/system ids are un-typeable: a station suggestion renders as
  // "Moria Station (Moria)" — its id never appears as suggestion text, so a
  // pasted "OT-580" would only ever substring-match a moon like OT-580e.
  // Translate the id to the station name up front, looking up by system id
  // (what the form and exports hold) and by station id (a hand-written
  // "MOR"). Planet ids (OT-580b) do render in suggestions and pass through
  // untouched.
  const query =
    findStationBySystemId(locationName)?.name ??
    stationsStore.getByNaturalId(locationName)?.name ??
    locationName;

  // Hide the portal for the whole operation so the suggestion list never
  // flashes on screen during this silent background fill. Clicking the FLEET
  // row first triggers react-autosuggest's outside-click (closing the list),
  // then re-focusing the input re-renders it — without hiding, the user would
  // see the default list + search results pop up and vanish. Hiding via
  // visibility keeps the items queryable and clickable (React's handlers still
  // fire); the previous value is restored once we settle.
  const prevVisibility = portal.style.visibility;
  portal.style.visibility = 'hidden';
  try {
    // Native focus first so react-autosuggest opens the listbox, then let it
    // settle a frame before writing (empty-focus list renders immediately).
    input.focus();
    await sleep(50);
    changeInputValue(input, query);

    // The portal first renders a default list (own bases, warehouses, CX
    // stations) for the empty focus query, and the typed query's search results
    // only arrive after a server round-trip — so wait for an entry that actually
    // matches the name instead of clicking into the stale default list. Matching
    // requires a word boundary around the query, because natural ids prefix each
    // other ("OT-580b" is a prefix of nothing, but "OT-580" prefixes every moon
    // in the system, and the default list can hold several) — a boundary match
    // hits "Montem (OT-580b)" but not "OT-580br". Only when no boundary match
    // arrives within the timeout does a plain substring match get one shot,
    // keeping tolerance for odd human-entered fragments. No match at all leaves
    // the field for the user rather than guessing.
    const boundary = new RegExp(
      `(^|\\W)${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`,
      'i',
    );
    const suggestions = () => _$$(portal, C.AddressSelector.suggestionContent) as HTMLElement[];
    const findBoundaryMatch = () => suggestions().find(s => boundary.test(s.textContent ?? ''));
    await waitFor(() => !!findBoundaryMatch(), 5000);
    const match =
      findBoundaryMatch() ??
      suggestions().find(s => s.textContent?.trim().toLowerCase().includes(query.toLowerCase()));
    if (!match) {
      return false;
    }

    // Use the NATIVE .click(), not clickElement: react-autosuggest's
    // onSuggestionSelected listens for the trusted click that HTMLElement.click()
    // synthesizes. The full pointer/mouse sequence clickElement dispatches is
    // filtered out and leaves the item highlighted but unselected (see
    // docs/feature-patterns.md "Click recipe").
    match.click();
    return true;
  } finally {
    portal.style.visibility = prevVisibility;
  }
}
