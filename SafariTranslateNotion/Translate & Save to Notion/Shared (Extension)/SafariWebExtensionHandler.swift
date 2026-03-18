import SafariServices
import Security
import os.log
#if os(macOS)
import AppKit
#endif

private let kOptionsKeychainService = "com.yourCompany.Translate-Save-to-Notion.options"
private let kOptionsKeys = ["deepseekApiKey", "notionToken", "notionDatabaseId", "obsidianVaultPath", "vaultBookmark"]

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
            pickVaultFolder(context: context)
            return
        }
        if type == "vaultWrite" {
            handleVaultWrite(msg, context: context)
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
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Choose Vault"
            panel.message = "Choose your Obsidian vault folder."
            let response = panel.runModal()
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
#else
        respond(with: ["error": "Vault picker is only supported on macOS."], context: context)
#endif
    }

    private func handleVaultWrite(_ msg: [String: Any], context: NSExtensionContext) {
#if os(macOS)
        let folderRel = (msg["folder"] as? String ?? "vocab").trimmingCharacters(in: .whitespacesAndNewlines)
        let filename = (msg["filename"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let content = msg["content"] as? String ?? ""
        guard !filename.isEmpty else {
            respond(with: ["error": "Missing filename"], context: context)
            return
        }
        guard let bookmarkB64 = keychainRead(service: kOptionsKeychainService, account: "vaultBookmark"),
              let bookmarkData = Data(base64Encoded: bookmarkB64) else {
            respond(with: ["error": "Vault folder not set. Open extension Options and choose your vault."], context: context)
            return
        }
        var stale = false
        do {
            let vaultURL = try URL(resolvingBookmarkData: bookmarkData, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
            guard vaultURL.startAccessingSecurityScopedResource() else {
                respond(with: ["error": "No permission to access the vault folder. Choose it again in Options."], context: context)
                return
            }
            defer { vaultURL.stopAccessingSecurityScopedResource() }

            let safeFolder = folderRel.replacingOccurrences(of: "..", with: "").replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let targetDir = safeFolder.isEmpty ? vaultURL : vaultURL.appendingPathComponent(safeFolder, isDirectory: true)
            try FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)
            let fileURL = targetDir.appendingPathComponent(filename, isDirectory: false)
            try content.write(to: fileURL, atomically: true, encoding: .utf8)
            respond(with: ["ok": true, "path": fileURL.path], context: context)
        } catch {
            respond(with: ["error": "Vault write failed: \(error.localizedDescription)"], context: context)
        }
#else
        respond(with: ["error": "Vault write is only supported on macOS."], context: context)
#endif
    }

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
