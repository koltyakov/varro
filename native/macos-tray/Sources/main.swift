import AppKit
import SwiftUI
import Combine

final class TrayApp: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem?
  private var indicator: TrayStatusIndicator?
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
      if let button = item.button { indicator = TrayStatusIndicator(button: button) }
      item.button?.target = self
      item.button?.action = #selector(togglePopover)
      popover.behavior = .transient
      let controller = NSHostingController(rootView: TrayView(model: model, open: { [weak self] session in
        self?.openProject(session)
      }))
      controller.sizingOptions = [.preferredContentSize]
      popover.contentViewController = controller
      subscription = model.$rows.sink { [weak self] rows in self?.indicator?.update(rows) }
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
