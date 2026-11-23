Map of this folder; each file's header comment is the source of truth.

- `ui-chat.ts` — the map chat in the drawer's Ask tab (Tools ▸ Chat): key form,
  model picker, one chip per tool call, a confirm card before an off-page call, a chart card
  after a call made with `chart`; bot replies render markdown via `chat-markdown.ts` (DOM nodes, text only); lazy chunk; the conversation lasts the tab (`tm-chat`, restored
  after a reload of the same link — `resumeChat`, called by the boot restore when `tm-drawer` had Ask open).
  `ui-chart.ts` — that card: a canvas bar/pie/line
  drawn from a checked `chart-spec.ts` spec (text via `fillText`/`textContent` only), PNG and CSV
  downloads; in the chat chunk. `ui-canvas.ts` — the canvas card (`DispatchOpts.render`: a
  `showCanvas` page or a Vega-Lite chart): "Made by the model" border, Expand, ×, partial-data notes,
  error lines, page-owned Save buttons; imported by `ui-chat.ts` on first use, statically by `../ui-templates.ts`

## Footguns

### Chat panel (the drawer's Ask tab)

- model text goes in as text only; a string with params needs `data-chat-key` or `lang:changed` misses it; import `ui-chat.ts` only dynamically

### Chat charts (bar/pie/line or Vega-Lite, PNG/CSV)

- a spec from a model reaches the card only through `validateChart` — never draw an unchecked value; a Vega-Lite spec passes `validateVegaLite` and runs only in `public/canvas.html` through `ui-canvas.ts` — never import Vega into the page; labels are drawn with `fillText`/`textContent`, never HTML (lint covers both files); the chart rides on the tool result as `chart` and `loop.ts` `toolContent` must keep it out of what the model is sent; a chart is session only — no `url:write`, no undo; import `ui-chart.ts`/`chart-spec.ts` only from the chat chunk; the tool schemas' byte budget applies (Map API row)
