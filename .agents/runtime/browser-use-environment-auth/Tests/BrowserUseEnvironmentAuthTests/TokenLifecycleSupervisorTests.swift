import CryptoKit
import Darwin
import Foundation
import Testing
@_spi(Executor) import BrowserUseEnvironmentAuth

@Suite
struct TokenLifecycleSupervisorTests {
    private func supervisorPath() throws -> String {
        let path = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".build")
            .appendingPathComponent("debug")
            .appendingPathComponent("browser-use-op-supervisor")
            .path
        try #require(FileManager.default.isExecutableFile(atPath: path))
        return path
    }

    private func run(
        _ arguments: [String],
        environment: [String: String] = [
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
        ],
        stdin: Data? = nil
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: try supervisorPath())
        process.arguments = arguments
        process.environment = environment
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        if let stdin {
            let input = Pipe()
            process.standardInput = input
            try input.fileHandleForWriting.write(contentsOf: stdin)
            try input.fileHandleForWriting.close()
            try process.run()
        } else {
            process.standardInput = FileHandle.nullDevice
            try process.run()
        }
        process.waitUntilExit()
        return (
            process.terminationStatus,
            String(
                decoding: output.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            ),
            String(
                decoding: errors.fileHandleForReading.readDataToEndOfFile(),
                as: UTF8.self
            )
        )
    }

    @Test
    func helpDiscoversAllTokenLifecycleModes() throws {
        let result = try run(["--help"])
        #expect(
            result.status == 0,
            Comment(rawValue: result.stdout + result.stderr)
        )
        #expect(result.stdout.contains(" install "))
        #expect(result.stdout.contains(" remove "))
        #expect(result.stdout.contains(" status "))
        #expect(result.stdout.contains(" descriptor-exec "))
    }

    @Test
    func ambientTokenIsRejectedBeforePipedInputIsReadOrEchoed() throws {
        let sentinel = "SUPERVISOR_INPUT_SENTINEL_73d1"
        let result = try run(
            [
                "install",
                "--config-root", "/private/tmp/browser-use-invalid",
                "--op-path", "/usr/local/bin/op",
                "--input", "stdin",
                "--replace", "false",
            ],
            environment: [
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "OP_SERVICE_ACCOUNT_TOKEN": sentinel,
            ],
            stdin: Data(sentinel.utf8)
        )
        #expect(result.status == 20)
        #expect(result.stdout.contains("ambient-op-environment"))
        #expect(!result.stdout.contains(sentinel))
        #expect(!result.stderr.contains(sentinel))
    }

    @Test
    func statusInvalidArgumentsRemainTypedAndSecretFree() throws {
        let result = try run(["status"])
        #expect(result.status == 20)
        #expect(result.stdout.contains("invalid-arguments"))
        #expect(result.stderr.isEmpty)
    }

    @Test
    // Defense-in-depth drift observation only. Darwin does not provide an
    // exact-open-vnode exec primitive, so this does not claim protection from
    // a malicious or noncooperating same-UID process.
    func descriptorExecutionKeepsItsReviewedCooperativePrivateCopy() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("browser-use-descriptor-exec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("fixture")
        let reviewed = root.appendingPathComponent("fixture.reviewed")
        let marker = root.appendingPathComponent("marker")
        let reviewedBytes = Data("#!/bin/sh\nprintf reviewed > '\(marker.path)'\n".utf8)
        try reviewedBytes.write(to: executable, options: .withoutOverwriting)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )
        let descriptor = Darwin.open(executable.path, O_RDONLY | O_NOFOLLOW)
        try #require(descriptor >= 0)
        defer { _ = Darwin.close(descriptor) }
        var metadata = stat()
        try #require(fstat(descriptor, &metadata) == 0)
        let digest = SHA256.hash(data: reviewedBytes)
            .map { String(format: "%02x", $0) }
            .joined()
        try FileManager.default.moveItem(at: executable, to: reviewed)
        try Data("#!/bin/sh\nprintf replacement > '\(marker.path)'\n".utf8)
            .write(to: executable, options: .withoutOverwriting)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        let result = DescriptorExecution.run(
            executableDescriptor: descriptor,
            expected: AdmittedExecutableIdentity(
                device: UInt64(metadata.st_dev),
                inode: UInt64(metadata.st_ino),
                size: Int64(metadata.st_size),
                sha256: digest
            ),
            arguments: [executable.path]
        )
        #expect(result == .completed(0))
        #expect(try String(contentsOf: marker, encoding: .utf8) == "reviewed")
    }
}
