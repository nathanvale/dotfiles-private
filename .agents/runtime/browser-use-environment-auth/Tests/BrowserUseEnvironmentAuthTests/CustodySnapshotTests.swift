@_spi(Testing) import BrowserUseEnvironmentAuth
import Foundation
import Testing

@Suite
struct CustodySnapshotTests {
    private func fixture() throws -> URL {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("custody-snapshot-fixtures", isDirectory: true)
            .resolvingSymlinksInPath()
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let custody = root.appendingPathComponent("browser-custody", isDirectory: true)
        let leases = root.appendingPathComponent("leases", isDirectory: true)
        try FileManager.default.createDirectory(
            at: custody,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.createDirectory(
            at: leases,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try Data("{\"revision\":1}".utf8).write(
            to: custody.appendingPathComponent("registry.json"),
            options: .withoutOverwriting
        )
        try Data("{\"lease\":1}".utf8).write(
            to: leases.appendingPathComponent(String(repeating: "a", count: 32) + ".json"),
            options: .withoutOverwriting
        )
        return root
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test
    func readsOneSortedNoFollowSnapshot() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try object(BrowserUseCustodySnapshot.capture(stateRoot: root.path))
        #expect(result["ok"] as? Bool == true)
        let data = try #require(result["data"] as? [String: Any])
        #expect(data["registry_raw"] as? String == "{\"revision\":1}")
        #expect((data["lease_records"] as? [[String: Any]])?.count == 1)
    }

    @Test
    func rejectsSymlinkRegistry() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = root.appendingPathComponent("browser-custody/registry.json")
        let outside = root.appendingPathComponent("outside.json")
        try FileManager.default.removeItem(at: registry)
        try Data("{}".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: registry, withDestinationURL: outside)
        let result = try object(BrowserUseCustodySnapshot.capture(stateRoot: root.path))
        #expect(result["ok"] as? Bool == false)
    }

    @Test
    func rejectsRegistryInodeSubstitutionDuringCapture() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = root.appendingPathComponent("browser-custody/registry.json")
        let replacement = root.appendingPathComponent("browser-custody/replacement.json")
        try Data("{\"revision\":2}".utf8).write(to: replacement)
        let result = try object(BrowserUseCustodySnapshot.captureForTesting(
            stateRoot: root.path,
            beforeFinalValidation: {
                try? FileManager.default.removeItem(at: registry)
                try? FileManager.default.moveItem(at: replacement, to: registry)
            }
        ))
        #expect(result["ok"] as? Bool == false)
        #expect((result["rejection"] as? [String: Any])?["code"] as? String == "custody-registry-substituted")
    }
}
