import AppKit
import SwiftUI
import ServiceManagement

private enum TrayHeightPart: Hashable {
  case header, content, error
}

private struct TrayHeightPreference: PreferenceKey {
  static let defaultValue: [TrayHeightPart: CGFloat] = [:]

  static func reduce(value: inout [TrayHeightPart: CGFloat], nextValue: () -> [TrayHeightPart: CGFloat]) {
    value.merge(nextValue(), uniquingKeysWith: { _, next in next })
  }
}

struct TrayView: View {
  @ObservedObject var model: TrayModel
  @State private var project = ""
  @State private var loginEnabled = SMAppService.mainApp.status == .enabled
  @State private var heights: [TrayHeightPart: CGFloat] = [:]
  let open: (TraySession) -> Void

  private var filtered: [SessionRow] { model.rows.filter { project.isEmpty || $0.session.projectKey == project } }
  private var scrollHeight: CGFloat {
    min(heights[.content] ?? 0, max(0, 520 - (heights[.header] ?? 100) - (heights[.error] ?? 0)))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("Varro").font(.headline)
          Text("Experimental").font(.caption).foregroundStyle(.secondary)
          Spacer()
          Menu {
            Button("Clear disconnected sessions", action: model.clearDisconnected)
            Toggle("Launch at login", isOn: Binding(get: { loginEnabled }, set: setLogin))
            Divider()
            Button("Quit Varro") { NSApp.terminate(nil) }.keyboardShortcut("q")
          } label: { Image(systemName: "gearshape") }
          .menuStyle(.borderlessButton)
          .focusable(false)
          .fixedSize()
          .accessibilityLabel("Varro settings")
        }.padding(16)

        Picker("Project", selection: $project) {
          Text("All projects").tag("")
          ForEach(model.projects) { entry in
            Text(entry.name).tag(entry.id)
          }
        }.focusable(false).padding(.horizontal, 16).padding(.bottom, 12)

        Divider()
      }.background(heightMeasurement(.header))
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if filtered.isEmpty {
            VStack(spacing: 10) {
              Image(systemName: "tray").font(.system(size: 28)).foregroundStyle(.secondary)
              Text("No session activity").font(.headline)
              Text(model.editorCount == 0 ? "Open a local VS Code project with Varro to connect." : "Running sessions and new updates will appear here.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity).padding(.vertical, 36)
          }
          section("Needs attention", rows: filtered.filter { $0.needsAttention && $0.session.status != .completed })
          section("Unread completions", rows: filtered.filter { $0.connected && $0.session.status == .completed })
          section("Active", rows: filtered.filter { $0.connected && $0.session.status == .running })
          section("Disconnected", rows: filtered.filter { !$0.connected && $0.session.status != .completed && $0.session.status != .planReady })
        }.padding(16)
          .fixedSize(horizontal: false, vertical: true)
          .background(heightMeasurement(.content))
      }.frame(height: scrollHeight)
      if let error = model.error {
        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled).padding(12)
          .fixedSize(horizontal: false, vertical: true)
          .background(heightMeasurement(.error))
      }
    }
    .frame(width: 390)
    .fixedSize(horizontal: false, vertical: true)
    .onPreferenceChange(TrayHeightPreference.self) { heights = $0 }
    .onChange(of: model.projects) { values in
      if !project.isEmpty && !values.contains(where: { $0.id == project }) { project = "" }
    }
  }

  private func heightMeasurement(_ part: TrayHeightPart) -> some View {
    GeometryReader { geometry in
      Color.clear.preference(key: TrayHeightPreference.self, value: [part: geometry.size.height])
    }
  }

  @ViewBuilder private func section(_ title: String, rows: [SessionRow]) -> some View {
    if !rows.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text("\(title) · \(rows.count)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        ForEach(rows) { row in
          Button { open(row.session) } label: {
            HStack(alignment: .top, spacing: 6) {
              Image(systemName: row.session.status.symbol)
                .foregroundStyle(.primary)
                .frame(width: 18).padding(.top, 2)
              VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                  Text(row.session.project).font(.callout.weight(.semibold))
                    .lineLimit(1).truncationMode(.middle).layoutPriority(1)
                  Spacer(minLength: 8)
                  Text(row.session.status.label).font(.caption).foregroundStyle(.secondary)
                }
                Text(row.session.title).font(.callout).lineLimit(2).multilineTextAlignment(.leading)
                if !row.connected {
                  Text("Connection unavailable").font(.caption).foregroundStyle(.secondary)
                }
              }
            }.padding(.leading, 6).padding(.trailing, 10).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
              .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
              .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.08)))
              .contentShape(Rectangle())
          }.buttonStyle(.plain)
            .help("Open \(row.session.project) in VS Code")
        }
      }
    }
  }

  private func setLogin(_ enabled: Bool) {
    do {
      if enabled { try SMAppService.mainApp.register() }
      else { try SMAppService.mainApp.unregister() }
      loginEnabled = SMAppService.mainApp.status == .enabled
      if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    } catch {
      model.error = "Could not change launch at login: \(error.localizedDescription)"
    }
  }
}
