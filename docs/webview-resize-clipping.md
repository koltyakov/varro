# Transient VS Code webview clipping during resize

## Status

The October 28 host investigation found an upstream Chromium repair for the reduced
reproduction. Chromium commit
[`9e4f33e7`](https://chromium.googlesource.com/chromium/src/+/9e4f33e7f601a78bcc545d37537b02e461920089),
"Fix stale OOPIF compositor viewport during resize", refreshes the remote frame's
compositing rectangle before propagating resized geometry. Without it, an
out-of-process iframe can receive new layout bounds with an old compositor viewport.
The installed Chromium 150 source lacks that update. Chromium Dash lists the repair
in stable `152.0.7977.42` and later.

This is a verified fix for the reduced reproduction, **not a complete real-chat fix**.
The same VS Code 1.143.1 application code was tested in disposable native hosts on
its installed Electron 43.7.7 / Chromium 150.0.7871.250 and on official Electron
44.7.0 / Chromium 152.0.7977.130. The plain HTML comparison recorded 10 cropped
frames in 170 on the installed engine, versus zero in 123 on the newer engine.
Both ran six maximize/restore cycles, ten width steps, and a held-sash drag.
Repeated real-chat maximize and editor transitions improved, but brief sidebar
crops still occurred after resizing. They also occurred with the host clip removed.
Do not mark native clipping fully resolved.

The [retained upstream source patch](patches/chromium-oopif-resize.patch) includes
Chromium's regression test and applies cleanly to the exact installed Chromium source
tag. It belongs in an Electron/Chromium source build, not in Varro or an installed
VS Code JavaScript bundle. No extension API can update that native compositor code.
An Electron backport or a VS Code runtime upgrade is the feasible upstream repair.
The disposable runtime replacement was a diagnostic build, not a supported editor
distribution, and was not installed over the user's editor. The stable 1.144.0 and
Insiders 1.145.0 manifests checked during this investigation still select Electron
43.8.3 with Chromium 150; updating to those versions is not a verified solution.

Removing the host `OverlayLayoutElement` clip, replacing `content-box` with
`inset(0)`, promoting host layers, replacing anchor sizing with immediate pixel
sizing, and changing the preload's inner iframe positioning did not fix the installed
engine. Those experiments were rolled back. Root sizing remains CSS-driven, with no
resize delay restored. See
`artifacts/ai-streaming/image-prompt-native-20261028/host-ledger.md` for the comparisons,
remaining cropped frames, isolation, patch checks, and cleanup records.

### November 21 retest on VS Code 1.146.0

The Mac AI-02 and AI-04 widening clips reproduced in both the 110-turn chat and a
plain HTML control in the same isolated host (Electron 43.8.6, Chromium
150.0.7871.250). All six expansions per surface cropped: three 360→720 px and
three 486→1100 px native sash drags. The chat root and transcript had already
measured the new width when the cropped images were captured. With the app body
replaced, the plain header painted exactly 360 or 486 px from the **new** left
edge, and all four right-aligned color cards disappeared for one captured frame.
The next paint restored the full header and all four cards. This matches the known
host defect; it does not require a Varro root-width delay or a message-list bug.

For this signature, use the upstream report [crbug.com/519655838](https://crbug.com/519655838)
and test a **supported VS Code distribution** once it ships the compositor repair
or an Electron backport. Check the embedded Chromium version rather than assuming
a newer editor version contains it. Accept a candidate only after both the plain
and real-chat expansion sequences paint continuously: the previous Chromium 152
comparison cleared only the reduced reproduction. No supported real-chat fix is
verified by this retest. Native frames, geometry and version details are in
`artifacts/ai-fuzzy/issues-fix-20261121-resize/ledger.md`.

## Earlier application fixes and investigations

Reproduced in VS Code 1.139.1 arm64 on macOS 15.7.7, at a 1440 x 900 workbench size
and scale 1. The defect also occurs with plain HTML replacing the entire Varro
body. No message rows, virtualization, Solid rendering, or scroll measurement is
needed. This originally isolated the observed horizontal clipping to the host webview
path. The host investigation above identifies a matching Chromium defect and its repair.

Promoting the plain root with `translateZ(0)`, `will-change: transform`, and
`contain: layout paint`, while allowing visible overflow, did not eliminate it.
The former four-frame expansion delay in `src/webview/index.tsx` has been removed. It
held the centered chat at its previous width after expansion, leaving prompt bubbles
inset from their final right edge before they jumped into place. The resize regression
in `e2e/tests/layout.spec.ts` reproduced this across 486 to 700, 700 to 950, and 980 to
1280 px expansions. CSS now owns responsive root sizing, so hidden viewport changes
and temporary unsized iframe dimensions cannot become retained pixel constraints.

The follow-up native retest on VS Code 1.143.1 found a separate one-frame race in the
remaining resize-event pixel cap, plus a retained 10 px inset on a short single-image
text bubble after maximizing. Removing numeric root sizing entirely and letting CSS
own the iframe width eliminated both in same-input native experiments. The sticky
overlay's full reserved footprint is now opaque, rather than revealing transcript text
through its lower fade while the preview changes height.

The host clipping remains reproducible on this version with plain HTML replacing the
entire app body. Promoting the root and removing nested sticky transform layers did
not eliminate it. Do not treat the application alignment and opaque-mask fixes as a
repair to VS Code's compositor. Native evidence and the isolated reproducer are under
`artifacts/ai-streaming/image-prompt-native-20261028/`, including the current-version
plain control in `research-opaque-control/`. Message-list anchoring and transcript
visibility remain independent.

The built fixes passed two further interactive native runs, including retained editor
tabs and a painted sticky-mask probe. Prompt right-edge error and root-width error
were both zero in the recorded layout samples. The mask probe exposed the previous
transparent tail and found no probe pixels through the opaque replacement. The host
still clipped some transition paints. See that evidence directory's `fix-ledger.md`
for the separate application results and unresolved host defect.

Editor startup has a separate 50 ms layout-settling hold that hides the root.
Continuous resize events may restart that debounce, but must not extend root hiding beyond
250 ms from the first visible startup/reveal. Hiding during startup cancels the deadline;
returning before the initial layout settles starts a fresh one. Once revealed, tab switching
and ordinary resizing must not hide the root again. This deadline does not
change transcript hydration, width tracking, or scroll ownership. Bootstrap unit tests cover
continuous resizing, hidden-view cancellation, and disposal in `src/webview/index.test.tsx`.

New editor chat panels retain their webview context while hidden. VS Code restores each panel's
original, immutable `retainContextWhenHidden` option, so tabs created before this change still
recreate their documents on reveal, even after a window reload. Keep their suspend/resume path
until the user closes and reopens them. Do not automatically replace restored panels: that would
lose panel-local unsent drafts and change tab order. Finish or save the draft and its attachments
before closing an older tab; reopening the session keeps its sent conversation.

The October 4 maximize/restore reproduction exposed an interaction with viewport media queries.
At a 486px root cap, the 1400px desktop breakpoint displayed a 420px session sidebar, leaving only
66px for the transcript. Five native maximize/restore cycles produced 20 squeezed animation-frame
samples. The fix at the time applied the root width immediately when crossing the 960px content or
1400px sidebar breakpoint and cancelled a queued expansion. Numeric root sizing has since been removed,
so CSS applies each breakpoint from the current viewport. The same isolated-editor retest recorded zero
capped or squeezed samples across five cycles, with a maximum frame gap of 21.3ms and at most 22
mounted message rows.
Evidence, including 274 compositor frames, is under `artifacts/fullscreen-resize-20261004/fixed/`.
The host can still paint one stale clipped frame during the transition, as shown in `frame-001.png`.
This change removes Varro's extra delay and intermediate squeezed layout; it does not fix that host
paint defect. The unit test "does not introduce a pixel width cap across %s layout breakpoints" in
`src/webview/index.test.tsx` and the browser test "switches full-screen layouts without a capped or
squeezed transcript frame" in `e2e/tests/layout.spec.ts` cover both breakpoint transitions and restore.

The October 2 sidebar-switch reproduction found a separate host path: returning
from Chat to Varro emits a 300 x 150 resize followed by the real viewport resize,
without any `visibilitychange` event. Chromium uses 300 x 150 for an unsized iframe.
Previously this replaced the width cap with 300 px and kept the restored sidebar
narrow for four painted frames. The fix at the time ignored that temporary cap and
applied the next host viewport immediately. With numeric root sizing removed, there is
no width cap for the unsized resize to replace, and a real 300 px sidebar is sized by
CSS like any other width. Unit tests in `src/webview/index.test.tsx` cover this:
"does not retain an unsized iframe width when reattached at %i without a visibility
event" checks 420 and 486 px returns and a real 300 px sidebar, and "never pins
expansion or initial attachment to the unsized iframe width" covers initial unsized
layout and later expansion.
The isolated native retest checked 10 returns at 486 and 420 px: zero narrow
animation-frame samples, versus 20 narrow samples over five baseline returns.
The runs retained 185 baseline and 397 fixed compositor frames. Evidence and the
reproduction script are under `artifacts/sidebar-switch-20261002/`.

A fresh isolated-host retest on September 28 retained 169 compositor frames across
the baseline, `overflow: visible`, and `overflow: clip` experiments. The visible
override still shows stale-width paint during expansion, including frames 003 and
044. These overrides do not establish a fix. Evidence and the reversible runner
are under `artifacts/ai-fuzzy/20260928-resolve/resize-*`.

Run 48267 also reproduced the defect with `--disable-gpu`. CDP `SystemInfo.getInfo`
confirmed software compositing and rasterization. All three overflow variants still
clipped, across 144 retained frames. For example, `software-resize/resize-baseline/019.png`
shows the expanded sidebar with the plain document clipped to its old 360px width.
Evidence is under `artifacts/ai-fuzzy/20260928-48267/`. Disabling GPU acceleration
does not establish a workaround either.

Run 94312 verified the root-width mitigation in a fresh real editor. The unmodified
plain control clipped or lost all five cards in 11 of 66 captured frames. A two-frame
delay still clipped one frame in the built application. The final four-frame version
kept all five cards intact across 100 resize actions, 285 compositor frames and 1,425
card samples. The real long-history AI-02 resize/zoom sequence also passed its anchor
checks. Evidence is under `artifacts/ai-fuzzy/20260928-94312/`, including
`all-cards-resize-comparison.json` and `resize-source-four/`.

The former delay was an application mitigation, not a repair to VS Code's compositor.
The host-level plain-body reproduction remains useful when investigating the remaining clipping.

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
