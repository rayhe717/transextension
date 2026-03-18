import SafariServices
import Security
import os.log
#if os(macOS)
import AppKit
#endif

private let kOptionsKeychainService = "com.yourCompany.Translate-Save-to-Notion.options"
private let kOptionsKeys = ["deepseekApiKey", "notionToken", "notionDatabaseId", "obsidianVaultPath", "vaultBookmark"]
private let kVaultAppGroupId = "group.com.yourCompany.TranslateSaveToNotion"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem

        let message: [String: Any]?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        } else {
            message = item?.userInfo?["message"] as? [String: Any]
        }

        guard let msg = message, let type = msg["type"] as? String else {
            respond(with: ["error": "Invalid message"], context: context)
            return
        }

        if type == "apiRequest" {
            handleApiRequest(msg, context: context)
            return
        }
        if type == "getPersistedOptions" {
            respond(with: loadOptionsFromKeychain(), context: context)
            return
        }
        if type == "persistOptions" {
            let opts = msg["options"] as? [String: Any] ?? [:]
            saveOptionsToKeychain(opts)
            respond(with: ["ok": true], context: context)
            return
        }
        if type == "pickVaultFolder" {
            openHostApp()
            respond(with: ["error": "Vault picker opened in the app. Choose your vault folder there, then return to Options."], context: context)
            return
        }
        if type == "vaultWrite" {
            handleVaultWrite(msg, context: context)
            return
        }
        if type == "vaultExists" {
            handleVaultExists(msg, context: context)
            return
        }
        if type == "vaultFindSynonymIn" {
            handleVaultFindSynonymIn(msg, context: context)
            return
        }

        respond(with: ["echo": msg], context: context)
    }

    private func loadOptionsFromKeychain() -> [String: Any] {
        var result: [String: Any] = [:]
        for key in kOptionsKeys {
            if let value = keychainRead(service: kOptionsKeychainService, account: key) {
                result[key] = value
            }
        }
        // Prefer App Group values for vault path (shared with container app).
        if let defaults = UserDefaults(suiteName: kVaultAppGroupId),
           let p = defaults.string(forKey: "obsidianVaultPath"),
           !p.isEmpty {
            result["obsidianVaultPath"] = p
        }
        return result
    }

    private func saveOptionsToKeychain(_ options: [String: Any]) {
        for key in kOptionsKeys {
            guard let value = options[key] as? String else { continue }
            keychainWrite(service: kOptionsKeychainService, account: key, value: value)
        }
    }

    private func keychainRead(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }

    private func keychainWrite(service: String, account: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func handleApiRequest(_ msg: [String: Any], context: NSExtensionContext) {
        guard let urlString = msg["url"] as? String,
              let url = URL(string: urlString),
              let method = msg["method"] as? String else {
            respond(with: ["error": "Missing url or method"], context: context)
            return
        }

        let headers = msg["headers"] as? [String: String] ?? [:]
        let bodyString = msg["body"] as? String

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45

        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        if let body = bodyString {
            request.httpBody = body.data(using: .utf8)
        }

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                self?.respond(with: ["error": "Network: \(error.localizedDescription)"], context: context)
                return
            }
            guard let httpResponse = response as? HTTPURLResponse else {
                self?.respond(with: ["error": "No HTTP response"], context: context)
                return
            }
            let responseBody = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            self?.respond(with: [
                "status": httpResponse.statusCode,
                "body": responseBody
            ], context: context)
        }
        task.resume()
    }

    private func pickVaultFolder(context: NSExtensionContext) {
#if os(macOS)
        DispatchQueue.main.async { [weak self] in
            NSApplication.shared.activate(ignoringOtherApps: true)
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Choose Vault"
            panel.message = "Choose your Obsidian vault folder."
            panel.begin { response in
                guard response == .OK, let url = panel.url else {
                    self?.respond(with: ["error": "No folder selected."], context: context)
                    return
                }
                do {
                    let bookmark = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
                    let b64 = bookmark.base64EncodedString()
                    self?.keychainWrite(service: kOptionsKeychainService, account: "vaultBookmark", value: b64)
                    self?.keychainWrite(service: kOptionsKeychainService, account: "obsidianVaultPath", value: url.path)
                    self?.respond(with: ["ok": true, "vaultPath": url.path], context: context)
                } catch {
                    self?.respond(with: ["error": "Failed to store vault permission: \(error.localizedDescription)"], context: context)
                }
            }
        }
#else
        respond(with: ["error": "Vault picker is only supported on macOS."], context: context)
#endif
    }

#if os(macOS)
    private func openHostApp() {
        NSWorkspace.shared.launchApplication(withBundleIdentifier: "com.yourCompany.Translate---Save-to-Notion",
                                             options: [.default],
                                             additionalEventParamDescriptor: nil,
                                             launchIdentifier: nil)
    }
#endif

    private func handleVaultWrite(_ msg: [String: Any], context: NSExtensionContext) {
#if os(macOS)
        let folderRel = (msg["folder"] as? String ?? "vocab").trimmingCharacters(in: .whitespacesAndNewlines)
        let rawFilename = (msg["filename"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let content = msg["content"] as? String ?? ""
        let filename = sanitizeFilename(rawFilename)
        guard !filename.isEmpty else {
            respond(with: ["error": "Missing filename"], context: context)
            return
        }
        // Read bookmark from App Group first (shared with container app).
        var bookmarkData: Data? = nil
        if let defaults = UserDefaults(suiteName: kVaultAppGroupId),
           let b64 = defaults.string(forKey: "vaultBookmark"),
           let data = Data(base64Encoded: b64) {
            bookmarkData = data
        } else if let b64 = keychainRead(service: kOptionsKeychainService, account: "vaultBookmark"),
                  let data = Data(base64Encoded: b64) {
            bookmarkData = data
        }
        guard let bookmarkDataUnwrapped = bookmarkData else {
            respond(with: ["error": "Vault folder not set. Open the container app and choose your vault folder."], context: context)
            return
        }
        var stale = false
        do {
            let vaultURL = try URL(resolvingBookmarkData: bookmarkDataUnwrapped, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
            if stale {
                respond(with: ["error": "Vault permission expired. Choose the vault folder again."], context: context)
                return
            }
            guard vaultURL.startAccessingSecurityScopedResource() else {
                respond(with: ["error": "No permission to access the vault folder. Choose it again in Options."], context: context)
                return
            }
            defer { vaultURL.stopAccessingSecurityScopedResource() }

            let safeFolder = folderRel.replacingOccurrences(of: "..", with: "").replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let targetDir = safeFolder.isEmpty ? vaultURL : vaultURL.appendingPathComponent(safeFolder, isDirectory: true)
            try FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)
            let fileURL = targetDir.appendingPathComponent(filename, isDirectory: false)
            let data = content.data(using: .utf8) ?? Data()
            try data.write(to: fileURL, options: [.atomic])
            respond(with: ["ok": true, "path": fileURL.path], context: context)
        } catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && ns.code == 259 {
                // The stored bookmark data is likely corrupt/unreadable; clear it so the user can re-pick.
                keychainDelete(service: kOptionsKeychainService, account: "vaultBookmark")
                keychainDelete(service: kOptionsKeychainService, account: "obsidianVaultPath")
                if let defaults = UserDefaults(suiteName: kVaultAppGroupId) {
                    defaults.removeObject(forKey: "vaultBookmark")
                    defaults.removeObject(forKey: "obsidianVaultPath")
                    defaults.synchronize()
                }
                respond(with: ["error": "Vault permission data is invalid (corrupted bookmark). Please open the container app and choose your vault folder again."], context: context)
                return
            }
            respond(with: ["error": "Vault write failed: \(ns.localizedDescription) (domain=\(ns.domain) code=\(ns.code))"], context: context)
        }
#else
        respond(with: ["error": "Vault write is only supported on macOS."], context: context)
#endif
    }

    private func handleVaultExists(_ msg: [String: Any], context: NSExtensionContext) {
#if os(macOS)
        let folderRel = (msg["folder"] as? String ?? "vocab").trimmingCharacters(in: .whitespacesAndNewlines)
        let word = (msg["word"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let baseForm = (msg["baseForm"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let candidates = [word, baseForm].filter { !$0.isEmpty }
        if candidates.isEmpty {
            respond(with: ["found": false], context: context)
            return
        }
        var bookmarkData: Data? = nil
        if let defaults = UserDefaults(suiteName: kVaultAppGroupId),
           let b64 = defaults.string(forKey: "vaultBookmark"),
           let data = Data(base64Encoded: b64) {
            bookmarkData = data
        } else if let b64 = keychainRead(service: kOptionsKeychainService, account: "vaultBookmark"),
                  let data = Data(base64Encoded: b64) {
            bookmarkData = data
        }
        guard let bookmarkData = bookmarkData else {
            respond(with: ["found": false], context: context)
            return
        }
        var stale = false
        do {
            let vaultURL = try URL(resolvingBookmarkData: bookmarkData, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
            if stale { respond(with: ["found": false], context: context); return }
            guard vaultURL.startAccessingSecurityScopedResource() else {
                respond(with: ["found": false], context: context)
                return
            }
            defer { vaultURL.stopAccessingSecurityScopedResource() }
            let safeFolder = folderRel.replacingOccurrences(of: "..", with: "").replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let targetDir = safeFolder.isEmpty ? vaultURL : vaultURL.appendingPathComponent(safeFolder, isDirectory: true)
            for c in candidates {
                let fn = sanitizeFilename(c) + ".md"
                if fn == ".md" { continue }
                let fileURL = targetDir.appendingPathComponent(fn, isDirectory: false)
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    respond(with: ["found": true, "value": c], context: context)
                    return
                }
            }
            respond(with: ["found": false], context: context)
        } catch {
            respond(with: ["found": false], context: context)
        }
#else
        respond(with: ["found": false], context: context)
#endif
    }

    private func handleVaultFindSynonymIn(_ msg: [String: Any], context: NSExtensionContext) {
#if os(macOS)
        let folderRel = (msg["folder"] as? String ?? "vocab").trimmingCharacters(in: .whitespacesAndNewlines)
        let term = (msg["term"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = min(max((msg["limit"] as? Int) ?? 200, 1), 800)
        if term.isEmpty {
            respond(with: ["alsoSynonymIn": []], context: context)
            return
        }
        var bookmarkData: Data? = nil
        if let defaults = UserDefaults(suiteName: kVaultAppGroupId),
           let b64 = defaults.string(forKey: "vaultBookmark"),
           let data = Data(base64Encoded: b64) {
            bookmarkData = data
        } else if let b64 = keychainRead(service: kOptionsKeychainService, account: "vaultBookmark"),
                  let data = Data(base64Encoded: b64) {
            bookmarkData = data
        }
        guard let bookmarkData = bookmarkData else {
            respond(with: ["alsoSynonymIn": []], context: context)
            return
        }
        var stale = false
        do {
            let vaultURL = try URL(resolvingBookmarkData: bookmarkData, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
            if stale { respond(with: ["alsoSynonymIn": []], context: context); return }
            guard vaultURL.startAccessingSecurityScopedResource() else {
                respond(with: ["alsoSynonymIn": []], context: context)
                return
            }
            defer { vaultURL.stopAccessingSecurityScopedResource() }
            let safeFolder = folderRel.replacingOccurrences(of: "..", with: "").replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let targetDir = safeFolder.isEmpty ? vaultURL : vaultURL.appendingPathComponent(safeFolder, isDirectory: true)
            let needle = "[[\(term)]]"
            var hits: [String] = []
            if let files = try? FileManager.default.contentsOfDirectory(at: targetDir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                for url in files {
                    if hits.count >= limit { break }
                    let name = url.lastPathComponent
                    if !name.lowercased().hasSuffix(".md") { continue }
                    if name.hasPrefix("_") { continue }
                    if let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
                       let text = String(data: data, encoding: .utf8),
                       text.contains(needle) {
                        hits.append(url.deletingPathExtension().lastPathComponent)
                    }
                }
            }
            respond(with: ["alsoSynonymIn": hits], context: context)
        } catch {
            respond(with: ["alsoSynonymIn": []], context: context)
        }
#else
        respond(with: ["alsoSynonymIn": []], context: context)
#endif
    }

#if os(macOS)
    private func keychainDelete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func sanitizeFilename(_ name: String) -> String {
        var s = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }
        // Prevent path traversal / separators.
        s = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-")
        // Remove common illegal filename characters.
        let illegal = CharacterSet(charactersIn: ":*?\"<>|")
        s = s.components(separatedBy: illegal).joined()
        // Collapse whitespace.
        while s.contains("  ") { s = s.replacingOccurrences(of: "  ", with: " ") }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count > 180 { s = String(s.prefix(180)) }
        return s
    }
#endif

    private func respond(with data: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: data]
        } else {
            response.userInfo = ["message": data]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
