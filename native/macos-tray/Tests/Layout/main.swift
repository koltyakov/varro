import AppKit
import SwiftUI

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertions += 1
  if !condition() { fatalError(message) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let model = TrayModel(historyURL: nil)
let controller = NSHostingController(rootView: TrayView(model: model, open: { _ in }))
controller.sizingOptions = [.preferredContentSize]
// Exercise the real SwiftUI layout without opening a window or connecting to user data.
let window = NSWindow(contentViewController: controller)
window.setContentSize(NSSize(width: 390, height: 520))

func size() -> NSSize {
  let deadline = Date().addingTimeInterval(0.3)
  while Date() < deadline {
    controller.view.layoutSubtreeIfNeeded()
    _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
  }
  return controller.preferredContentSize
}

let connection = UUID()
let instance = UUID().uuidString
func show(_ count: Int, title: String = "Short chat") {
  let rows = (0..<count).map { index in
    TraySession(id: "row-\(index)", title: title, project: "Project", projectUrl: "vscode://file/project", status: .completed, updatedAt: 1_800_000_000_000)
  }
  model.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: rows, eventDriven: true), connection: connection)
}

let empty = size()
check(empty.width == 390 && empty.height > 100 && empty.height < 520, "Empty state fits below the maximum: \(empty)")
show(1)
let single = size()
check(single.width == 390 && single.height > 100 && single.height < 300, "One item uses a compact popover: \(single)")
show(3)
let three = size()
check(three.height > single.height && three.height < 520, "A few items grow the popover without filling the maximum: \(three)")
show(3, title: "A longer chat title that wraps onto a second line and needs more vertical space")
let wrapped = size()
check(wrapped.height > three.height && wrapped.height < 520, "Wrapped titles contribute their rendered height: \(wrapped)")
let mixed = [SessionStatus.completed, .completed, .running].enumerated().map { index, status in
  TraySession(id: "row-\(index)", title: "Short chat", project: "Project", projectUrl: "vscode://file/project", status: status, updatedAt: 1_800_000_000_000)
}
model.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: mixed, eventDriven: true), connection: connection)
let sections = size()
check(sections.height > three.height && sections.height < 520, "Separate section headings and spacing contribute to the fitted height: \(sections)")
show(30)
let full = size()
check(abs(full.height - 520) < 1, "Long lists stop growing at 520 points: \(full)")
model.error = "Could not open this project in VS Code."
let withError = size()
check(abs(withError.height - 520) < 1, "Errors share the height cap with the scrollable list: \(withError)")
model.error = nil
show(1)
check(abs(size().height - single.height) < 1, "The popover shrinks again when items and errors are removed")
model.error = "Could not open this project in VS Code."
check(size().height > single.height, "Short lists grow just enough to include an error")
model.error = nil
show(0)
check(size().height < 520, "Clearing activity restores the compact empty state")
print("Passed \(assertions) native tray layout checks")
