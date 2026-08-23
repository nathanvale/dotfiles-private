import Darwin
import Foundation

public enum BrowserUseCustodySnapshot {
    private static let maxFileBytes = 8 * 1024 * 1024
    private static let maxLeaseCount = 10_000

    private struct Identity: Equatable {
        let device: UInt64
        let inode: UInt64
        let mode: UInt16

        var object: [String: Any] {
            ["device": device, "inode": inode, "mode": mode]
        }
    }

    private static func identity(_ descriptor: Int32, kind: mode_t) -> Identity? {
        var value = stat()
        guard fstat(descriptor, &value) == 0,
              value.st_mode & S_IFMT == kind
        else { return nil }
        return Identity(
            device: UInt64(value.st_dev),
            inode: UInt64(value.st_ino),
            mode: UInt16(value.st_mode & 0o777)
        )
    }

    private static func readAll(_ descriptor: Int32) -> Data? {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 32 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { return result }
            if count < 0 { return nil }
            result.append(buffer, count: count)
            if result.count > maxFileBytes { return nil }
        }
    }

    private static func names(_ descriptor: Int32) -> [String]? {
        let duplicate = Darwin.dup(descriptor)
        guard duplicate >= 0, let directory = fdopendir(duplicate) else {
            if duplicate >= 0 { _ = Darwin.close(duplicate) }
            return nil
        }
        defer { closedir(directory) }
        rewinddir(directory)
        var result: [String] = []
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name == "." || name == ".." { continue }
            guard name.range(of: "^[a-f0-9]{32}\\.json$", options: .regularExpression) != nil else {
                return nil
            }
            result.append(name)
            if result.count > maxLeaseCount { return nil }
        }
        return result.sorted()
    }

    private static func exactPath(_ raw: String) -> Bool {
        guard raw.hasPrefix("/"), !raw.contains("\0"),
              let resolved = realpath(raw, nil)
        else { return false }
        defer { free(resolved) }
        return String(cString: resolved) == raw
    }

    private static func rejection(_ code: String) -> Data {
        let value: [String: Any] = [
            "contract": "browser-use.native-custody-snapshot",
            "schema_version": "1",
            "ok": false,
            "rejection": ["code": code],
        ]
        return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
            ?? Data("{\"ok\":false}".utf8)
    }

    /**
     * Capture registry and lease bytes only through directory-relative,
     * no-follow descriptors. The caller holds Browser Use's canonical custody
     * mutation barrier; this helper proves the paths did not alias or change
     * during the bounded read.
     */
    public static func capture(stateRoot: String) -> Data {
        captureForTesting(stateRoot: stateRoot, beforeFinalValidation: nil)
    }

    @_spi(Testing)
    public static func captureForTesting(
        stateRoot: String,
        beforeFinalValidation: (() -> Void)?
    ) -> Data {
        guard exactPath(stateRoot) else { return rejection("custody-root-aliased") }
        let root = Darwin.open(stateRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { return rejection("custody-root-unavailable") }
        defer { _ = Darwin.close(root) }
        guard let rootIdentity = identity(root, kind: S_IFDIR) else {
            return rejection("custody-root-invalid")
        }

        let custody = openat(root, "browser-custody", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard custody >= 0 else { return rejection("custody-directory-unavailable") }
        defer { _ = Darwin.close(custody) }
        let leases = openat(root, "leases", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard leases >= 0 else { return rejection("custody-leases-unavailable") }
        defer { _ = Darwin.close(leases) }
        guard let custodyIdentity = identity(custody, kind: S_IFDIR),
              let leasesIdentity = identity(leases, kind: S_IFDIR)
        else { return rejection("custody-directory-invalid") }

        let registry = openat(custody, "registry.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard registry >= 0 else { return rejection("custody-registry-unavailable") }
        defer { _ = Darwin.close(registry) }
        guard let registryIdentity = identity(registry, kind: S_IFREG),
              let registryData = readAll(registry),
              let registryRaw = String(data: registryData, encoding: .utf8)
        else { return rejection("custody-registry-invalid") }

        guard let beforeNames = names(leases) else {
            return rejection("custody-lease-inventory-invalid")
        }
        var leaseObjects: [[String: Any]] = []
        for name in beforeNames {
            let descriptor = openat(leases, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard descriptor >= 0 else { return rejection("custody-lease-unavailable") }
            guard let before = identity(descriptor, kind: S_IFREG),
                  let data = readAll(descriptor),
                  let raw = String(data: data, encoding: .utf8),
                  let after = identity(descriptor, kind: S_IFREG),
                  before == after
            else {
                _ = Darwin.close(descriptor)
                return rejection("custody-lease-changed")
            }
            _ = Darwin.close(descriptor)
            let current = openat(leases, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard current >= 0, identity(current, kind: S_IFREG) == before else {
                if current >= 0 { _ = Darwin.close(current) }
                return rejection("custody-lease-substituted")
            }
            _ = Darwin.close(current)
            leaseObjects.append(["name": name, "raw": raw, "identity": before.object])
        }

        beforeFinalValidation?()
        let currentRegistry = openat(custody, "registry.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard currentRegistry >= 0,
              identity(currentRegistry, kind: S_IFREG) == registryIdentity
        else {
            if currentRegistry >= 0 { _ = Darwin.close(currentRegistry) }
            return rejection("custody-registry-substituted")
        }
        _ = Darwin.close(currentRegistry)
        guard names(leases) == beforeNames else {
            return rejection("custody-lease-inventory-changed")
        }

        let rootAgain = Darwin.open(stateRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootAgain >= 0, identity(rootAgain, kind: S_IFDIR) == rootIdentity else {
            if rootAgain >= 0 { _ = Darwin.close(rootAgain) }
            return rejection("custody-root-substituted")
        }
        let custodyAgain = openat(rootAgain, "browser-custody", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        let leasesAgain = openat(rootAgain, "leases", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        defer {
            if custodyAgain >= 0 { _ = Darwin.close(custodyAgain) }
            if leasesAgain >= 0 { _ = Darwin.close(leasesAgain) }
            _ = Darwin.close(rootAgain)
        }
        guard custodyAgain >= 0, leasesAgain >= 0,
              identity(custodyAgain, kind: S_IFDIR) == custodyIdentity,
              identity(leasesAgain, kind: S_IFDIR) == leasesIdentity
        else { return rejection("custody-directory-substituted") }

        let value: [String: Any] = [
            "contract": "browser-use.native-custody-snapshot",
            "schema_version": "1",
            "ok": true,
            "data": [
                "root_path": stateRoot,
                "root_realpath": stateRoot,
                "root_identity": rootIdentity.object,
                "custody_identity": custodyIdentity.object,
                "leases_identity": leasesIdentity.object,
                "registry_identity": registryIdentity.object,
                "registry_raw": registryRaw,
                "lease_records": leaseObjects,
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
            ?? rejection("custody-snapshot-encoding-failed")
    }
}
