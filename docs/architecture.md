# Architecture

Browser extension for Prosperous Universe. Intercepts the game's WebSocket and DOM to enhance the APEX terminal interface.

Stack: TypeScript, Vue 3, Vite (content scripts), CSS Modules. Package manager: pnpm.

## Path Aliases

| Alias | Resolves to |
|-------|-------------|
| `@src/*` | `src/*` |
| `~/*` | `src/assets/*` |

---

## Dependency Layers

```
features/  ──→  core/  ──→  infrastructure/  ──→  utils/
   │                              │                  ▲
   │                              ▼                  │
   └──────────────────────→   store/   ──────────────┘
```

Do not import upward (e.g. no `infrastructure` → `features` imports).

---

## Build Targets & Startup Sequence

Three Vite content scripts run in order:

1. **`refined-prun-prepare.ts`** (`document_start`) — Serializes PrUn app scripts to pause game loading until socket proxies are injected.
2. **`refined-prun-startup.ts`** (content script) — Loads user data from `chrome.storage.local`, injects CSS and main script as page-level `<script>` elements.
3. **`refined-prun.ts`** (page context) — Imports shell, utils, all features, then calls `main()`.

Important: the extension only uses the lightweight context scripts at the startup, and the main part is injected as a page-level `<script>` element. This allows the extension to work in the page context, instead of a content script sandbox.

Check **`src/main.ts`** for runtime startup orchestration.

### Passing payloads to the injected page script

`refined-prun-startup.ts` injects the main module via a page-level `<script type="module" src="…">` and needs to hand it a runtime config (`userData`, `version`, `url.*`). **Do not put both `src` and `textContent` on the same `<script>` element.** Per the HTML spec a `<script>` with `src` ignores inline content, and in practice some browsers clear the `textContent` property once the module starts executing — `getElementById(id).textContent` then returns `""` and `JSON.parse` throws `Unexpected end of JSON input`. Instead, write the payload into a sibling `<script type="application/json" id="…">` and have the page module read it from there. See `src/infrastructure/shell/config.ts` and the `configScript` block in `src/refined-prun-startup.ts`.

---

## Source Layout

```
src/
├── infrastructure/             # See "Infrastructure Details" below
│   ├── prun-api/               # WebSocket interception & reactive data stores
│   ├── prun-ui/                # DOM interaction (C, tiles, applyCssRule)
│   ├── storage/                # chrome.storage.local relay (page ↔ content script)
│   ├── fio/                    # FIO REST API (rest.fnar.net) + local fallback
│   └── shell/                  # Extension bootstrap (config, deserialize)
├── store/
│   └── user-data.ts            # userData reactive object — all persisted prefs
├── features/
│   ├── feature-registry.ts     # features.add(), features.init()
│   ├── basic/                  # All users. Features are imported in basic/index.ts
│   ├── advanced/               # FULL mode only. Features are imported in advanced/index.ts
│   └── XIT/                    # Custom tile commands. Import in XIT/index.ts
├── components/                 # Shared Vue components
├── utils/                      # Pure utilities (no game/extension deps)
├── core/                       # Domain logic
└── hooks/                      # Vue composition hooks
```

---

## Infrastructure Details

### `prun-api/` — Game Data

Intercepts socket.io WebSocket. Messages flow:
```
Game Server → socket.io WebSocket
  → socket-io-middleware.ts (intercept)
    → api-messages.ts (dispatch by message type)
      → 30+ entity stores (createEntityStore pattern)
        → features consume via .getById(), .all, .fetched
```

**Entity stores** (in `data/`) are created with `createEntityStore()`. Each provides:
- `.all` — `Ref<Entity[] | undefined>` (undefined until first fetch)
- `.fetched` — `Ref<boolean>`
- `.getById(id)` — reactive lookup

Stores reset on `CLIENT_CONNECTION_OPENED` (reconnect).

To get a list of all entity stores, list the files in `prun-api/data/`.

The stores listen for api messages:
```ts
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
onApiMessage({ SOME_MESSAGE_TYPE(data) { /* ... */ } });
```

### `prun-ui/` — DOM Layer

- **`C`** (`prun-css.ts`) — Object of runtime CSS class names parsed from PrUn's hashed stylesheets. E.g. `C.TileFrame.frame`. Available globally (auto-import).
- **`tiles`** (`tiles.ts`) — Tracks active game tiles. `tiles.observe('CMD', cb)` fires `cb(tile)` for every tile matching the command. `tile` has `.command`, `.parameter`, `.frame`, `.anchor`.
- **`showBuffer(cmd)`** (`buffers.ts`) — Opens a new game floating buffer programmatically with the provided command.
- **`applyCssRule`** (`refined-prun-css.ts`) — Injects CSS rules, optionally scoped to a command.

### `fio/` — FIO REST API

External data source at `rest.fnar.net`. Known limitations:
- Habitation buildings (HB1–HB5, HBB, HBC, HBM, HBL) return all workforce fields as 0. Use game API `buildOptions.workforceCapacities` or hardcoded fallback for actual capacities.
- Extraction buildings (EXT, RIG, COL) return a single empty placeholder recipe (`=>`). Real extraction recipes are planet-specific; use FIO `/planet/{id}` resources + `materialsStore.getById()` to map `MaterialId` → ticker, or game API `productionTemplates` if the user has a base.
- Planet resources: `{MaterialId (hash), ResourceType (MINERAL|LIQUID|GASEOUS), Factor (0–1 concentration)}`. ResourceType maps to building: MINERAL→EXT, LIQUID→RIG, GASEOUS→COL.

### `storage/` — Persistence

User settings live in `userData` (`src/store/user-data.ts`), a reactive object auto-synced to `chrome.storage.local` via a `postMessage` relay between page and content script contexts.

#### User Data Migrations

Migrations (`user-data-migrations.ts`) run on every load to transform stored data to the current schema. New migrations go at the **top** of the list. A legacy versioned system (`user-data-versioned-migrations.ts`) exists for old data — do not add to it.

---

## Auto-Imports (no explicit import needed)

| Symbol | Source |
|--------|--------|
| Vue composables (`ref`, `computed`, `reactive`, `watch`, …) | `vue` |
| `$`, `$$`, `_$`, `_$$` | `@src/utils/select-dom` |
| `C` | `@src/infrastructure/prun-ui/prun-css` |
| `subscribe` | `@src/utils/subscribe-async-generator` |
| `tiles` | `@src/infrastructure/prun-ui/tiles` |
| `features` | `@src/features/feature-registry` |
| `xit` | `@src/features/XIT/xit-registry` |
| `config` | `@src/infrastructure/shell/config` |
| `createFragmentApp` | `@src/utils/vue-fragment-app` |
| `applyCssRule` | `@src/infrastructure/prun-ui/refined-prun-css` |

---

## Feature Development

See `docs/feature-patterns.md` for all patterns (registration, tiles, DOM helpers, CSS, data stores, formatting).

---

## Automation Triggers (`features/basic/automation-triggers/`)

Event-driven ACT execution. Two event source kinds (`event-sources.ts`):

- **Alert sources** (arrival / supplies low / production finished): watch `alertsStore` for new alerts, dedup by `alert.id`. Edge-triggered by nature. Alert `data` key-value pairs (e.g. `registration`, `planet.address`) provide filter fields.
- **Condition sources** (building condition / interval): evaluated every 60 s, **level + cooldown** semantics — fire while true once cooldown (min 15 min, stored in `TriggerData.cooldownMin`) has elapsed since `lastRun`. No edge tracking needed.

Execution modes per trigger: `CONFIRM` (desktop notification; click executes) and `AUTO` (execute immediately, gated by the global `userData.settings.triggers.autoEnabled`, default off, with a ToS warning in the panel — see the "user click" hard rule in `docs/contributing.md`).

### Cross-feature execution handoff

Tile state (`user-data-tiles.ts`) is keyed by tile id, which cannot be known before a window opens — **do not use it for feature→window handoff**. Instead, `features/XIT/ACT/trigger-queue.ts` provides a module-level reactive queue: the engine pushes a `PendingTriggerRun` and calls `showBuffer('XIT ACT_<name>')`; `ExecuteActionPackage.vue` watches the queue for its package name and auto-starts (preview → execute). Queue entries expire after 60 s.

### ACT action/step registration recap

New action types must be added to the `ActionType` union in `src/store/user-data.types.d.ts` (plus any action-specific fields on `ActionData`). Steps register via `act.addActionStep` (execution logic), actions via `act.addAction` (Edit.vue must `defineExpose({ validate, save })`; `EditAction.vue` clears all keys of the action object before `save()` repopulates it). Import the action module in `ACT.ts`.
