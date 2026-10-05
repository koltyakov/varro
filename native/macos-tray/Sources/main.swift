import AppKit
import SwiftUI
import Combine

final class TrayApp: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem?
  private let popover = NSPopover()
  private var model: TrayModel?
  private var server: TrayServer?
  private var subscription: AnyCancellable?
  private var expirationSubscription: AnyCancellable?
  private var timer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Launch Services normally enforces this; also handle directly executing a second binary.
    if NSRunningApplication.runningApplications(withBundleIdentifier: "com.koltyakov.varro.tray")
      .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
      NSApp.terminate(nil)
      return
    }
    // A dedicated directory doubles as the extension's install marker. Without it, editors stay inert.
    let directory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Varro/tray", isDirectory: true)
    do {
      try TrayServer.prepareDirectory(directory)
      let model = TrayModel(historyURL: directory.appendingPathComponent("tray-history.json"))
      self.model = model
      let server = TrayServer(onSnapshot: { [weak model] id, snapshot in
        model?.receive(snapshot, connection: id)
      }, onDisconnect: { [weak model] id in model?.disconnect(id) })
      try server.start(directory: directory)
      self.server = server
      let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      self.item = item
      item.button?.image = Self.menuBarIcon()
      item.button?.target = self
      item.button?.action = #selector(togglePopover)
      popover.behavior = .transient
      let controller = NSHostingController(rootView: TrayView(model: model, open: { [weak self] session in
        self?.openProject(session)
      }))
      controller.sizingOptions = [.preferredContentSize]
      popover.contentViewController = controller
      subscription = model.$rows.sink { [weak self] rows in self?.updateIcon(rows) }
      expirationSubscription = model.$nextExpiration.sink { [weak self] deadline in
        self?.scheduleExpiration(deadline)
      }
    } catch {
      let alert = NSAlert()
      alert.messageText = "Varro could not start"
      alert.informativeText = error.localizedDescription
      alert.runModal()
      NSApp.terminate(nil)
    }
  }

  private func scheduleExpiration(_ deadline: Date?) {
    timer?.invalidate()
    timer = nil
    // No polling while idle. Socket events schedule only the next lease cleanup.
    guard let deadline = deadline else { return }
    let timer = Timer(fire: deadline, interval: 0, repeats: false) { [weak model] _ in model?.expire() }
    self.timer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  @objc private func togglePopover() {
    guard let button = item?.button else { return }
    if popover.isShown { popover.performClose(nil) }
    else {
      NSApp.activate(ignoringOtherApps: true)
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
    }
  }

  private static func menuBarIcon(attention: Int = 0) -> NSImage {
    let markSize: CGFloat = 18
    let badge = (attention > 9 ? "9+" : attention > 0 ? String(attention) : "") as NSString
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
      .foregroundColor: NSColor.black,
    ]
    let badgeSize = badge.size(withAttributes: attributes)
    // Keep the original 8-point count's top edge as the larger text grows downward.
    let badgeAnchorHeight = badge.size(withAttributes: [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 8, weight: .semibold),
    ]).height
    let width = max(markSize, 12 + ceil(badgeSize.width))
    // Match OpenJet's icons/varro.svg: 83% inset mark, 38-unit nodes, 24-unit bars.
    let icon = NSImage(size: NSSize(width: width, height: 20), flipped: true) { rect in
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
      // Draw into the template so the small corner count follows the menu bar appearance.
      badge.draw(at: NSPoint(x: rect.minX + 12, y: rect.maxY - badgeAnchorHeight + 1), withAttributes: attributes)
      return true
    }
    icon.isTemplate = true
    icon.accessibilityDescription = attention > 0 ? "Varro: \(attention) need attention" : "Varro"
    return icon
  }

  private func updateIcon(_ rows: [SessionRow]) {
    let attention = rows.filter(\.needsAttention).count
    let running = rows.filter { $0.connected && $0.session.status == .running }.count
    item?.button?.image = Self.menuBarIcon(attention: attention)
    item?.button?.toolTip = "Varro: \(attention) need attention, \(running) running"
  }

  private func openProject(_ session: TraySession) {
    if model?.openProject(session, using: { NSWorkspace.shared.open($0) }) == true {
      popover.performClose(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
    subscription?.cancel()
    expirationSubscription?.cancel()
    server?.stop()
  }
}

let app = NSApplication.shared
let delegate = TrayApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
