import SafariServices
import os.log

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

        respond(with: ["echo": msg], context: context)
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
        request.timeoutInterval = 30

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
