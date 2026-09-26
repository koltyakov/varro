# Transient VS Code webview clipping during resize

## Status

Reproduced in VS Code 1.139.1 arm64 on macOS 15.7.7, at a 1440 x 900 workbench size
and scale 1. The defect also occurs with plain HTML replacing the entire Varro
body. No message rows, virtualization, Solid rendering, or scroll measurement is
needed. This isolates the observed horizontal clipping to the host webview path;
it does not identify the responsible VS Code/Electron component.

Promoting the plain root with `translateZ(0)`, `will-change: transform`, and
`contain: layout paint`, while allowing visible overflow, did not eliminate it.
There is no verified Varro-side workaround. Changing message-list anchoring or
hiding the transcript during resize would not address the demonstrated cause.

## Reduced reproduction

Use a disposable Extension Development Host with a webview view in the secondary
sidebar. Render the following HTML instead of application content:

```html
<!doctype html>
<html>
  <body style="margin: 0">
    <div style="position: fixed; inset: 0; background: #202020; color: white; font: 14px sans-serif; overflow: hidden">
      <div style="height: 45px; background: #444">Minimal CSS webview</div>
      <div style="height: 65px; display: flex; justify-content: flex-end; padding: 8px">
        <div style="background: #455a64; border: 1px solid white; padding: 12px">Right-aligned prompt</div>
      </div>
      <div style="height: 45px; padding: 8px">Left-aligned answer</div>
    </div>
  </body>
</html>
```

1. Set sidebar width to 360 CSS pixels and allow it to settle.
2. Widen to 1100 pixels. Also test 360 to 486 pixels.
3. Record the workbench compositor with CDP `Page.startScreencast`, every frame.
4. Inspect frames during the resize, rather than just before and after it.

The sidebar expands and its document lays out at the new width while the painted
webview remains clipped to the old width briefly. The left-aligned answer remains
visible, but the right-aligned prompt disappears. The header background stops at
the old width too. The next painted update restores the complete view.

## Evidence and scope

Run seed `9c71e4b2` retained:

- `artifacts/ai-streaming/9c71e4b2-resize-compositor/`: original 110-turn history,
  stable T044 anchor, compositor PNGs, and resize/zoom contact sheets.
- `artifacts/ai-streaming/9c71e4b2-minimal-resize/`: plain-body control reproducing
  the same clipping. In its first widening, frame 2 is clipped and frame 3 recovers.
- `artifacts/ai-streaming/9c71e4b2-navigation-and-layer/`: promoted-root control;
  frame 2 is still clipped and frame 3 recovers.

The original disappearance lasted roughly 20 ms between sampled compositor
frames. That is an observation, not an exact duration guarantee. This is not
permanent history loss, and native streaming transitions require separate tests.
The retained evidence is suitable for an upstream issue; it has not been uploaded.

After a host fix or proposed application workaround, repeat both the plain-view
control and real-history cases. Require uninterrupted painted cards, header and
composer, plus stable history anchors, pagination and streaming. Settled geometry
alone cannot establish that the clipping has been fixed.
