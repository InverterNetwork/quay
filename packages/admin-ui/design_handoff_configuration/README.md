# Handoff — Quay Configuration UI

A design handoff package for a Claude Code session implementing the Quay configuration interface in React.

## Overview

This is the **Configuration** surface for [Quay](https://github.com/lafawnduh1966/quay), an autonomous-engineering operations layer. Operators use it to manage:

- **Global** (deployment-wide) settings: tick / supervisor knobs, adapter wiring, the agent invocation registry, default agents + models, default worker / reviewer preambles, default tag vocabulary.
- **Per-repo** settings: the repo's identity (URL, base branch, install / test commands) plus *overrides* of the global defaults for agents, prompts, and tags.

The interface is built on a single architectural commitment: **two scopes only — Global and Per-repo — using the same field vocabulary**. Task-level overrides (`quay enqueue --worker-agent …`) exist in the underlying system but are operational, not configuration; they do **not** appear in this UI.

## Scope of this handoff

**In scope:**
- Build the entire Configuration page (left rail + per-scope form views).
- Implement all field states, modals, and drawers shown.
- Wire up local React state — dirty tracking, validation, draft / save flows.
- Use stub data that matches the shapes shown in the mockup.

**Out of scope:**
- Real integration with the Quay backend / `quay` CLI / `~/.quay/config.toml`. Stub the data layer behind a clean interface; the integration is a follow-up.
- Mission Control, Task Detail, Review, and the other Quay screens — those exist in earlier design iterations but are not part of this delivery.

## About the design files

The HTML files in this bundle are **design references**, not production code. They render React via in-browser Babel and use a pan/zoom design canvas to show all screens side-by-side — that's a presentation device, not how the production app is structured.

**Your task is to recreate the configuration UI in a fresh React app using modern patterns** (Vite + React 18 or 19, CSS variables for tokens, plain CSS or CSS Modules — no need for a heavy styling library). The JSX in `hifi-shared.jsx`, `hifi-config-v2.jsx`, and `hifi-config-v2-gaps.jsx` is a faithful reference for component structure, props, and styling; lift it as a starting point and clean it up for production (extract inline styles to CSS Modules or styled-components per your team's preference, add proper accessibility attributes, etc.).

**Fidelity: high.** Match the spacing, typography, and color exactly. The tokens in `hifi.css` are the source of truth.

## How to view the reference

Open `Quay Configuration v2.html` in a browser. You'll see a design canvas with the following artboards:

**Section: Global**
- `Global · Settings` — the long sectioned form (the primary surface)
- `Global · Resolved across repos` — matrix view (secondary tab on Global)

**Section: Per-repo · acme-orders**
- `acme-orders · Settings` — the per-repo form

**Section: States & flows**
- `Reference · Field states` — every state of every field (default / hover / focused / dirty / error / disabled / inherits / overrides / empty) plus chip and toggle states
- `Preamble edit drawer` — side drawer for editing a preamble
- `Save-preview modal` — confirmation before persisting changes
- `Add-repo dialog` — modal for registering a new repo
- `Archive confirm` — destructive confirmation
- `Empty state · zero repos` — fresh deployment

Each artboard can be opened fullscreen by clicking it.

## Information architecture

```
Configuration
│
├─ Left rail (240px, always visible)
│   ├─ Scope: Global
│   ├─ ─── Registered repos ───
│   │   ├─ acme-orders  · 5 active · hermes_codex_browser · 4 overrides
│   │   ├─ acme-api     · 3 active · inherits             · 1 override
│   │   ├─ acme-web     · 3 active · claude               · 2 overrides
│   │   └─ acme-mobile  · 1 active · inherits             · 0 overrides
│   ├─ ─── Archived (collapsed)
│   └─ Format: [Form · TOML]  — view toggle at bottom (not implemented in v1)
│
├─ Main area (depends on selected scope)
│
└─ Sticky save footer (when dirty)
```

The left rail is **the only navigation**. Selecting Global or a repo swaps the main area.

## Screens

### 1) Global · Settings

**Purpose:** Edit deployment-wide defaults. Most operators land here.

**Layout:**
- Top bar (56px, full width) — wordmark, breadcrumb (`prod / configuration / Global`), sync indicator, `⌘K` search, avatar.
- Left rail (240px) — see above.
- Main area:
  - Header (24px / 28px padding) — title `Global`, badge `defaults for 4 repos`, segmented control switching between `Settings` and `Resolved across repos`, `Export TOML` button. Below: file path + resolution source + version, all in mono small color `ink-3`.
  - Long form (padding 32px / 28px) with anchor TOC on the right.
  - Sticky save footer (when dirty).

**Sections** (in vertical order, each prefixed with a 2-digit number in `mono` style):

1. **01 · Operations** — `tick · supervisor · claims · paths`. Five sub-groups in `SectionCard`s:
   - **Concurrency** (2 fields): `MAX_CONCURRENT`, `MAX_CONCURRENT_REVIEWERS`
   - **Budgets** (2 fields): `RETRY_BUDGET`, `MAX_NON_BUDGET_RESPAWNS`
   - **Live-worker thresholds** (4 fields): `MAX_ATTEMPT_DURATION`, `STALENESS_THRESHOLD`, `MAX_SPAWN_FAILURES`, `SUPERVISOR_LOCK_STALE`
   - **Claims** (2 fields): `CLAIM_TIMEOUT`, `MAX_CLAIM_EXPIRATIONS`
   - **Paths** (3 fields, 3-column): `DATA_DIR`, `REPOS_ROOT`, `WORKTREE_ROOT`
   
   All fields are `source="global-only"` with a small "global-only" chip below.

2. **02 · Adapters** — three cards for `Linear`, `Slack`, `GitHub reviewer`. Each card has an enable toggle on the title row, then a status row `StatusDot tone="good"` + "env set on running tick" (`tone="warn"` + missing-env warning when the env var isn't set). Inside: env-var name and other adapter-specific fields (workspace, max thread messages, etc.).

3. **03 · Agent registry** — list of invocations. Each invocation card has:
   - Mono name + role badges (worker / reviewer) + capability chips (browser, screenshots)
   - Usage stats: "N repos · M live tasks"
   - The spawn command in a `surface-2` mono block, wrapped to fit
   - Right-side `More` (`···`) icon for actions

4. **04 · Default agents** — Worker / Reviewer sub-groups, each with `AGENT` and `MODEL` fields.

5. **05 · Default prompts** — three sub-components:
   - **Worker preamble** `PreambleCard`: title row with version badge + `kind=code` chip + last-edited + `Versions` button + `Edit` button. Body shown in mono in a `surface-2` block with a fade-out gradient at the bottom (max-height 220px). Footer row: bytes / lines + "USED BY" + chips listing 4 repos + an accent override chip.
   - **Reviewer preamble** `PreambleCard` (same shape).
   - **Attempt-guidance templates** — a card containing a 2-column grid of 5 template chips. Each chip: mono reason name, version badge, refs count, 2-line clamped body. Header row has `+ New reason` button.

6. **06 · Default tags** — deployment-wide namespaces. Each namespace row: mono name, `REQUIRED` badge if required, "inherited by 4 repos · 2 repos extend" hint, removable value chips, `+ value` chip.

**Right-side TOC** (184px, sticky `top: 24px`):
- Anchor list of the 6 sections
- Active section indicator: 2px accent-colored left border

**Save footer** (sticky bottom, `warn-soft` background, `warn-line` border-top):
- Yellow status dot
- `1 unsaved change` (count and label adapt)
- Summary text in mono small
- `Discard` / `Preview diff` / `Save changes` buttons (preview opens the save modal)

---

### 2) Global · Resolved across repos

**Purpose:** Cross-repo audit — "which repos override the worker model?", "how much does acme-orders deviate from defaults?". Secondary view, accessed via the `Settings | Resolved across repos` segmented control next to the page header.

**Layout:**
- Same top bar + left rail as Global.
- Header identical to Global, except the segmented control is set to `Resolved across repos`.
- Toolbar row (10px / 28px): filter chips `All keys · 8` (selected, accent), `Overrides only · 7`, `Group: domain ▾`. Right side: legend showing the override-cell sample and the "↑ inherits" prefix.
- Matrix:
  - Header row: `KEY` · `GLOBAL DEFAULT` · 4 repo columns · `···` actions column
  - Each repo column header: repo name (mono, bold) + active task count (mono small)
  - Rows grouped by domain (AGENTS / PROMPTS / TAGS) — group separator: `paper-2` background, caption label, bottom and top hairlines.
  - Each row: key (label + mono key-name) · default value · 4 repo cells · actions.
  - **Cell rendering:**
    - Empty (no value, no global): em-dash, faded.
    - Inherited (no per-repo value): `↑ {global_value}` in `ink-3`, italic.
    - Override (per-repo value set): `accent-soft` background, accent-colored top + bottom borders, the value in mono, an `override` badge.
- Footer: none. The Resolved view is read-only.

---

### 3) Per-repo · acme-orders · Settings

**Purpose:** Edit one repo's settings. Most fields show how they relate to the global default.

**Layout:**
- Top bar with breadcrumb `prod / configuration / acme-orders`.
- Left rail with `acme-orders` selected.
- Header:
  - Repo icon + repo name (mono, h1)
  - `ACTIVE` good-dot badge + `5 ACTIVE TASKS` accent badge
  - `GitHub` link + `Archive repo` danger button
  - Sub-line: URL · bare clone path · created date · "N overrides from Global"
- Long form with anchor TOC.

**Sections:**

1. **01 · Overview** — single card with 4-column grid of read-only stats: `Active tasks`, `Base branch`, `Last sync`, `Created`. Each stat: caption label + h3 mono value + small detail line.

2. **02 · Identity & checkout** — `repo-only · no global equivalent`. Two sub-groups:
   - **Source**: `REPO_URL` (full row), `REPO_ID`, `BASE_BRANCH`. All `repo-only`.
   - **Build**: `PACKAGE_MANAGER`, `TEST_CMD`, `INSTALL_CMD` (full row, possibly dirty), `CI_WORKFLOW`, `CONTRIBUTION_GUIDE`. All `repo-only`.

3. **03 · Agents** — `overrides global default for this repo · task may further override at enqueue`. Two sub-groups:
   - **Worker**: `AGENT`, `MODEL` — shown as `source="override"` with the old global value displayed in the chip ("overrides global · was claude").
   - **Reviewer**: `AGENT`, `MODEL` — shown as `source="inherits"` with the global key path ("inherits global · from [agents].reviewer").

4. **04 · Prompts** — `inherit · extend · replace · per kind`. **This section has a side-by-side layout: cards on the left, composed preview on the right (~360px).**
   - **Worker preamble card** with a 3-way segmented control `Inherit | Extend | Replace`, currently `Extend`. Body shows the extension content (acme-orders local conventions) in mono surface-2 block. Footer: bytes / rules count, `Versions (2)` button, `Edit` button.
   - **Reviewer preamble card** with the same segmented control, currently `Inherit`. No body block — instead a small explanatory paragraph: *"No override. This repo uses the global reviewer preamble (v5) verbatim. Edit it in Global › Default prompts."*
   - **Composed preview** (a special pane, ~360px wide, full height of the section): see "Composed preview" component below.

5. **05 · Tags** — `extends deployment vocab`. Card containing:
   - "PER-REPO NAMESPACES · 2 · editable" caption
   - Per namespace: mono name + REQUIRED badge if required + a `required` toggle on the right, then removable value chips + `+ value`
   - Dashed divider with "inherited from global · read-only here" note
   - Dimmed read-only namespaces from the global vocab below

**Save footer** as on Global.

---

### 4) Preamble edit drawer

**Trigger:** Clicking `Edit` on any `PreambleCard`.

**Layout:**
- Background: dimmed page (`rgba(14,14,12,0.4)` overlay with light blur).
- Drawer slides in from the right, 720px wide, full viewport height.
- `paper` background, 1px `line` left border, big drop shadow (`0 -12px 32px rgba(14,14,12,0.18)`).

**Drawer structure:**
- Header (padding 16px / 22px, bottom hairline):
  - Title row: `Anchor` icon + `Worker preamble` (h2) + version badge + `global` chip + `kind=code` chip + `✕` close button on the right
  - Sub-line: `preambles.preamble_id=3` · `247 attempts reference this version` · last-edited
- Sub-tabs (padding 0 / 22px, bottom hairline): `Edit · Diff vs v2 · Versions · Used by`. Active tab gets a 2px ink-colored bottom border.
- Body (flex 1, split):
  - **Left**: editor pane (padding 14px / 22px). Wrapped in a `surface` card with a `surface-2` toolbar showing the filename and a "● editing" indicator. Editor itself: line numbers in `ink-4` mono small, content in mono with bullet emphasis on rule lines.
  - **Right**: versions rail (220px, `paper` background, left hairline). "VERSIONS · 3 · append-only" header, then a vertical timeline with version pips (22×22 circles, `accent-soft` for current, `surface` for past). For each version: author, current badge (if applicable), timestamp, message, ref count.
- Footer (padding 12px / 22px, top hairline, `paper-2` background):
  - Stats: tokens count + bytes
  - Buttons (right): `Discard` (ghost) / `Save as draft` (secondary) / `Publish v4 →` (primary)

---

### 5) Save-preview modal

**Trigger:** Clicking `Preview diff` in the sticky save footer.

**Layout:**
- Background: dimmed page (intensity 0.45).
- Centered modal, 820px wide, max-height ~720px.
- `paper` background, `line` border, `r-xl` (14px) radius, deep shadow.

**Modal structure:**
- Header (padding 16px / 22px, bottom hairline):
  - Title row: `Review changes` (h2) + `Global` accent badge + `3 fields` warn small badge
  - Right: `esc to close` hint
  - Sub-line: 1-line summary of what saving does
- Body (padding 20px, scrollable up to ~540px):
  - "CHANGES" caption
  - For each change: a `surface` card with:
    - Header: mono field name + scope outline badge
    - 3-column grid: before-box (danger-soft / danger-line) → arrow → after-box (good-soft / good-line)
  - "EQUIVALENT CLI" caption
  - Dark terminal block (`#0E0E0C` bg, mono small text in `#A39C8E`) with the equivalent `quay …` commands
  - "IMPACT" caption
  - 2-column grid:
    - NEW TASKS card: how new enqueues will see the change
    - EXISTING TASKS · N card: highlighted with `warn-soft` background — preserved snapshots
- Footer (padding 14px / 22px, top hairline, `paper-2`):
  - Left: utility chips (`Copy CLI`, `Download patch.json`)
  - Right: `Cancel` (ghost) / `Apply 3 changes` (primary)

---

### 6) Add-repo dialog

**Trigger:** Clicking `+ Register repo` in the left rail (or `Register repo` button on the empty state).

**Layout:**
- Background dimmed.
- Centered modal, 620px wide.

**Structure:**
- Header: `Register a new repo` (h2) + small sub-line about inherited defaults.
- Body: form fields stacked.
  - `REPO_ID` — focused state by default
  - `REPO_URL` — full row
  - `BASE_BRANCH` / `PACKAGE_MANAGER` — 2 columns
  - `INSTALL_CMD` — full row with "autofilled from package_manager" hint
  - `TEST_CMD` — full row
  - **Inherits-from-global notice** — `accent-soft` background card with a Sparkle icon, listing the defaults this repo will inherit (worker, reviewer, tag vocab).
- Footer: left side `runs: quay repo add` mono hint; right side `Cancel` / `Register and clone` buttons.

---

### 7) Archive confirm

**Trigger:** Clicking the `Archive repo` button in the per-repo header.

**Layout:**
- Background dimmed harder (0.5).
- Centered modal, 540px wide.

**Structure:**
- Title: `Archive acme-orders?` with a danger-colored alert icon.
- Body: explanation of consequences (active tasks continue, no new tasks spawn, reversible).
- Type-to-confirm input field — focused, danger-bordered, validates as user types the repo name. Show green check icon when matched.
- Footer: `Cancel` (ghost) / `Archive repo` (danger).

---

### 8) Empty state · zero repos

**Trigger:** Fresh deployment, no repos registered.

**Layout:**
- Same shell (top bar + left rail).
- Left rail shows "REGISTERED REPOS · 0" and a dashed-border CTA card: "No repos yet. Register one to start enqueueing tasks." + `Register repo` button.
- Main area:
  - Header: `Welcome to Quay` instead of `Global`, with version chip on the right
  - Centered card (600px wide) titled `STEP 1 · Register your first repo` with a 1-paragraph explanation, `Register repo` primary button, `View CLI equivalent` ghost button, divider, then "OR EDIT GLOBAL DEFAULTS FIRST" with chip links to the Global form sections.

---

### 9) Reference · Field states

**Purpose:** Pure developer reference (no in-app navigation to this). Shows every visual state of every interactive element.

**Includes:**
- 9 field state cards: default · hover · focused · dirty · error · disabled · inherits global · overrides global · empty
- 4 collection state cards: default chip row · adding (inline input) · 3-way segmented · toggle on/off
- Field-level interaction rules listed in plain prose

Use this as the spec for `Field` component states.

## Interactions & behavior

### Field editing

- **Read-only by default.** Click a field → focused/editing state (1.5px accent border + 3px accent-soft halo + caret).
- **Inline-edit applies to:** text, numbers, paths, short strings (`< 80 chars`).
- **Drawer-edit applies to:** commands (mono, long), preamble bodies, markdown.
- **Validation on blur.** Invalid → error border (`danger`) + danger halo + inline error message below the field with an Alert icon.
- **Esc reverts** the focused field's edit, leaving the prior value.
- **Cmd/Ctrl+Enter** triggers `Save changes` globally.
- Per-field save buttons do **not** exist — all saves are batched at the page level.

### Save model

1. Edit fields freely → fields become `dirty` (warn-soft background, warn left bar, warn-ink chip).
2. Sticky save footer appears with a count + summary + buttons.
3. User clicks `Preview diff` → save-preview modal opens.
4. User clicks `Apply N changes` in the modal → changes commit, modal closes, footer disappears.
5. Server (in the stub) returns success/error; on error, leave fields dirty and surface the error.

### Drawer + modal behavior

- Both can be dismissed by `Esc` or by clicking the dimmer backdrop (configurable per-modal; destructive modals **do not** dismiss on backdrop click).
- Only one drawer/modal at a time.
- Drawer animates in from the right; modal fades + scales (0.96 → 1.0) over 160ms ease-out.
- Focus is trapped within the drawer/modal while open; restored to the trigger on close.

### Empty/loading states

- **Empty (no repos):** dedicated screen shown above.
- **Loading (initial fetch):** stub for v1 — render the shell + a skeleton over the form (light gray blocks at the heights of each section card).
- **Error (system error fetching config):** banner at the top of the main area, `danger-soft` background, with a retry button.

### Accessibility

- All interactive elements reachable by `Tab` in logical order: top bar → left rail → main form → save footer.
- Arrow keys navigate inside the left rail's repo list.
- All form fields have associated `label` elements (caption above the field).
- All icons have `aria-hidden="true"` if decorative, or `aria-label` if meaningful.
- Status dots have `aria-label` describing their meaning ("env set on running tick" / "env var missing").
- Modals use `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing to their title.
- The drawer uses `role="dialog"` too.
- Color is never the only signal — every status pip has accompanying text.

### Responsive

The mockups are built at **1480px**. The intended responsive behavior:
- **≥ 1280:** full layout as shown.
- **1024–1280:** TOC moves above the form (collapsible accordion) instead of sticky right.
- **< 1024:** left rail becomes a slide-in drawer; TOC disappears entirely; form becomes single-column.
- Modals always center; the drawer becomes full-width below 720px.

You do not need to implement < 1024 for v1; build at desktop, add a `min-width: 1024px` warning if needed.

## State management

For v1, use **local React state** with `useState` / `useReducer`. No external state library required.

A reasonable shape:

```ts
type ConfigScope = 'global' | { repo: string };
type ScopeData = { /* the form fields for that scope */ };
type ConfigState = {
  scope: ConfigScope;
  baseline: ScopeData;   // last-saved snapshot
  draft: ScopeData;      // current edits
  dirtyFields: Set<string>;
  validation: Record<string, string | null>;
};
```

- `dirtyFields` is derived from `baseline` vs `draft`; recompute on every edit.
- `validation` is recomputed on blur.
- The save-preview modal reads from `dirtyFields` to construct its diff list.

Stub the data layer behind a single hook:

```ts
function useConfigStore(scope: ConfigScope): {
  data: ScopeData;
  save: (draft: ScopeData) => Promise<void>;
  reset: () => void;
}
```

For v1, `save` just `setTimeout`s and returns OK. The follow-up will replace this with a real Quay API client.

## Design tokens

All tokens live in `hifi.css`. **Use the CSS variables directly** in your styles — don't hard-code hex values.

### Colors

**Ink scale** (text + lines):
```
--ink:    #0E0E0C   /* primary text */
--ink-2:  #38342C   /* secondary text */
--ink-3:  #6B655B   /* muted text, captions */
--ink-4:  #A39C8E   /* placeholder, disabled */
--ink-5:  #C9C2B2   /* divider, dashed */
```

**Surfaces**:
```
--paper:     #FAF8F4   /* page background */
--paper-2:   #F4F0E5   /* page section bg */
--surface:   #FFFFFF   /* card background */
--surface-2: #F7F3EA   /* card subdued bg */
--surface-3: #EFEADE   /* card deepest bg */
```

**Lines**:
```
--line:    #E8E2D3
--line-2:  #D6CFBD
--line-3:  #BBB29D
```

**Accent (Harbor blue)** — OKLCH-defined:
```
--accent:        oklch(0.46 0.085 232)
--accent-hover:  oklch(0.40 0.090 232)
--accent-soft:   oklch(0.94 0.025 232)
--accent-line:   oklch(0.82 0.040 232)
--accent-ink:    oklch(0.28 0.080 232)
```

**State colors** (good · warn · danger), each with `-soft`, `-line`, `-ink` variants. See `hifi.css` for full values.

**Dark mode**: every token has a `[data-mode="dark"]` override. The page sets `document.documentElement.dataset.mode = 'dark'` (or `'light'`) at the root.

### Type

```
--sans:  'General Sans', 'Söhne', -apple-system, 'Segoe UI', system-ui, sans-serif;
--mono:  'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
--serif: 'Instrument Serif', 'Times New Roman', Times, serif;
```

Type scale (defined in `hifi-shared.jsx`'s `T` component):
- `display`   — 56 / 1.05 / 400 / italic / -0.025em (Instrument Serif)
- `h1`        — 32 / 1.18 / 600 / -0.022em
- `h2`        — 22 / 1.25 / 600 / -0.018em
- `h3`        — 16 / 1.35 / 600 / -0.012em
- `h4`        — 14 / 1.4  / 600 / -0.005em
- `body`      — 14 / 1.5  / 400
- `body-sm`   — 13 / 1.5  / 400
- `body-strong` — 14 / 1.5 / 500
- `small`     — 12 / 1.45 / 400
- `caption`   — 11 / 1.4 / 500 / +0.04em uppercase
- `mono`      — 12 / 1.5  / 400 (JetBrains Mono with ss01 + zero features)
- `mono-sm`   — 11 / 1.4 / 400
- `mono-md`   — 13 / 1.5 / 400

### Radii

```
--r-xs: 3px
--r-sm: 5px
--r-md: 7px
--r-lg: 10px
--r-xl: 14px
```

### Shadows

```
--shadow-sm:  0 1px 0 rgba(14, 14, 12, 0.04)
--shadow-md:  0 1px 2px rgba(14, 14, 12, 0.06), 0 0 0 1px var(--line)
--shadow-pop: 0 8px 24px rgba(14, 14, 12, 0.08), 0 0 0 1px var(--line)
```

### Spacing

Use a **4px base grid**. Common values:
- Tight: 4, 6, 8
- Default: 10, 12, 14
- Section: 16, 20, 24
- Page: 28, 32, 40, 48, 56

## Component inventory

The reference exports these from `hifi-shared.jsx`:

| Component | Purpose | Key props |
|---|---|---|
| `QuayMark` / `QuayWordmark` | Logo + wordmark | `size`, `color` |
| `T` | Typography element | `kind`, `as`, `color`, `style` |
| `Icon.*` | Lucide-style icons (1.5px stroke) | `size`, `style` |
| `Button` | Primary control | `variant: primary/secondary/ghost/accent/danger`, `size: sm/md/lg`, `leading`, `trailing`, `kbd` |
| `Kbd` | Keyboard shortcut chip | — |
| `Badge` | Status pill | `tone: neutral/accent/good/warn/danger`, `variant: soft/outline/solid`, `size`, `dot` |
| `Chip` | Tag / filter chip | `tone`, `selected`, `interactive`, `leading`, `trailing`, `onRemove` |
| `StatusDot` | Tonal dot, optional pulse | `tone`, `pulse`, `size` |
| `BudgetMeter` | N-of-M visual meter | `used`, `total`, `tone` |
| `Avatar` | Initials avatar | `name`, `size`, `tone` |
| `Input` | Text input shell | `value`, `placeholder`, `leading`, `trailing`, `size`, `invalid` |
| `Toggle` | Boolean switch | `checked`, `label`, `tone` |
| `Segmented` | Multi-option selector | `value`, `options`, `onChange` |
| `Divider` | Hairline | `vertical`, `dashed` |
| `HStack` / `VStack` | Flex helpers | `gap`, `align`, `justify`, `wrap` |
| `Card` | Surface container | `padding`, `raised`, `accent` |

And in `hifi-config-v2.jsx`:

| Component | Purpose |
|---|---|
| `CV2TopBar` | Configuration top bar (scope-aware) |
| `CV2LeftRail` | Left navigation (Global + repos) |
| `CV2Section` | Numbered section header + body |
| `CV2SubGroup` | Card within a section with grid layout |
| `CV2Field` | The core form field — handles `source` (override/inherits/repo-only/global-only), `dirty`, `mono`, `fullRow`, `suffix` |
| `CV2Toc` | Anchor TOC for long forms |
| `CV2SaveFooter` | Sticky save footer |
| `CV2PreambleCard` | Read-view of a preamble (Global) |
| `CV2GlobalScreen` | The full Global page |
| `CV2RepoScreen` | The full Per-repo page |
| `CV2MatrixScreen` | The Resolved across repos view |
| `CV2ComposedPreview` | The composed-prompt preview pane |

And in `hifi-config-v2-gaps.jsx`:

| Component | Purpose |
|---|---|
| `CV2PreambleDrawerScreen` | Preamble editor (overlay over Global) |
| `CV2SaveModalScreen` | Save-preview modal |
| `CV2FieldStates` | Field states reference page |
| `CV2ArchiveConfirmScreen` | Archive confirm dialog |
| `CV2AddRepoScreen` | Add repo dialog |
| `CV2EmptyScreen` | Zero-repos empty state |
| `CV2Dimmer` | Reusable backdrop overlay |

## Build recommendations

1. **Start with Vite + React 18 + TypeScript.**
2. **Port `hifi.css` as-is** — it's already framework-agnostic.
3. **Re-implement primitives** (`Button`, `Badge`, `Chip`, etc.) as proper components with `forwardRef`, ARIA attributes, and CSS Modules. Use the reference JSX as your spec.
4. **Build screens** in this order:
   - Shell (TopBar + LeftRail + outlet)
   - Global form (all 6 sections)
   - Save modal + sticky footer (the save loop)
   - Per-repo form (most fields reuse Global)
   - Composed-preview pane
   - Preamble edit drawer
   - Remaining flows: add-repo, archive confirm, empty state
   - Matrix view
5. **Stub data** behind a `useConfigStore` hook. Match the sample shapes in `hifi-config-v2.jsx` (`CV2_REPOS`, `CV2_INVOCATIONS`, etc.).
6. **Validate** against `Reference · Field states` for every interactive control.

## Assets

External:
- **General Sans** — Fontshare: `https://api.fontshare.com/v2/css?f[]=general-sans@200,300,400,500,600,700`
- **JetBrains Mono** — Google Fonts
- **Instrument Serif** — Google Fonts

No image assets. All icons are inline SVG (Lucide-style) defined in `hifi-shared.jsx`'s `Icon` namespace.

## Files in this bundle

| File | Purpose |
|---|---|
| `README.md` | This document |
| `Quay Configuration v2.html` | Interactive reference — open in a browser |
| `hifi.css` | Design tokens (CSS variables) |
| `hifi-shared.jsx` | Primitive component library |
| `hifi-config-v2.jsx` | Page-level components for Global / Repo / Matrix |
| `hifi-config-v2-gaps.jsx` | Drawer, modals, empty state, field states reference |
| `design-canvas.jsx` | The pan/zoom canvas used by the reference HTML — **not** part of the production UI; only needed to view the mockup |
| `tweaks-panel.jsx` | Light/dark toggle for the reference HTML — **not** part of the production UI |

## What to ask the designer if blocked

This handoff intentionally avoids over-specifying. If you hit a decision that isn't covered here, sensible defaults are fine — but the topics most likely to need a designer review are:

1. **Inline-edit interaction details** (does a click open a popover or transform the field in place?). The mockup shows the focused state; the entry animation is open.
2. **The "Diff vs v2" sub-tab in the preamble drawer.** Currently shown as inactive; the actual diff rendering needs design.
3. **The "Used by" sub-tab.** Same — listed but not designed.
4. **TOML view mode** (toggle at the bottom of the left rail). Declared in the UI but not designed.
5. **Mobile / < 1024 layout.** Out of scope for v1 but flag if business needs change.
