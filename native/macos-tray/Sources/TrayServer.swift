import Foundation
import Darwin

enum TrayServerError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self { case .message(let message): return message }
  }
}

/// A same-user Unix socket. All I/O runs on one serial queue; UI callbacks run on main.
final class TrayServer {
  private let queue = DispatchQueue(label: "com.koltyakov.varro.tray.socket")
  private var listener: DispatchSourceRead?
  private var clients: [UUID: Client] = [:]
  private var lockFD: Int32 = -1
  private var path: String?
  private let onSnapshot: (UUID, TraySnapshot) -> Void
  private let onDisconnect: (UUID) -> Void

  private final class Client {
    let fd: Int32
    let source: DispatchSourceRead
    var buffer = Data()
    var instanceID: String?
    init(fd: Int32, source: DispatchSourceRead) { self.fd = fd; self.source = source }
  }

  init(onSnapshot: @escaping (UUID, TraySnapshot) -> Void, onDisconnect: @escaping (UUID) -> Void) {
    self.onSnapshot = onSnapshot
    self.onDisconnect = onDisconnect
  }

  static func prepareDirectory(_ directory: URL) throws {
    // The app may launch before Varro has created its shared state directory.
    for path in [directory.deletingLastPathComponent().path, directory.path] {
      if mkdir(path, 0o700) != 0 && errno != EEXIST {
        throw TrayServerError.message("Could not create the tray data directory: \(String(cString: strerror(errno)))")
      }
    }
    var info = stat()
    guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == getuid(), (info.st_mode & 0o077) == 0 else {
      throw TrayServerError.message("The tray data directory must be owned by you with permissions 700: \(directory.path)")
    }
  }

  func start(directory: URL) throws {
    try Self.prepareDirectory(directory)
    let socketPath = directory.appendingPathComponent("tray.sock").path
    var address = sockaddr_un()
    let bytes = Array(socketPath.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw TrayServerError.message("The tray socket path is too long: \(socketPath)")
    }
    let lock = open(directory.appendingPathComponent("tray.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw TrayServerError.message("Could not open the tray instance lock.") }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
      close(lock)
      throw TrayServerError.message("Varro's menu-bar app is already running.")
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { close(lock); throw TrayServerError.message("Could not create the tray socket.") }
    unlink(socketPath)
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { target in
      bytes.withUnsafeBytes { source in target.copyBytes(from: source) }
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, chmod(socketPath, 0o600) == 0, listen(fd, 16) == 0,
          fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
      close(fd); close(lock); unlink(socketPath)
      throw TrayServerError.message("Could not listen on the tray socket.")
    }
    lockFD = lock
    path = socketPath
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.acceptClients(fd) }
    source.setCancelHandler { close(fd) }
    listener = source
    source.resume()
  }

  func stop() {
    queue.sync {
      listener?.cancel()
      listener = nil
      for id in Array(clients.keys) { remove(id) }
      if let path = path { unlink(path) }
      path = nil
      if lockFD >= 0 { close(lockFD); lockFD = -1 }
    }
  }

  private func acceptClients(_ fd: Int32) {
    while true {
      let clientFD = accept(fd, nil, nil)
      if clientFD < 0 { return }
      var uid: uid_t = 0
      var gid: gid_t = 0
      guard clients.count < 32, getpeereid(clientFD, &uid, &gid) == 0, uid == getuid(),
            fcntl(clientFD, F_SETFL, O_NONBLOCK) == 0 else { close(clientFD); continue }
      let id = UUID()
      let source = DispatchSource.makeReadSource(fileDescriptor: clientFD, queue: queue)
      clients[id] = Client(fd: clientFD, source: source)
      source.setEventHandler { [weak self] in self?.readClient(id) }
      source.setCancelHandler { close(clientFD) }
      source.resume()
    }
  }

  private func readClient(_ id: UUID) {
    guard let client = clients[id] else { return }
    var bytes = [UInt8](repeating: 0, count: 16_384)
    // Bound each dispatch so a noisy writer cannot starve other editors.
    for _ in 0..<128 {
      let count = read(client.fd, &bytes, bytes.count)
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
      if count <= 0 { remove(id); return }
      client.buffer.append(contentsOf: bytes.prefix(count))
      while let newline = client.buffer.firstIndex(of: 10) {
        let frame = Data(client.buffer[..<newline])
        client.buffer.removeSubrange(...newline)
        guard let snapshot = TraySnapshot.decode(frame),
              client.instanceID == nil || client.instanceID == snapshot.instanceID else { remove(id); return }
        client.instanceID = snapshot.instanceID
        DispatchQueue.main.async { [onSnapshot] in onSnapshot(id, snapshot) }
      }
      if client.buffer.count > 1_048_576 { remove(id); return }
    }
  }

  private func remove(_ id: UUID) {
    guard let client = clients.removeValue(forKey: id) else { return }
    client.source.cancel()
    DispatchQueue.main.async { [onDisconnect] in onDisconnect(id) }
  }
}
