# MAS-Orchestra **Refine**

## Backend

### Motivation

Today's MAS-Orchestra demo is one-shot:

```
problem → meta-agent → plan (DAG) → execute → answer
```

The user can only accept the plan or start over. In practice they want to
*keep most of the plan but change one thing* — drop a node, add a verifier,
swap CoT for Self-Consistency, re-wire an edge. Re-prompting the meta-agent
is non-deterministic and throws away everything already computed.

### Key Idea

After the plan (or after execution), offer the user three choices:

1. **Accept** — ship it.
2. **Direct Edit** — manually tweak the graph config (e.g., via a box).
3. **Revise** — chat with a strong LLM that proposes *structured graph edits*;
   user approves; we re-execute.

The revise path turns the meta-agent from a one-shot planner into an
**interactive graph designer**. The LLM is constrained to a small typed op
language so edits are safe and applicable:

- **Agent-level ops**: `Add`, `Remove`, `Merge`, `ReConfig`
- **Edge-level ops**: `ReConnect` (and its `Add` / `Remove` primitives)

New agents/tools come from an explicit **Catalogue**: the current built-in
archetypes (CoT, SC, Debate, Reflexion, WebSearch) + provider-native tools
(OpenAI / Anthropic built-ins like `web_search`, `code_interpreter`,
`computer_use`) + MCP-discovered tools + ad-hoc custom agents (system prompt + tool refs). The LLM can only propose things the system can actually execute.


## Frontend

The current `mas-orchestra-demo` frontend (React 18 + Vite + Tailwind +
React Flow) is functional but reads like a stock Tailwind scaffold —
gray/white palette, flat cards, default fonts, stages that replace each
other vertically. The goals below turn it into something that both
*looks* like a research-grade demo and *behaves* like an interactive
graph designer (aligned with the Refine direction above).

### 1. Layout that shows the pipeline, not hides it

The single most important change. Stages currently replace each other
(`input` → `plan` → `execute` → `result`), so context is lost as the
user advances. Instead, keep every stage on the page and stack them
**vertically** so the whole run reads as one scrollable document:

```
┌────────────────────────────────────────────────────┐
│  Input           (fully rendered, greyed out)      │
├────────────────────────────────────────────────────┤
│  Plan            (fully rendered, greyed out)      │
├────────────────────────────────────────────────────┤
│  Execute         ← current stage, fully lit        │
│     Graph + live agent outputs                     │
├────────────────────────────────────────────────────┤
│  Result          (not yet reached, dim placeholder)│
└────────────────────────────────────────────────────┘
```

Behavior:

- When the user advances a stage, the view **auto-scrolls** to the top
  of the new stage and that stage becomes the visually "active" one
  (full color, border accent, subtle spotlight).
- Previous stages stay fully rendered — no collapsing, no summaries —
  but are visually de-emphasized with a greyed-out / muted-color
  treatment (lower contrast text, desaturated badges, softer borders).
  The user can scroll up to review everything exactly as it was.
- Stages that have not been reached yet are dim / lightly-greyed so the
  pipeline shape is always legible as a whole.
- The `StepNav` becomes a sticky top progress rail that mirrors scroll
  position and jumps to a stage on click (anchor scroll).
- Graph + live outputs become the *body* of the Execute stage, so when
  the user hits Execute they naturally land on the running graph. No
  need for the wide-screen three-column split.

This keeps the implementation close to today's `App.tsx` (same four
stages, same state machine) — the change is rendering all of them
always and swapping "replace" for "grey out + scroll to active."


### 2. One progress bar for the whole run

Instead of a separate progress bar inside every stage, use a single
**sticky progress rail at the top of the page** with four segments —
one per stage — that together show the user where they are in the
whole pipeline:

```
Input ──●────── Plan ──●────── Execute ──○────── Result
 done           done           running            pending
```

- Each segment has three visual states: **done** (filled, muted
  accent), **current** (filled bright + animated pulse/shimmer),
  **pending** (outline only, grey).
- The current-stage segment carries a tiny inline status right next to
  its label so the bar itself communicates what's happening:
  - Plan: `Plan · generating…`
  - Execute: `Execute · 3 / 7 agents`
- Connector between segments visualizes *transition* progress:
  fully-filled between two done stages, half-filled between the last
  done stage and the current one, empty between pending stages.
- Clicking any completed segment anchor-scrolls to that stage (since
  previous stages are still on the page, greyed out).
- The rail doubles as the `StepNav` replacement — one component,
  always visible, no separate tab strip.

This avoids cluttering each stage with its own bar, and matches the
mental model of a 4-step pipeline: one bar, four dots, current one lit.

### 3. Visual identity — tokens

The current UI defaults to `bg-gray-50` + white cards + system fonts,
which is exactly what makes it feel generic. The fix is a concrete
design system, wired to CSS variables in `index.css` and a single
export of palette constants from `types/index.ts` so `App.tsx`,
`GraphViewer.tsx`, and `AgentOutputs.tsx` pull from one source (today
they hard-code slightly-different palettes).

**Color tokens** (dark by default; light variant swaps `--ink-*` for
off-whites):

```css
:root {
  /* surface */
  --ink-0: #07081a;   /* page base */
  --ink-1: #0b0f26;   /* body gradient stop */
  --ink-2: #121735;   /* card body */
  --ink-3: #1c2450;   /* card active */
  --line:  rgba(255,255,255,0.08);

  /* text */
  --text:  #e8ebff;
  --muted: #8791b8;
  --dim:   #4a527a;

  /* accents */
  --gold:   #e8b547;  /* primary "conductor" */
  --gold-2: #ffd27a;  /* highlight */
  --violet: #6f7bff;  /* supporting */
  --mint:   #59e3a7;  /* success */
  --rose:   #ff7a9c;  /* error */

  /* agents — single source of truth for badges, graph, legend */
  --cot:    #6ea8ff;
  --sc:     #b28bff;
  --debate: #ffb453;
  --reflex: #5be3b8;
  --web:    #ff7a9c;
}
```

**Typography** (from Google Fonts):

- Display — `Instrument Serif`, italic for hero and stage titles. Gives
  the page an editorial, research-paper feel that matches the project's
  academic framing.
- Body — `Manrope` 300–700. Warm humanist sans, readable at every size.
- Mono — `JetBrains Mono`. Used for agent IDs, durations, token counts,
  XML, the rail labels, and every metadata row.

Avoid `Inter` / `Roboto` / system fonts — they're what make the current
UI indistinguishable from generic dashboards.

### 4. The background, which is currently doing nothing

Replace flat `bg-gray-50` with a **layered, textured, subtly animated
background** applied once at the page level (fixed, behind everything):

1. Base gradient — vertical `linear-gradient(var(--ink-0), var(--ink-1), var(--ink-0))`.
2. Three large radial glows at low opacity, positioned asymmetrically:
   - warm gold bottom-left (`radial-gradient(1100px 800px at 15% 95%, rgba(232,181,71,0.22), transparent 60%)`)
   - cool violet top-right (`… 90% 5%, rgba(111,123,255,0.20)`)
   - faint mint center (`… 50% 60%, rgba(91,227,184,0.08)`)
3. A 32 × 32 dotted mesh (`radial-gradient(circle at 1px 1px, …)`)
   with a slow `drift` animation (40s linear infinite,
   `background-position` 0 → 320 160) so the page breathes without
   being distracting.
4. A very low-opacity SVG noise/grain layer on top (`feTurbulence`
   fractal noise) with `mix-blend-mode: overlay` for film-grain
   texture, preventing banding in the gradients.

The effect is "stage before the performance" — quiet, dark,
anticipatory — not an empty spreadsheet. Light-mode variant keeps the
same recipe but with off-white bases (`#f6f5ee` / `#eae9df`) and
reduced-opacity glows so it still has texture, not a plain color fill.

Cards sit *above* this background as **glassy translucent surfaces**:

```css
.stage {
  background: linear-gradient(180deg,
    rgba(255,255,255,0.04),
    rgba(255,255,255,0.015));
  border: 1px solid var(--line);
  border-radius: 20px;
  backdrop-filter: blur(10px) saturate(140%);
}
```

### 5. Sticky header with an animated DAG wordmark

The header is the first thing people see; replace the plain `<h1>` with:

- A 34 × 34 SVG wordmark on the left: a 3-node micro-DAG (two parents,
  one child) whose three edges are `stroke-dasharray` paths animated
  with staggered `flow` keyframes so data appears to pulse through the
  graph on a ~2.6s loop. It visually previews the whole product in one
  glyph.
- Wordmark text in `Instrument Serif` italic (`MAS · Orchestra`) with
  a mono sub-tag (`redesign mock` / page subtitle) underneath.
- The sticky **4-segment rail** described in §2 fills the remaining
  width. Backdrop-blur + translucent dark background so it floats over
  the drifting background mesh.

### 6. Stage cards — done / current / pending

Every stage is one card with a consistent skeleton:

```
┌──────────────────────────────────────────────┐
│  01 · INPUT            [status chip / time]  │  ← tag-row
│                                              │
│  Problem title in italic serif               │  ← h2
│                                              │
│  mono meta · mono meta · mono meta           │  ← summary
│                                              │
│  ── stage-specific body ──                   │
└──────────────────────────────────────────────┘
```

Visual states:

- **Done** — `opacity: 0.42`, desaturated badges, muted text. A small
  green `✓ accepted` / `✓ 5 agents · 6 edges · 2.1s` chip replaces the
  live status. Hover lifts opacity to ~0.75 so scrolling up feels
  interactive without fully re-lighting.
- **Current** — full opacity, amber-tinted gradient
  (`rgba(232,181,71,0.08) → rgba(111,123,255,0.04)`), amber border
  (`rgba(232,181,71,0.35)`), and a soft drop-shadow glow
  (`0 30px 80px -20px rgba(232,181,71,0.18)`). `h2` rendered in
  `--gold-2` so the eye lands on it immediately.
- **Pending** — `opacity: 0.28` and **dashed** border, so it reads as
  "placeholder" rather than "content." Body shows a centered
  placeholder: a mono caption line above, a faded italic serif line
  below (`the final answer will land here`).

Stage-specific bodies from the mock:

- **Input (done)** — serif italic problem text with a 2px gold left
  border; a row of mint `chip` pills showing the readiness checklist
  (`problem ✓ / mode ✓ / model ✓`); a mono meta row (DoM, model,
  char count). While active, chips light up as fields are filled;
  when done they freeze green.
- **Plan (done)** — 2-column grid of `agent-row` cards, each showing
  agent ID, colored type badge, and one-line description. Inline mono
  summary bar above shows the meta-agent sub-steps that already
  completed (`calling meta-agent ✓ · streaming reasoning ✓ · parsing
  XML ✓ · building DAG ✓`), freezing in "all green" state.
- **Execute (current)** — see §7.
- **Result (pending)** — see §8.

### 7. Execute stage — graph + outputs

Two equal columns inside the active stage card:

**Graph panel (left)**
- `340px` tall, own rounded container with its own subtle dotted
  background and a faint violet top-glow.
- Nodes are absolutely-positioned mono cards (`type` line small and
  colored by agent kind, `id` line bold) rather than default React
  Flow nodes. Three state styles:
  - `done` — mint left-mark dot + desaturated mint border.
  - `running` — amber `0 0 0 3px / 0 0 26px` glow that pulses
    (`nodepulse` keyframes, 1.6s), plus a blinking amber dot next to
    the ID.
  - `pending` — `opacity: 0.5`, dashed border.
- Edges are SVG paths with three styles: solid mint for `done`, dashed
  amber with running `dash` keyframes (stroke-dashoffset scroll) for
  edges leading into a `running` node, and faint dashed grey for
  `pending`. This makes the data flow read at a glance.
- Floating legend in the bottom-right: tiny mono chips
  (`CoT SC Debate Reflexion Web`) with matching swatches. Everyone
  gets the colors "for free" the first time they look.

**Outputs panel (right)**
- Vertical list of agent cards. Each card's border/background reflects
  status (`done` → mint tint; `running` → amber tint; `pending` →
  default). Hover lifts.
- Card header has three things: (1) bold mono agent ID + colored type
  badge + (for running) a 14px amber spinner; (2) right-aligned mono
  meta (`3.1s · 812 tok`); on running cards the duration ticks live.
- Card body is a single short line of output summary (≤ 2 lines,
  `opacity: 0.82`). The full output expands on click.
- Below the body, a mono `← depends on: a1, a2, a3` breadcrumb so
  users can trace lineage without looking at the graph.

**Execute header row + bar**
- Tag row: `03 · EXECUTE` on the left, `live · 3 / 5 agents complete ·
  00:12.4s` on the right, both mono, the count in `--gold-2`.
- Below it a 6px tall shimmer bar that fills to the current
  completion ratio and runs a gradient `shimmer` animation
  (`var(--gold) → --gold-2 → --violet`, 2.2s linear) so the stage feels
  alive even when the eye isn't on any single node.

### 8. Result stage

While pending it stays in the dashed-border "placeholder" state
described in §6 so the user sees the whole pipeline shape from the
start.

When the answer lands:

- The stage transitions to the `done` visual (not `current`), because
  the rail has already advanced and the celebratory moment is about
  the answer itself, not the stage header.
- Final answer rendered in large `Instrument Serif` italic inside a
  soft mint-tinted box with a 2px mint left border.
- A one-shot ~400ms green pulse runs around the box border on arrival
  (`@keyframes pulse-in`), then settles.
- If `expectedAnswer` is present, a match/mismatch chip appears next
  to the header: green `✓ matches expected` or rose
  `✕ differs — see diff` (the diff view is a follow-up; the chip is
  the MVP signal).
- Footer row: three mono buttons — `copy answer`, `copy full trace`,
  `new problem` — with restrained hover states (border color shift to
  `--gold`, no fills).

### 9. Motion — rules of thumb

Motion should reinforce state, not decorate. Concrete pieces, all
already in the mock:

- **Background drift** — 40s slow `background-position` on the dot
  mesh. Calm, ambient.
- **Progress-rail active dot** — `pulse` 1.6s breathing glow.
- **Wordmark DAG edges** — `flow` 2.6s, staggered 0 / 0.4 / 0.8s so
  the three edges feel like a round.
- **Running graph node** — `nodepulse` 1.6s (matches rail pulse
  tempo).
- **Running graph edge** — `dash` 0.9s fast scroll, so it reads as
  "information moving."
- **Execute shimmer bar** — `shimmer` 2.2s gradient slide.
- **Spinner on running agent card** — `spin` 0.9s linear.
- **Stage state transitions** — 0.3s `ease` on opacity/border-color
  when a stage goes from pending → current or current → done.
- **Auto-scroll on stage advance** — one-shot `scroll-behavior:
  smooth` scrollIntoView with `block: 'start'`, then focus moves to
  the new stage's first interactive element (for a11y).

Everything stays in the ~1.0–2.6s tempo range so animations feel
synchronized rather than chaotic.

### 10. Implementation notes

- Add the palette and fonts as CSS variables in `index.css`, and
  import fonts via a single `@import` at the top. Remove the global
  `* { @apply transition-colors duration-150 }` — scope transitions
  per component; the graph especially suffers under it.
- Export a single `PALETTE` and `AGENT_COLORS` from `types/index.ts`
  and consume from `App.tsx`, `GraphViewer.tsx`, and `AgentOutputs.tsx`.
  This kills the current duplicate-palette bug.
- `App.tsx`'s current stage-replacing render becomes a single
  `<PipelineLayout>` that always renders all four stages, passes each
  a `state: 'done' | 'current' | 'pending'`, and exposes a
  `scrollToStage(stage)` method that the state machine calls on
  advance.
- The rail becomes `<ProgressRail stages={…} current={…} />` rendered
  inside a sticky wrapper; clicking a done segment calls
  `scrollToStage`.
- Replace the hand-rolled graph node with a custom React Flow node
  type that reads the status and agent-color tokens from CSS
  variables — this keeps the styling consistent with the rest of the
  page automatically in both dark and (future) light modes.