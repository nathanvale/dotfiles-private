import CryptoKit
import Darwin
import Foundation

public struct AdmittedExecutableIdentity: Sendable {
    public let device: UInt64
    public let inode: UInt64
    public let size: Int64
    public let sha256: String

    public init(device: UInt64, inode: UInt64, size: Int64, sha256: String) {
        self.device = device
        self.inode = inode
        self.size = size
        self.sha256 = sha256
    }
}

public enum DescriptorExecutionResult: Sendable, Equatable {
    case completed(Int32)
    case blocked(String)
}

/// Cooperative local execution drift detector.
///
/// The inherited descriptor proves the reviewed bytes before they are copied
/// to a private pathname for `posix_spawn`. Darwin does not provide `fexecve`,
/// `execveat`, or an exact-open-vnode spawn option, so this helper deliberately
/// makes no claim against a malicious or noncooperating same-UID process.
@_spi(Executor)
public enum DescriptorExecution {
    private static func digest(descriptor: Int32, size: Int) -> String? {
        var hasher = SHA256()
        var offset = 0
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while offset < size {
            let wanted = min(buffer.count, size - offset)
            let count = buffer.withUnsafeMutableBytes {
                pread(descriptor, $0.baseAddress, wanted, off_t(offset))
            }
            guard count > 0 else { return nil }
            hasher.update(data: Data(buffer.prefix(count)))
            offset += count
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func safeArguments(_ arguments: [String]) -> Bool {
        !arguments.isEmpty
            && arguments.count <= 512
            && arguments.reduce(0, { $0 + $1.utf8.count }) <= 131_072
            && arguments.allSatisfy {
                !$0.contains("\0") && $0.utf8.count <= 32_768
            }
    }

    private static func withCStringArray<Result>(
        _ strings: [String],
        _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result
    ) -> Result {
        let allocated = strings.map { strdup($0) }
        defer { allocated.forEach { free($0) } }
        var pointers = allocated + [nil]
        return pointers.withUnsafeMutableBufferPointer { buffer in
            body(buffer.baseAddress!)
        }
    }

    private static func privateExecutableCopy(
        descriptor: Int32,
        size: Int,
        expectedSHA256: String
    ) -> (root: String, path: String)? {
        let template = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("browser-use-descriptor-exec-XXXXXXXX")
        var templateBytes = Array(template.utf8CString)
        guard mkdtemp(&templateBytes) != nil else { return nil }
        let root = templateBytes.withUnsafeBufferPointer {
            String(cString: $0.baseAddress!)
        }
        let path = (root as NSString).appendingPathComponent("admitted-executable")
        let output = Darwin.open(
            path,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
            mode_t(0o600)
        )
        guard output >= 0 else {
            try? FileManager.default.removeItem(atPath: root)
            return nil
        }
        var offset = 0
        var buffer = [UInt8](repeating: 0, count: 16_384)
        var copied = true
        while offset < size, copied {
            let wanted = min(buffer.count, size - offset)
            let count = buffer.withUnsafeMutableBytes {
                pread(descriptor, $0.baseAddress, wanted, off_t(offset))
            }
            guard count > 0 else {
                copied = false
                break
            }
            var written = 0
            while written < count {
                let result = buffer.withUnsafeBytes {
                    Darwin.write(
                        output,
                        $0.baseAddress!.advanced(by: written),
                        count - written
                    )
                }
                guard result > 0 else {
                    copied = false
                    break
                }
                written += result
            }
            offset += count
        }
        let sealed = copied
            && fsync(output) == 0
            && fchmod(output, mode_t(0o500)) == 0
        _ = Darwin.close(output)
        let verification = Darwin.open(path, O_RDONLY | O_NOFOLLOW)
        let reviewedCopy = verification >= 0
            && digest(descriptor: verification, size: size) == expectedSHA256
        if verification >= 0 { _ = Darwin.close(verification) }
        guard sealed, reviewedCopy, chmod(root, mode_t(0o500)) == 0 else {
            _ = chmod(root, mode_t(0o700))
            try? FileManager.default.removeItem(atPath: root)
            return nil
        }
        return (root, path)
    }

    public static func run(
        executableDescriptor: Int32,
        expected: AdmittedExecutableIdentity,
        arguments: [String]
    ) -> DescriptorExecutionResult {
        guard executableDescriptor >= 3,
              expected.size > 0,
              expected.size <= 512 * 1_024 * 1_024,
              expected.sha256.count == 64,
              expected.sha256.allSatisfy({ $0.isHexDigit }),
              safeArguments(arguments)
        else {
            return .blocked("descriptor-exec-input-invalid")
        }
        var metadata = stat()
        guard fstat(executableDescriptor, &metadata) == 0,
              metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              UInt64(metadata.st_dev) == expected.device,
              UInt64(metadata.st_ino) == expected.inode,
              Int64(metadata.st_size) == expected.size,
              digest(descriptor: executableDescriptor, size: Int(expected.size))
                == expected.sha256.lowercased()
        else {
            return .blocked("descriptor-exec-identity-mismatch")
        }

        guard let privateCopy = privateExecutableCopy(
            descriptor: executableDescriptor,
            size: Int(expected.size),
            expectedSHA256: expected.sha256.lowercased()
        ) else {
            return .blocked("descriptor-exec-spawn-failed")
        }
        defer {
            _ = chmod(privateCopy.root, mode_t(0o700))
            try? FileManager.default.removeItem(atPath: privateCopy.root)
        }
        var child: pid_t = 0
        let spawnResult = privateCopy.path.withCString { executablePath in
            withCStringArray(arguments) { argv in
                posix_spawn(&child, executablePath, nil, nil, argv, environ)
            }
        }
        guard spawnResult == 0 else {
            return .blocked("descriptor-exec-spawn-failed")
        }
        var status: Int32 = 0
        while waitpid(child, &status, 0) < 0 {
            if errno != EINTR {
                return .blocked("descriptor-exec-wait-failed")
            }
        }
        if status & 0x7f == 0 {
            return .completed((status >> 8) & 0xff)
        }
        return .completed(128 + (status & 0x7f))
    }
}
