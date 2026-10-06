import AppKit

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertions += 1
  if !condition() { fatalError(message) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
// Render a plain button offscreen without creating a status item or connecting to user data.
let button = NSButton(frame: NSRect(x: 0, y: 0, width: 80, height: 24))
button.isBordered = false
let indicator = TrayStatusIndicator(button: button)
let dot = button.subviews.last!

func row(_ status: SessionStatus, time: Double = 1_800_000_000_000, connected: Bool = true) -> SessionRow {
  SessionRow(session: TraySession(id: UUID().uuidString, title: "Chat", project: "Project", projectUrl: "vscode://file/project", status: status, updatedAt: time), connected: connected)
}

func renderDot(scale: Int = 1, antialias: Bool = true) -> NSBitmapImageRep {
  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 80 * scale, pixelsHigh: 24 * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current?.cgContext.clear(CGRect(x: 0, y: 0, width: 80 * scale, height: 24 * scale))
  NSGraphicsContext.current?.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
  NSGraphicsContext.current?.shouldAntialias = antialias
  NSGraphicsContext.current?.cgContext.setAllowsAntialiasing(antialias)
  dot.draw(dot.bounds)
  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

func dotColor() -> NSColor {
  let bitmap = renderDot()
  let imageRect = button.cell!.imageRect(forBounds: button.bounds)
  return bitmap.colorAt(x: Int(imageRect.minX + 13), y: 23 - Int(imageRect.minY + 5))!.usingColorSpace(.sRGB)!
}

indicator.update([])
check(button.title.isEmpty && dot.isHidden, "No attention hides the counter and dot")
check(button.image?.isTemplate == true, "The main icon keeps native menu-bar appearance adaptation")
check(button.image?.size == NSSize(width: 18, height: 20), "The dot does not widen the original icon")
check(button.imagePosition == .imageLeading, "The counter sits beside the icon")
check(button.font?.pointSize == NSFont.menuBarFont(ofSize: 0).pointSize, "The counter uses full menu-bar text size")
check(dot.hitTest(NSPoint(x: 13, y: 5)) == nil && !dot.acceptsFirstResponder, "The dot cannot intercept clicks or focus")

let colors: [(SessionStatus, CGFloat, CGFloat, CGFloat)] = [
  (.completed, 0x73, 0xc9, 0x91),
  (.planReady, 0xcc, 0xa7, 0x00),
  (.permission, 0x00, 0x7f, 0xd4),
  (.question, 0x00, 0x7f, 0xd4),
  (.error, 0xf4, 0x47, 0x47),
]
for (status, red, green, blue) in colors {
  indicator.update([row(status)])
  check(button.title == "1" && !dot.isHidden, "\(status.label) shows the count and dot")
  let color = dotColor()
  check(abs(color.redComponent - red / 255) < 0.02 && abs(color.greenComponent - green / 255) < 0.02 && abs(color.blueComponent - blue / 255) < 0.02 && color.alphaComponent > 0.95, "\(status.label) renders its event color")
}

for scale in [1, 2] {
  let bitmap = renderDot(scale: scale, antialias: false)
  let alphas = (0..<bitmap.pixelsHigh).flatMap { y in
    (0..<bitmap.pixelsWide).map { x in bitmap.colorAt(x: x, y: y)!.alphaComponent }
  }
  check(alphas.contains { $0 > 0.01 && $0 < 0.99 }, "The circular edge is antialiased at \(scale)x even when the parent disables antialiasing")
  let imageRect = button.cell!.imageRect(forBounds: button.bounds)
  let minX = Int((imageRect.minX + 10) * CGFloat(scale))
  let minY = Int((imageRect.minY + 2) * CGFloat(scale))
  let last = 7 * scale - 1
  for x in [minX, minX + last] {
    for y in [minY, minY + last] {
      check(bitmap.colorAt(x: x, y: bitmap.pixelsHigh - 1 - y)!.alphaComponent < 0.15, "The dot's corners stay transparent at \(scale)x")
    }
  }
}

indicator.update([row(.completed)])
let originalAppearance = button.appearance
for appearance in [NSAppearance.Name.aqua, .darkAqua] {
  button.appearance = NSAppearance(named: appearance)
  let bitmap = renderDot(scale: 4)
  let imageRect = button.cell!.imageRect(forBounds: button.bounds)
  let outline: CGFloat = appearance == .darkAqua ? 0 : 1
  for (x, y) in [(10.25, 5.5), (16.75, 5.5), (13.5, 2.25), (13.5, 8.75)] {
    let color = bitmap.colorAt(x: Int((imageRect.minX + x) * 4), y: bitmap.pixelsHigh - 1 - Int((imageRect.minY + y) * 4))!.usingColorSpace(.sRGB)!
    check(abs(color.redComponent - outline) < 0.03 && abs(color.greenComponent - outline) < 0.03 && abs(color.blueComponent - outline) < 0.03, "The half-point outline reverses the foreground in \(appearance.rawValue)")
  }
  check(matches(.completed), "The outline preserves the event color in the dot's center")
}
button.appearance = originalAppearance

indicator.update((0..<12).map { _ in row(.completed) })
check(button.title == "12", "Counts above nine show the full total instead of 9+")
indicator.update([
  row(.error),
  row(.completed, time: 1_800_000_000_002),
  row(.running, time: 1_800_000_000_004),
  row(.permission, time: 1_800_000_000_003, connected: false),
])
check(button.title == "2", "Running and disconnected rows are excluded from the unread count")
check(button.toolTip?.hasSuffix("Latest event: Completed") == true, "The dot follows event time, not severity, row order, or newer non-attention rows")
check(button.accessibilityLabel() == button.toolTip, "The count and latest event are accessible without relying on color")
check(dotColor().greenComponent > dotColor().redComponent, "The newest unread event replaces the previous dot color")
indicator.update([row(.running), row(.error, connected: false)])
check(button.title.isEmpty && dot.isHidden, "Clearing unread events removes both indicators")

func pump(for seconds: TimeInterval) {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    _ = RunLoop.main.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.02)))
  }
}

func matches(_ status: SessionStatus) -> Bool {
  let (_, red, green, blue) = colors.first { $0.0 == status }!
  let color = dotColor()
  return abs(color.redComponent - red / 255) < 0.02 && abs(color.greenComponent - green / 255) < 0.02 && abs(color.blueComponent - blue / 255) < 0.02
}

let rotationRows = [
  row(.completed, time: 1_800_000_000_004),
  row(.planReady, time: 1_800_000_000_003),
  row(.permission, time: 1_800_000_000_002),
  row(.question, time: 1_800_000_000_001),
  row(.error),
  row(.error, time: 1_800_000_000_005, connected: false),
  row(.running, time: 1_800_000_000_006),
]
indicator.update(rotationRows)
check(matches(.completed), "Rotation starts with the newest unread event color")
pump(for: 1.6)
check(matches(.completed), "The initial color stays visible before the three-second interval")
indicator.update(Array(rotationRows.reversed()) + [row(.completed, time: 1_800_000_000_004)])
pump(for: 1.6)
check(matches(.planReady), "Repeated snapshots, row reordering, and count changes do not restart rotation")
pump(for: 3.1)
check(matches(.permission), "The next three-second interval shows the unread attention color")
pump(for: 3.1)
check(matches(.error), "Questions and permissions share one blue step before the unread error color")
pump(for: 3.1)
check(matches(.completed) && button.title == "6", "Rotation wraps around without changing the unread counter")
indicator.update([row(.question)])
check(matches(.question), "Removing other event colors immediately shows the remaining unread color")
dot.needsDisplay = false
pump(for: 3.2)
check(matches(.question) && !dot.needsDisplay, "A single unread color stops the rotation timer and redraws")
indicator.update(rotationRows)
indicator.update([])
dot.needsDisplay = false
pump(for: 3.2)
check(dot.isHidden && button.title.isEmpty && !dot.needsDisplay, "Clearing unread events stops rotation without later redraws")
weak var releasedIndicator: TrayStatusIndicator?
do {
  let temporary = TrayStatusIndicator(button: NSButton(frame: button.frame))
  releasedIndicator = temporary
  temporary.update(rotationRows)
}
check(releasedIndicator == nil, "The rotation timer does not retain its indicator")
print("Passed \(assertions) native tray indicator checks")
