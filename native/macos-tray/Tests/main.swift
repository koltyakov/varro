import Foundation
import Darwin
import Combine

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  assertions += 1
  if !condition() { fatalError(message) }
}

func session(_ status: SessionStatus, id: String = "root", time: Double = 1_800_000_000_000) -> TraySession {
  TraySession(id: id, title: "Fix tests", project: "Workspace", projectUrl: "vscode://file/Users/test/Project%20One.code-workspace", status: status, updatedAt: time)
}

func snapshot(_ rows: [TraySession], instance: String = UUID().uuidString) -> TraySnapshot {
  TraySnapshot(version: 1, instanceID: instance, available: true, sessions: rows)
}

func pump(until predicate: () -> Bool) {
  let deadline = Date().addingTimeInterval(3)
  while !predicate() && Date() < deadline {
    _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
  }
  check(predicate(), "Timed out waiting for native IPC")
}

func connect(_ path: String) -> Int32 {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  let bytes = Array(path.utf8CString)
  check(bytes.count <= MemoryLayout.size(ofValue: address.sun_path), "Test socket path fits")
  withUnsafeMutableBytes(of: &address.sun_path) { target in
    bytes.withUnsafeBytes { target.copyBytes(from: $0) }
  }
  let result = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  check(result == 0, "Connect to fixture socket")
  return fd
}

func send(_ string: String, to fd: Int32) {
  let data = Data(string.utf8)
  data.withUnsafeBytes { check(write(fd, $0.baseAddress, $0.count) == $0.count, "Write fixture frame") }
}

let fixture = FileManager.default.temporaryDirectory.appendingPathComponent("vt-\(UUID().uuidString.prefix(8))")
try TrayServer.prepareDirectory(fixture)
defer { try? FileManager.default.removeItem(at: fixture) }

check(SessionStatus.planReady.label == "Plan ready", "Use the concise plan-ready event label")
check(projectURL("vscode://file/Users/test/My%20Project")?.path == "/Users/test/My Project", "Encoded project route")
for value in ["https://example.com", "vscode://koltyakov.varro/notification?session=x", "vscode://file/tmp?a=b", "vscode://file/tmp#x", "vscode://user@file/tmp", "file:///tmp"] {
  check(projectURL(value) == nil, "Reject non-project URL: \(value)")
}

let first = UUID()
let second = UUID()
let instance = UUID().uuidString
let history = fixture.appendingPathComponent("history.json")
let model = TrayModel(historyURL: history)
let shared = TrayModel(historyURL: nil)
shared.receive(snapshot([session(.running, time: 1_800_000_000_002)]), connection: first)
shared.receive(snapshot([session(.completed, time: 1_800_000_000_001)]), connection: second)
check(shared.rows.first?.session.status == .running, "A stale completion heartbeat cannot hide a new turn in another editor")
model.receive(snapshot([session(.permission)], instance: instance), connection: first)
model.receive(snapshot([session(.permission)]), connection: second)
check(model.rows.count == 1 && model.editorCount == 2, "Deduplicate shared sessions across windows")
check(model.rows.filter(\.needsAttention).count == 1, "Count each session needing attention once")
model.clearDisconnected()
check(model.rows.count == 1, "Cannot dismiss live permission")
model.disconnect(first)
check(model.rows.first?.connected == true, "Other editor still owns the session")
model.disconnect(second)
model.expire(now: Date().addingTimeInterval(16))
check(model.rows.first?.connected == false, "Disconnected sessions are not live")
model.receive(snapshot([session(.running)], instance: instance), connection: first)
check(model.rows.first?.session.status == .running, "Reconnection replaces attention")
check(model.rows.filter(\.needsAttention).isEmpty, "Running sessions do not count as attention")
model.receive(snapshot([], instance: instance), connection: first)
check(model.rows.isEmpty, "Resolved requests do not become disconnected ghosts")
model.receive(snapshot([session(.completed, time: 1_800_000_000_001)], instance: instance), connection: first)
check(model.rows.filter(\.needsAttention).count == 1, "Unread completion increments the menu-bar badge")
let restored = TrayModel(historyURL: history)
check(restored.rows.isEmpty, "Restarts wait for authoritative unread state instead of restoring completed history")
restored.receive(snapshot([session(.completed)], instance: instance), connection: first)
check(restored.rows.count == 1, "Reconnect restores a still-unread completion")
restored.receive(snapshot([], instance: instance), connection: first)
check(restored.rows.isEmpty && restored.rows.filter(\.needsAttention).isEmpty, "Reading a completion removes its row and badge")
restored.receive(snapshot([session(.planReady, time: 1_800_000_000_001)], instance: instance), connection: first)
check(restored.rows.filter(\.needsAttention).count == 1, "Unread plans need attention")
restored.receive(snapshot([], instance: instance), connection: first)
check(restored.rows.isEmpty, "Read plans do not become disconnected history")
let legacyHistory = fixture.appendingPathComponent("legacy-history.json")
let legacyRow = String(decoding: try JSONEncoder().encode(session(.completed)), as: UTF8.self)
try Data("{\"sessions\":[\(legacyRow)],\"dismissed\":[]}".utf8).write(to: legacyHistory)
check(TrayModel(historyURL: legacyHistory).rows.isEmpty, "Upgrade discards previously retained read completions")
model.clearDisconnected()
check(model.rows.count == 1, "Clearing disconnected history cannot hide an unread reply")
model.receive(snapshot([session(.completed, time: 1_800_000_000_001)], instance: instance), connection: first)
check(model.rows.count == 1, "Unread completion remains while VS Code reports it")
let cleared = TrayModel(historyURL: history)
cleared.receive(snapshot([session(.completed, time: 1_800_000_000_001)]), connection: second)
check(cleared.rows.count == 1, "App restart shows VS Code unread state without local dismissal overrides")
model.receive(snapshot([session(.completed, time: 1_800_000_000_002)], instance: instance), connection: first)
check(model.rows.count == 1, "New turn completion is not dismissed")
model.receive(snapshot([session(.question)], instance: instance), connection: second)
model.disconnect(first)
check(model.editorCount == 1 && model.rows.first?.connected == true, "Old disconnect cannot remove replacement editor")
model.expire(now: Date().addingTimeInterval(61))
check(model.editorCount == 0 && model.rows.first?.connected == false, "Heartbeat expiry removes live badges")
model.receive(TraySnapshot(version: 1, instanceID: instance, available: false, sessions: [session(.running)]), connection: first)
check(model.rows.first?.connected == true, "A connected editor still owns its reported running state during a backend outage")

let clickHistory = fixture.appendingPathComponent("click-history.json")
let clicks = TrayModel(historyURL: clickHistory)
let clickedTurn = session(.completed, id: "clicked")
let otherTurn = session(.completed, id: "other")
var badgeCounts: [Int] = []
let badgeSubscription = clicks.$rows.sink { badgeCounts.append($0.filter(\.needsAttention).count) }
clicks.receive(snapshot([clickedTurn, otherTurn], instance: instance), connection: first)
check(badgeCounts.last == 2, "Badge subscribes to both unread completions")
check(clicks.openProject(clickedTurn, using: { url in
  check(url == projectURL(clickedTurn.projectUrl), "Navigation uses the clicked project URL")
  check(badgeCounts.last == 2, "Do not clear the badge before the project handoff succeeds")
  return true
}), "Accept successful project handoff")
check(badgeCounts.last == 2, "Window navigation leaves the badge unchanged until VS Code reports the chat read")
clicks.receive(snapshot([clickedTurn, otherTurn], instance: instance), connection: first)
clicks.receive(snapshot([clickedTurn]), connection: second)
check(clicks.rows.count == 2, "All chats still reported unread remain visible")
let clickRestart = TrayModel(historyURL: clickHistory)
clickRestart.receive(snapshot([clickedTurn, otherTurn]), connection: first)
check(clickRestart.rows.count == 2, "Navigation does not persist a local override of unread state")
clicks.receive(snapshot([otherTurn], instance: instance), connection: first)
check(badgeCounts.last == 2, "A chat still unread in another editor remains in the tray")
clicks.disconnect(second)
clicks.expire(now: Date().addingTimeInterval(16))
check(badgeCounts.last == 1 && clicks.rows.map(\.id) == ["other"], "Badge updates synchronously when the authoritative live snapshots clear the unread reply")
let newTurn = session(.completed, id: "clicked", time: 1_800_000_000_001)
clicks.receive(snapshot([newTurn, otherTurn], instance: instance), connection: first)
check(badgeCounts.last == 2, "A later turn needs attention again")
clicks.openProject(clickedTurn, using: { _ in true })
check(badgeCounts.last == 2, "Clicking an old rendered row cannot acknowledge a newer completion")
badgeSubscription.cancel()

let failedOpen = TrayModel(historyURL: nil)
failedOpen.receive(snapshot([clickedTurn]), connection: first)
check(!failedOpen.openProject(clickedTurn, using: { _ in false }), "Report failed window handoff")
check(failedOpen.rows.filter(\.needsAttention).count == 1 && failedOpen.error != nil, "Failed navigation keeps unread attention")
for status: SessionStatus in [.permission, .question, .error, .running] {
  let pending = session(status)
  failedOpen.receive(snapshot([pending]), connection: first)
  failedOpen.openProject(pending, using: { _ in true })
  check(failedOpen.rows.first?.session.status == status, "Navigation does not resolve \(status.rawValue)")
}
let plan = session(.planReady, time: 1_800_000_000_002)
failedOpen.receive(snapshot([plan]), connection: first)
failedOpen.openProject(plan, using: { _ in true })
check(failedOpen.rows.first?.session.status == .planReady, "A plan remains unread until VS Code acknowledges it")

let sharedRead = TrayModel(historyURL: nil)
sharedRead.receive(snapshot([clickedTurn], instance: instance), connection: first)
let otherInstance = UUID().uuidString
sharedRead.receive(snapshot([clickedTurn], instance: otherInstance), connection: second)
sharedRead.receive(snapshot([], instance: instance), connection: first)
check(sharedRead.rows.count == 1, "Keep attention while an editor still reports it unread")
sharedRead.receive(snapshot([clickedTurn], instance: otherInstance), connection: second)
check(sharedRead.rows.count == 1, "Tray mirrors the editor's unread state without local suppression")
sharedRead.receive(snapshot([], instance: otherInstance), connection: second)
check(sharedRead.rows.isEmpty, "Clear the tray when all live editor snapshots report read")
sharedRead.receive(snapshot([newTurn], instance: otherInstance), connection: second)
check(sharedRead.rows.filter(\.needsAttention).count == 1, "Read acknowledgement does not hide newer cross-editor completions")
sharedRead.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: false, sessions: []), connection: second)
sharedRead.receive(snapshot([newTurn], instance: otherInstance), connection: second)
check(sharedRead.rows.filter(\.needsAttention).count == 1, "Backend outage is not a read acknowledgement")

let allAttention = TrayModel(historyURL: nil)
let categories: [SessionStatus] = [.completed, .planReady, .permission, .question, .error, .running]
let attentionRows = categories.map { session($0, id: $0.rawValue) }
allAttention.receive(snapshot(attentionRows, instance: instance), connection: first)
check(allAttention.rows.filter(\.needsAttention).count == 5, "Badge covers unread replies, plans, permissions, questions, and errors but not running work")
let errorRow = session(.error, id: "error")
allAttention.receive(snapshot([errorRow]), connection: second)
allAttention.receive(snapshot(attentionRows.filter { $0.status != .error }, instance: instance), connection: first)
check(allAttention.rows.filter(\.needsAttention).count == 5, "An error reported unread by another editor still needs attention")
allAttention.receive(snapshot([]), connection: second)
check(allAttention.rows.filter(\.needsAttention).count == 4, "Seen errors clear once no editor reports them unread")

let projectsModel = TrayModel(historyURL: nil)
let workspaceURL = "vscode://file/Users/test/Projects.code-workspace"
let projectA = TrayProject(id: "/projects/a", name: "Project A", url: workspaceURL)
let projectB = TrayProject(id: "/projects/b", name: "Project B", url: workspaceURL)
projectsModel.receive(TraySnapshot(version: 1, instanceID: instance, available: false, sessions: [], projects: [projectA, projectB]), connection: first)
check(projectsModel.editorCount == 1 && projectsModel.projects.count == 2, "Idle projects appear even before their backend is available")
check(projectsModel.projects.map(\.id) == [projectA.id, projectB.id], "Multi-root folders stay distinct despite sharing a window URL")
check(projectsModel.rows.isEmpty, "Project registration does not create activity rows")
projectsModel.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: true, sessions: [], projects: [projectA]), connection: second)
check(projectsModel.editorCount == 2 && projectsModel.projects.count == 2, "Deduplicate projects across editor windows")
projectsModel.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [], projects: [projectB]), connection: first)
check(projectsModel.projects.count == 2, "A folder stays listed while another editor still has it open")
projectsModel.disconnect(second)
projectsModel.expire(now: Date().addingTimeInterval(16))
check(projectsModel.projects.map(\.id) == [projectB.id], "Remove an idle project after its last editor disconnects")
let renamed = TrayProject(id: projectB.id, name: "Renamed project", url: workspaceURL)
projectsModel.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [], projects: [renamed]), connection: first)
check(projectsModel.projects.first?.name == "Renamed project", "Refresh project names without session activity")
let firstRootRow = TraySession(id: "a-session", title: "A", project: projectA.name, projectUrl: workspaceURL, status: .running, updatedAt: 1_800_000_000_000, projectID: projectA.id)
let secondRootRow = TraySession(id: "b-session", title: "B", project: projectB.name, projectUrl: workspaceURL, status: .running, updatedAt: 1_800_000_000_000, projectID: projectB.id)
projectsModel.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [firstRootRow, secondRootRow], projects: [projectA, projectB]), connection: first)
check(projectsModel.rows.filter { $0.session.projectKey == projectA.id }.map(\.id) == ["a-session"], "Project filters select only their folder's sessions")
projectsModel.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [], projects: [projectA, projectB]), connection: first)
check(projectsModel.projects.count == 2 && projectsModel.rows.isEmpty, "Open projects remain after all activity clears")
projectsModel.expire(now: Date().addingTimeInterval(61))
check(projectsModel.projects.isEmpty, "Heartbeat expiry removes idle project registrations")
projectsModel.receive(snapshot([session(.running)]), connection: first)
check(projectsModel.projects.first?.id == session(.running).projectUrl, "Legacy snapshots still derive project choices from their sessions")

let reconnecting = TrayModel(historyURL: nil)
let clock = Date()
let expiry = TrayModel(historyURL: nil)
check(expiry.nextExpiration == nil, "No expiry checks before an extension connects")
expiry.disconnect(first, now: clock)
check(expiry.nextExpiration == nil, "An unregistered socket disconnect cannot start expiry checks")
expiry.receive(snapshot([]), connection: first, now: clock)
check(expiry.nextExpiration == clock.addingTimeInterval(60), "An idle editor schedules only its heartbeat deadline")
expiry.receive(snapshot([session(.running)]), connection: second, now: clock.addingTimeInterval(5))
check(expiry.nextExpiration == clock.addingTimeInterval(60), "Multiple editors use the earliest deadline")
expiry.receive(snapshot([]), connection: first, now: clock.addingTimeInterval(10))
check(expiry.nextExpiration == clock.addingTimeInterval(65), "A heartbeat advances the next expiry deadline")
expiry.disconnect(first, now: clock.addingTimeInterval(11))
check(expiry.nextExpiration == clock.addingTimeInterval(26), "Disconnect schedules a single reconnect-grace cleanup")
expiry.expire(now: clock.addingTimeInterval(26))
check(expiry.editorCount == 1 && expiry.nextExpiration == clock.addingTimeInterval(65), "Cleanup schedules only the remaining editor's deadline")
expiry.expire(now: clock.addingTimeInterval(65))
check(expiry.editorCount == 0 && expiry.nextExpiration == nil, "The last heartbeat expiry stops checks entirely")
check(expiry.rows.count == 1 && expiry.rows.allSatisfy { !$0.connected }, "Disconnected history does not schedule checks")
expiry.receive(snapshot([session(.permission)], instance: instance), connection: first, now: clock.addingTimeInterval(70))
expiry.disconnect(first, now: clock.addingTimeInterval(71))
expiry.receive(snapshot([session(.permission)], instance: instance), connection: second, now: clock.addingTimeInterval(72))
check(expiry.nextExpiration == clock.addingTimeInterval(132), "Reconnect replaces the pending disconnect cleanup")
expiry.disconnect(first, now: clock.addingTimeInterval(73))
check(expiry.nextExpiration == clock.addingTimeInterval(132), "An old socket disconnect cannot shorten the replacement lease")
expiry.disconnect(second, now: clock.addingTimeInterval(74))
expiry.expire(now: clock.addingTimeInterval(89))
check(expiry.nextExpiration == nil && expiry.rows.allSatisfy { !$0.connected }, "Final disconnect cleanup leaves no timer deadline")
check(TrayModel(historyURL: history).nextExpiration == nil, "Restored history cannot start idle checks")
let quiet = TrayModel(historyURL: nil)
let quietSnapshot = TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [clickedTurn], projects: [projectA], eventDriven: true)
quiet.receive(quietSnapshot, connection: first, now: clock)
check(quiet.nextExpiration == nil, "Event-driven editors do not schedule heartbeat checks")
quiet.expire(now: clock.addingTimeInterval(3600))
check(quiet.editorCount == 1 && quiet.rows.first?.needsAttention == true && quiet.projects.count == 2, "Quiet event-driven connections retain their unread badge and projects")
quiet.receive(snapshot([]), connection: second, now: clock)
check(quiet.nextExpiration == clock.addingTimeInterval(60), "Legacy editors retain heartbeat expiry alongside quiet event-driven editors")
quiet.expire(now: clock.addingTimeInterval(60))
check(quiet.editorCount == 1 && quiet.nextExpiration == nil, "Legacy expiry does not remove a quiet event-driven editor")
quiet.disconnect(first, now: clock.addingTimeInterval(61))
check(quiet.nextExpiration == clock.addingTimeInterval(76), "Event-driven disconnects retain one-shot reconnect cleanup")
quiet.expire(now: clock.addingTimeInterval(76))
check(quiet.editorCount == 0 && quiet.nextExpiration == nil && quiet.rows.isEmpty, "Final event-driven disconnect clears unread state and leaves no timer")
let reconnectSnapshot = TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [clickedTurn, session(.running)], projects: [projectA, projectB])
reconnecting.receive(reconnectSnapshot, connection: first, now: clock)
reconnecting.disconnect(first, now: clock.addingTimeInterval(1))
reconnecting.expire(now: clock.addingTimeInterval(12))
check(reconnecting.projects.count == 3 && reconnecting.rows.filter(\.needsAttention).count == 1, "A brief socket reset preserves projects and unread count")
reconnecting.receive(reconnectSnapshot, connection: second, now: clock.addingTimeInterval(13))
reconnecting.disconnect(first, now: clock.addingTimeInterval(14))
check(reconnecting.editorCount == 1 && reconnecting.rows.count == 2, "A reconnect replaces its old lease without duplicating or losing sessions")
reconnecting.expire(now: clock.addingTimeInterval(40))
check(reconnecting.editorCount == 1, "Delayed heartbeats do not immediately remove a busy editor")
reconnecting.receive(TraySnapshot(version: 1, instanceID: instance, available: false, sessions: [clickedTurn, session(.running)], projects: [projectA, projectB]), connection: second, now: clock.addingTimeInterval(41))
check(reconnecting.rows.filter(\.needsAttention).count == 1 && reconnecting.rows.filter { $0.connected && $0.session.status == .running }.count == 1, "Backend reconnects do not hide a reported unread reply or running session")
reconnecting.receive(TraySnapshot(version: 1, instanceID: instance, available: false, sessions: [], projects: [projectA, projectB]), connection: second, now: clock.addingTimeInterval(42))
check(reconnecting.rows.filter(\.needsAttention).isEmpty, "Explicit read state still clears attention while the backend is unavailable")
check(reconnecting.rows.isEmpty, "A connected editor removing activity cannot turn its previous row into a disconnected ghost")
reconnecting.disconnect(second, now: clock.addingTimeInterval(43))
reconnecting.expire(now: clock.addingTimeInterval(59))
check(reconnecting.editorCount == 0 && reconnecting.projects.allSatisfy { $0.id != projectA.id && $0.id != projectB.id }, "Closed editors and their idle projects expire after reconnect grace")

let reconnectHistory = fixture.appendingPathComponent("reconnect-history.json")
let beforeRestart = TrayModel(historyURL: reconnectHistory)
beforeRestart.receive(TraySnapshot(version: 1, instanceID: instance, available: true, sessions: [firstRootRow, secondRootRow], projects: [projectA, projectB]), connection: first)
let afterRestart = TrayModel(historyURL: reconnectHistory)
check(afterRestart.rows.count == 2 && afterRestart.rows.allSatisfy { !$0.connected }, "Restart retains offline history until its project reports current state")
afterRestart.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: false, sessions: [], projects: [projectA]), connection: second)
check(afterRestart.rows.count == 2, "Initial backend startup cannot reconcile saved history yet")
afterRestart.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: true, sessions: [], projects: [projectA]), connection: second)
check(afterRestart.rows.map(\.id) == [secondRootRow.id], "A fresh project snapshot removes saved activity omitted after restart without affecting another root sharing its window URL")
afterRestart.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: true, sessions: [firstRootRow], projects: [projectA]), connection: second)
check(afterRestart.rows.first { $0.id == firstRootRow.id }?.connected == true, "A currently running chat is restored as live when the editor reports it")
let cappedHistory = TrayModel(historyURL: reconnectHistory)
let cappedRows = (0..<256).map { session(.completed, id: "cap-\($0)") }
cappedHistory.receive(TraySnapshot(version: 1, instanceID: otherInstance, available: true, sessions: cappedRows, projects: [projectA]), connection: second)
check(cappedHistory.rows.contains { $0.id == firstRootRow.id }, "A capped snapshot cannot prove that omitted saved activity is finished")

var received: [TraySnapshot] = []
var disconnected = 0
let server = TrayServer(onSnapshot: { _, snapshot in received.append(snapshot) }, onDisconnect: { _ in disconnected += 1 })
try server.start(directory: fixture)
let duplicate = TrayServer(onSnapshot: { _, _ in }, onDisconnect: { _ in })
do {
  try duplicate.start(directory: fixture)
  fatalError("Duplicate listener acquired the socket")
} catch { check(true, "Instance lock prevents socket replacement") }
let fd = connect(fixture.appendingPathComponent("tray.sock").path)
let rowData = try JSONEncoder().encode(session(.question))
let rowJSON = String(decoding: rowData, as: UTF8.self)
let prefix = "{\"version\":1,\"available\":true,\"instanceID\":\"\(instance)\",\"sessions\":["
var timedTurn = session(.running)
timedTurn.turnStartedAt = timedTurn.updatedAt - 60_000
let timedJSON = String(decoding: try JSONEncoder().encode(timedTurn), as: UTF8.self)
let decodedTurn = TraySnapshot.decode(Data((prefix + timedJSON + "]}").utf8))?.sessions.first
check(decodedTurn?.turnDate == timedTurn.date.addingTimeInterval(-60), "Turn timer uses the turn start instead of the latest status change")
check(session(.running).turnDate == session(.running).date, "Legacy publishers retain a timer fallback")
for invalidStart: Double in [0, -1, .infinity, .nan, 100_000_000_000_000] {
  timedTurn.turnStartedAt = invalidStart
  check(!timedTurn.isValid, "Reject invalid turn start timestamps")
}
let frame = prefix + rowJSON + "]}\n"
send(prefix, to: fd)
send(rowJSON + "]}\n" + frame, to: fd)
pump { received.count == 2 }
check(received.first?.sessions.first?.status == .question, "Decode fragmented and coalesced frames")
check(TraySnapshot.decode(Data(frame.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8)) == nil, "Reject incompatible protocol")
check(TraySnapshot.decode(Data((prefix + rowJSON + "," + rowJSON + "]}").utf8)) == nil, "Reject duplicate session IDs")
let catalogFrame = "{\"version\":1,\"available\":true,\"instanceID\":\"\(instance)\",\"sessions\":[],\"projects\":[{\"id\":\"/projects/a\",\"name\":\"Project A\",\"url\":\"\(workspaceURL)\"}]}"
check(TraySnapshot.decode(Data(catalogFrame.utf8))?.projects?.count == 1, "Decode project catalogs without sessions")
let eventFrame = catalogFrame.dropLast() + ",\"eventDriven\":true}"
check(TraySnapshot.decode(Data(eventFrame.utf8))?.eventDriven == true, "Decode the event-driven publisher capability")
check(TraySnapshot.decode(Data(catalogFrame.utf8))?.eventDriven == nil, "Legacy publishers remain heartbeat-based")
check(TraySnapshot.decode(Data(eventFrame.replacingOccurrences(of: "\"eventDriven\":true", with: "\"eventDriven\":\"true\"").utf8)) == nil, "Reject a malformed event-driven capability")
check(TraySnapshot.decode(Data(catalogFrame.replacingOccurrences(of: workspaceURL, with: "https://example.com").utf8)) == nil, "Reject invalid project navigation URLs")
send("{invalid}\n", to: fd)
pump { disconnected == 1 }
close(fd)
server.stop()
check(!FileManager.default.fileExists(atPath: fixture.appendingPathComponent("tray.sock").path), "Remove socket on shutdown")
try server.start(directory: fixture)
server.stop()
check(true, "Restart listener after shutdown")
print("Passed \(assertions) native tray checks")
