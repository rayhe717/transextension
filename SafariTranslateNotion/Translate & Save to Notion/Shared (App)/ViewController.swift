//
//  ViewController.swift
//  Shared (App)
//
//  Created by Ray on 2/25/26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
import Security
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.yourCompany.Translate---Save-to-Notion.Extension"
let optionsKeychainService = "com.yourCompany.Translate-Save-to-Notion.options"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        guard let command = message.body as? String else { return }

        if command == "open-preferences" {
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
                guard error == nil else { return }
                DispatchQueue.main.async { NSApp.terminate(self) }
            }
            return
        }

        if command == "pick-vault" {
            pickVaultFolder()
            return
        }
#endif
    }

#if os(macOS)
    private func pickVaultFolder() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Vault"
        panel.message = "Choose your Obsidian vault folder."
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let bookmark = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
                let b64 = bookmark.base64EncodedString()
                self?.keychainWrite(service: optionsKeychainService, account: "vaultBookmark", value: b64)
                self?.keychainWrite(service: optionsKeychainService, account: "obsidianVaultPath", value: url.path)
                self?.webView.evaluateJavaScript("document.querySelector('.vault-path').innerText = " + self!.jsString(url.path) + ";")
            } catch {
                self?.webView.evaluateJavaScript("document.querySelector('.vault-path').innerText = " + self!.jsString("Failed to save vault permission.") + ";")
            }
        }
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

    private func jsString(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"" + escaped + "\""
    }
#endif
}
