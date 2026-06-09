# Default Share HTML Style

Use this style whenever the user asks to share something with the team, use MagClaw sharing, or create a MagClaw share link, unless the user explicitly asks for another visual direction.

- Format: one `<!doctype html>` file with inline CSS, `lang="zh-CN"` by default, `meta viewport`, and smooth anchor scrolling.
- Hero: deep blue-black technical hero with subtle cyan dot-grid or radial pattern over a dark linear background. Include compact eyebrow label, emerald pulse/status mark, clear H1, short subtitle, and 3-4 metric tiles.
- Layout: max-width content shell around 1160px. Desktop uses a two-column layout with 240-260px sticky table of contents on the left and report content on the right. Small screens collapse to one column.
- Body: pale wash page background and white report cards for major sections. Cards use 8px radius, 1px neutral borders, subtle slate shadows, and compact padding. Do not nest cards inside cards.
- Palette: neutral ink/muted/line/paper/wash colors, cyan primary accent, emerald success, amber warning, rose risk. Avoid one-note blue, purple, beige, or heavy gradient pages.
- Typography: system sans-serif fonts, `letter-spacing: 0`, strong line-height for Chinese text, hero-scale type only in hero, compact headings inside report sections.
- Components: lead paragraphs for conclusions, callouts with 4px colored left border, small rounded tags, metric tiles, 3-column cards, and simple step blocks.
- Tables: full-width comparison/checklist tables with clear headers, 1px borders, readable 14px text, and horizontal overflow handling.
- Code: inline code chips; command blocks in a dark terminal panel with cyan-tinted text, 8px radius, and `overflow-x: auto`.
- Diagrams: prefer CSS grid flow diagrams, compact architecture maps, or Mermaid blocks.
- Responsive: mobile viewports must not overflow. Collapse metrics/cards/flow grids to one column below tablet width; keep tables scrollable; wrap or scroll long commands and URLs.
- Content: write for reporting, not chat replay. Start each section with a conclusion sentence, then provide technical detail, commands, tradeoffs, and verification.
- Footer: rely on MagClaw to add creator and creation time. Do not duplicate credentials, local paths, hidden reasoning, raw tool output, or private configuration.
