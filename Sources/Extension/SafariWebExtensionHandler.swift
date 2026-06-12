//
//  KoineExtension
//
//  SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
//  SPDX-License-Identifier: MPL-2.0

import Foundation
import SafariServices
import os.log

private let logger = Logger(subsystem: "me.unpxre.koine", category: "extension")

/// Safari Web Extension 的 native handler。
///
/// 翻譯本體委派核心庫 `AppleTranslationEngine`，與 CLI 共用同一條路徑；
/// 在 NSExtension 子進程（無 SwiftUI scene / lifecycle）內直連 `translationd`。
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

	func beginRequest(with context: NSExtensionContext) {
		let item = context.inputItems.first as? NSExtensionItem
		let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

		guard let text = message?["text"] as? String else {
			respond(context, with: ["error": "missing text"])
			return
		}
		let source = (message?["from"] as? String) ?? "en"
		let target = (message?["to"] as? String) ?? "zh-Hant"

		// beginRequest 是同步的、translate 是 async → 開 Task。
		Task {
			do {
				let engine = AppleTranslationEngine()
				let translated = try await engine.translate(
					text,
					from: Locale.Language(identifier: source),
					to: Locale.Language(identifier: target)
				)
				logger.log("翻譯完成: \(translated, privacy: .public)")
				respond(context, with: ["translated": translated])
			} catch {
				logger.error("翻譯失敗: \(error.localizedDescription, privacy: .public)")
				respond(context, with: ["error": error.localizedDescription])
			}
		}
	}

	private func respond(_ context: NSExtensionContext, with payload: [String: Any]) {
		let response = NSExtensionItem()
		response.userInfo = [SFExtensionMessageKey: payload]
		context.completeRequest(returningItems: [response], completionHandler: nil)
	}
}
