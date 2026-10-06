import AppKit

final class TrayStatusIndicator {
  private let button: NSButton
  private let dot: StatusDotView
  private var statuses: [SessionStatus] = []
  private var rotationIndex = 0
  private var rotationTimer: Timer?

  init(button: NSButton) {
    self.button = button
    dot = StatusDotView(frame: button.bounds)
    dot.autoresizingMask = [.width, .height]
    dot.isHidden = true
    dot.setAccessibilityElement(false)
    button.addSubview(dot)
    button.image = Self.menuBarIcon()
    button.imagePosition = .imageLeading
    button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.menuBarFont(ofSize: 0).pointSize, weight: .regular)
  }

  func update(_ rows: [SessionRow]) {
    let attention = rows.filter(\.needsAttention)
    let latest = attention.max { $0.session.updatedAt < $1.session.updatedAt }?.session.status
    let running = rows.filter { $0.connected && $0.session.status == .running }.count
    button.title = attention.isEmpty ? "" : String(attention.count)
    var statuses: [SessionStatus] = []
    for row in attention.sorted(by: {
      $0.session.updatedAt == $1.session.updatedAt ? $0.id < $1.id : $0.session.updatedAt > $1.session.updatedAt
    }) {
      // Permissions and questions share blue, so show that color only once per cycle.
      let status = row.session.status == .question ? .permission : row.session.status
      if !statuses.contains(status) { statuses.append(status) }
    }
    updateRotation(statuses)
    let summary = "Varro: \(attention.count) need attention, \(running) running"
    let description = latest.map { "\(summary). Latest event: \($0.label)" } ?? summary
    button.toolTip = description
    button.setAccessibilityLabel(description)
  }

  private func updateRotation(_ statuses: [SessionStatus]) {
    // Count changes and repeated snapshots must not restart the three-second interval.
    guard statuses != self.statuses else { return }
    rotationTimer?.invalidate()
    rotationTimer = nil
    self.statuses = statuses
    rotationIndex = 0
    dot.status = statuses.first
    dot.isHidden = statuses.isEmpty
    dot.needsDisplay = true
    guard statuses.count > 1 else { return }
    let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      self.rotationIndex = (self.rotationIndex + 1) % self.statuses.count
      self.dot.status = self.statuses[self.rotationIndex]
      self.dot.needsDisplay = true
    }
    rotationTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  deinit { rotationTimer?.invalidate() }

  private static func menuBarIcon() -> NSImage {
    let markSize: CGFloat = 18
    // Match OpenJet's icons/varro.svg: 83% inset mark, 38-unit nodes, 24-unit bars.
    let icon = NSImage(size: NSSize(width: markSize, height: 20), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.saveGState()
      let scale = markSize / 256
      context.translateBy(x: rect.minX + 21.8 * scale, y: rect.minY + 1 + 21.8 * scale)
      context.scaleBy(x: 0.83 * scale, y: 0.83 * scale)
      context.setStrokeColor(NSColor.black.cgColor)
      context.setFillColor(NSColor.black.cgColor)
      context.setLineWidth(24)
      context.setLineCap(.butt)
      for (x1, y1, x2, y2) in [(103.0, 67.5, 152.0, 87.5), (61.2, 100.4, 69.8, 155.6), (119.9, 174.9, 160.1, 142.1)] {
        context.move(to: CGPoint(x: x1, y: y1))
        context.addLine(to: CGPoint(x: x2, y: y2))
      }
      context.strokePath()
      for (x, y) in [(53.0, 47.0), (202.0, 108.0), (78.0, 209.0)] {
        context.fillEllipse(in: CGRect(x: x - 38, y: y - 38, width: 76, height: 76))
      }
      context.restoreGState()
      return true
    }
    icon.isTemplate = true
    icon.accessibilityDescription = "Varro"
    return icon
  }
}

private final class StatusDotView: NSView {
  var status: SessionStatus?

  // Keep the colored dot separate so AppKit still adapts the template icon to the menu bar.
  override func draw(_ dirtyRect: NSRect) {
    guard let status = status, let button = superview as? NSButton,
          let imageRect = button.cell?.imageRect(forBounds: button.bounds),
          let context = NSGraphicsContext.current?.cgContext else { return }
    // Match the webview's default completed, plan-ready, error, and attention colors.
    let rgb: (CGFloat, CGFloat, CGFloat)
    switch status {
    case .completed: rgb = (0x73, 0xc9, 0x91)
    case .planReady: rgb = (0xcc, 0xa7, 0x00)
    case .error: rgb = (0xf4, 0x47, 0x47)
    case .permission, .question: rgb = (0x00, 0x7f, 0xd4)
    case .running: return
    }
    context.saveGState()
    defer { context.restoreGState() }
    // Native button drawing can disable antialiasing; do not inherit its hard pixel edges.
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.setFillColor(NSColor(srgbRed: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255, alpha: 1).cgColor)
    let rect = CGRect(x: imageRect.minX + 10, y: imageRect.minY + 2, width: 7, height: 7)
    context.fillEllipse(in: rect)
    button.effectiveAppearance.performAsCurrentDrawingAppearance {
      let foreground = (button.contentTintColor ?? .labelColor).usingColorSpace(.genericGray) ?? .black
      context.setStrokeColor((foreground.whiteComponent > 0.5 ? NSColor.black : NSColor.white).cgColor)
      context.setLineWidth(0.5)
      context.strokeEllipse(in: rect.insetBy(dx: 0.25, dy: 0.25))
    }
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
