# Frontend Rendering And Interaction Rules

Read this file before creating or changing frontend pages, forms, dropdowns,
modals, settings surfaces, or realtime UI update handlers.

## Core Rule

User interaction state has priority over background freshness. Background
updates from SSE, polling, heartbeat, or server echoes must not replace the DOM
nodes the user is actively interacting with unless the visible surface truly
changed.

## Required Pattern

1. For every realtime state update path, compare the active visible surface
   before and after applying the new state.
2. If the visible surface is unchanged, do not call the global full-page
   `render()` path. Patch only the affected small surfaces, such as counters,
   badges, rail rows, or status text.
3. Keep node identity stable for focused inputs, textareas, selects, popovers,
   menus, and scroll containers. Do not replace their parent root with
   `innerHTML` during background updates.
4. Treat server echoes separately from user edits. Pending local form state must
   not be overwritten just because a later state payload arrives.
5. Coalescing, throttling, or debouncing refreshes is not enough by itself. The
   final DOM update still needs to be scoped to the surface that actually
   changed.

## Full Render Exceptions

A full `render()` is acceptable when the active view, selected item, route,
permission boundary, or visible data model for the current surface changed. If a
full render is unavoidable while a form-like surface is open, snapshot and
restore focus, selection, and scroll intentionally, then verify the result in a
browser.

## Verification Checklist

For every new interactive page or realtime UI change, run a browser smoke that:

- Focuses an input or textarea, enters an unsaved value, triggers a background
  update, and confirms the same DOM node remains focused with the same value.
- Opens a select, menu, dropdown, or modal, triggers a background update, and
  confirms the interaction is not closed by an unrelated repaint.
- Scrolls the main page and any relevant inner scroll container, triggers a
  background update, and confirms scroll positions are preserved.
- Adds or updates automated tests that protect the specific no-full-render or
  targeted-patch branch.

## Review Questions

- Can an SSE, polling, heartbeat, or timer response reach `render()` while the
  active page content is unchanged?
- Does the update path replace `#root` or a form owner while the user can type,
  select, scroll, or open a menu?
- Are dirty form values and server echoes represented explicitly, or can later
  state payloads silently overwrite active edits?
- Is the test proving DOM stability, not only that the final text looks right?
