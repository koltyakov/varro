import Foundation
import Combine

enum SessionStatus: String, Codable {
  case running, permission, question, error, completed
  case planReady = "plan-ready"

  var label: String {
    switch self {
    case .running: return "Running"
    case .permission: return "Approval needed"
    case .question: return "Question waiting"
    case .error: return "Session failed"
    case .planReady: return "Plan ready"
    case .completed: return "Completed"
    }
  }

  var symbol: String {
    switch self {
    case .running: return "arrow.triangle.2.circlepath"
    case .permission: return "lock.circle"
    case .question: return "questionmark.circle"
    case .error: return "exclamationmark.circle"
    case .planReady: return "doc.text.magnifyingglass"
    case .completed: return "checkmark.circle"
    }
  }

  var needsAttention: Bool { self != .running }
  var isCompletion: Bool { self == .completed || self == .planReady }
  var isReadAttention: Bool { isCompletion || self == .error }
}

struct TraySession: Codable, Equatable, Identifiable {
  let id: String
  let title: String
  let project: String
  let projectUrl: String
  let status: SessionStatus
  let updatedAt: Double
  var projectID: String? = nil
  var turnStartedAt: Double? = nil

  var date: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
  var turnDate: Date { Date(timeIntervalSince1970: (turnStartedAt ?? updatedAt) / 1000) }
  var projectKey: String { projectID ?? projectUrl }

  var isValid: Bool {
    !id.isEmpty && id.utf8.count <= 256 && title.utf8.count <= 2048 &&
      project.utf8.count <= 2048 && projectURL(projectUrl) != nil &&
      updatedAt.isFinite && updatedAt > 0 && updatedAt < 100_000_000_000_000 &&
      (turnStartedAt.map { $0.isFinite && $0 > 0 && $0 < 100_000_000_000_000 } ?? true) &&
      (projectID.map { !$0.isEmpty && $0.utf8.count <= 8192 } ?? true)
  }
}

struct TrayProject: Decodable, Equatable, Identifiable {
  let id: String
  let name: String
  let url: String

  var isValid: Bool {
    !id.isEmpty && id.utf8.count <= 8192 && !name.isEmpty && name.utf8.count <= 2048 && projectURL(url) != nil
  }
}

// Only project-window URLs are accepted. Never run a command or a session-selection URI.
func projectURL(_ value: String) -> URL? {
  guard value.utf8.count <= 8192,
        let parts = URLComponents(string: value),
        ["vscode", "vscode-insiders", "vscodium", "vscodium-insiders", "code-oss"].contains(parts.scheme ?? ""),
        parts.host == "file", parts.path.hasPrefix("/"), parts.path.count > 1,
        parts.user == nil, parts.password == nil, parts.port == nil,
        parts.query == nil, parts.fragment == nil else { return nil }
  return parts.url
}

struct TraySnapshot: Decodable {
  let version: Int
  let instanceID: String
  let available: Bool
  let sessions: [TraySession]
  var projects: [TrayProject]? = nil
  var eventDriven: Bool? = nil

  static func decode(_ data: Data) -> TraySnapshot? {
    guard data.count <= 1_048_576,
          let value = try? JSONDecoder().decode(TraySnapshot.self, from: data),
          value.version == 1, UUID(uuidString: value.instanceID) != nil,
          value.sessions.count <= 256, value.sessions.allSatisfy(\.isValid),
          Set(value.sessions.map(\.id)).count == value.sessions.count,
          value.projects.map({ $0.count <= 256 && $0.allSatisfy(\.isValid) && Set($0.map(\.id)).count == $0.count }) ?? true else { return nil }
    return value
  }
}

struct SessionRow: Identifiable {
  let session: TraySession
  let connected: Bool
  var id: String { session.id }
  var needsAttention: Bool { connected && session.status.needsAttention }
}

private struct SavedState: Codable {
  var sessions: [TraySession]
}

private struct EditorSnapshot {
  let value: TraySnapshot
  let receivedAt: Date
  var disconnectedAt: Date? = nil

  var expiresAt: Date? {
    if let disconnectedAt = disconnectedAt { return disconnectedAt.addingTimeInterval(15) }
    if value.eventDriven == true { return nil }
    return receivedAt.addingTimeInterval(60)
  }
}

/// Main-thread state. Snapshots replace a single editor's state atomically.
final class TrayModel: ObservableObject {
  @Published private(set) var rows: [SessionRow] = []
  @Published private(set) var editorCount = 0
  @Published private(set) var projects: [TrayProject] = []
  @Published private(set) var nextExpiration: Date?
  @Published var error: String?
  private var editors: [UUID: EditorSnapshot] = [:]
  private var history: [String: TraySession] = [:]
  private let historyURL: URL?
  private var savedData: Data?

  init(historyURL: URL?) {
    self.historyURL = historyURL
    if let url = historyURL, let data = try? Data(contentsOf: url), data.count <= 2_097_152,
       let saved = try? JSONDecoder().decode(SavedState.self, from: data) {
      // Completion read state must come from a connected editor, including after an upgrade.
      for row in saved.sessions.prefix(100) where row.isValid && !row.status.isReadAttention {
        history[row.id] = row
      }
    }
    rebuild()
  }

  func receive(_ snapshot: TraySnapshot, connection: UUID, now: Date = Date()) {
    let previous = editors[connection] ?? editors.values.first { $0.value.instanceID == snapshot.instanceID }
    if snapshot.sessions.count < 256 {
      let present = Set(snapshot.sessions.map(\.id))
      let previouslyReported = Set(previous?.value.sessions.map(\.id) ?? [])
      let projectIDs = Set((snapshot.projects ?? []).map(\.id))
      let projectURLs = Set((snapshot.projects ?? []).map(\.url))
      for row in history.values where !present.contains(row.id) {
        let ownsProject = row.projectID.map { projectIDs.contains($0) } ?? projectURLs.contains(row.projectUrl)
        // Reconcile saved history too, including the first report after an app or editor restart.
        // Wait for backend readiness for saved rows; live omissions already report current state.
        // A capped snapshot cannot prove that an omitted row is no longer current.
        if previouslyReported.contains(row.id) || (snapshot.available && ownsProject) {
          history.removeValue(forKey: row.id)
        }
      }
    }
    // A reconnect from the same editor replaces its earlier connection.
    editors = editors.filter { $0.key == connection || $0.value.value.instanceID != snapshot.instanceID }
    editors[connection] = EditorSnapshot(value: snapshot, receivedAt: now)
    for row in snapshot.sessions {
      if row.status.isReadAttention {
        history.removeValue(forKey: row.id)
        continue
      }
      if let old = history[row.id], old.updatedAt > row.updatedAt { continue }
      history[row.id] = row
    }
    rebuild()
    updateExpiration()
  }

  func disconnect(_ connection: UUID, now: Date = Date()) {
    // A socket reset is not a read acknowledgement or proof that a project was closed.
    // Keep the last report briefly while the extension reconnects after a socket reset.
    editors[connection]?.disconnectedAt = now
    updateExpiration()
  }

  func expire(now: Date = Date()) {
    let count = editors.count
    editors = editors.filter { $0.value.expiresAt.map { now < $0 } ?? true }
    if editors.count != count { rebuild() }
    updateExpiration()
  }

  private func updateExpiration() {
    let next = editors.values.compactMap(\.expiresAt).min()
    if nextExpiration != next { nextExpiration = next }
  }

  func clearDisconnected() {
    let removable = rows.filter { !$0.connected }
    for row in removable { history.removeValue(forKey: row.id) }
    rebuild()
  }

  @discardableResult
  func openProject(_ session: TraySession, using open: (URL) -> Bool) -> Bool {
    guard let url = projectURL(session.projectUrl), open(url) else {
      error = "Could not open \(session.project) in VS Code."
      return false
    }
    error = nil
    // Focusing a project is not proof that its unread chat was opened or its request resolved.
    // The extension's next snapshot is the only source of read/attention state.
    return true
  }

  private func rebuild() {
    var live: [String: TraySession] = [:]
    // A heartbeat with an old completion must not replace a newer running turn.
    // Receipt time breaks ties when windows observed the same transition.
    // Backend transport availability does not acknowledge unread messages or resolve requests.
    for editor in editors.values.sorted(by: { $0.receivedAt < $1.receivedAt }) {
      for row in editor.value.sessions {
        if let current = live[row.id], current.updatedAt > row.updatedAt { continue }
        live[row.id] = row
      }
    }
    let retained = history.values.sorted { $0.updatedAt > $1.updatedAt }.prefix(100)
    history = Dictionary(uniqueKeysWithValues: retained.map { ($0.id, $0) })
    var combined = history.mapValues { SessionRow(session: $0, connected: false) }
    for (id, row) in live { combined[id] = SessionRow(session: row, connected: true) }
    rows = combined.values.sorted { $0.session.updatedAt > $1.session.updatedAt }
    // Activity rows cover old extensions and disconnected history. Explicit editor catalogs
    // also include idle projects, and separate roots that share a saved workspace URL.
    var catalog: [String: TrayProject] = [:]
    for row in rows {
      let session = row.session
      catalog[session.projectKey] = TrayProject(id: session.projectKey, name: session.project, url: session.projectUrl)
    }
    for editor in editors.values.sorted(by: { $0.receivedAt < $1.receivedAt }) {
      for project in editor.value.projects ?? [] { catalog[project.id] = project }
    }
    projects = catalog.values.sorted {
      $0.name == $1.name ? $0.id < $1.id : $0.name.localizedStandardCompare($1.name) == .orderedAscending
    }
    editorCount = editors.count
    save()
  }

  private func save() {
    guard let url = historyURL else { return }
    do {
      let data = try JSONEncoder().encode(SavedState(
        sessions: history.values.sorted { $0.id < $1.id }
      ))
      if savedData == data { return }
      try data.write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      savedData = data
    } catch {
      self.error = "Could not save recent sessions: \(error.localizedDescription)"
    }
  }
}
