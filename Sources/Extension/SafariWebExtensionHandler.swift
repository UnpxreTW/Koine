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
/// **PoC 1**：驗證翻譯能否在這個 `NSExtension` 子進程（無 SwiftUI scene / lifecycle）內
/// end-to-end 跑通。API 形式與 `translationd` 可達性已由 `koine` CLI 在 bare process
/// 實證（2026-06-10）；本 PoC 只剩「NSExtension 沙箱環境」這一個變因——通過則 v1
/// 引擎策略成立，失敗則退回 main app bridge 或重評雲端 fallback。
///
/// 翻譯本體委派核心庫 `AppleTranslationEngine`，與 CLI 共用同一條路徑。
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
				logger.log("PoC 1 OK: \(translated, privacy: .public)")
				respond(context, with: ["translated": translated])
			} catch {
				logger.error("PoC 1 FAIL: \(error.localizedDescription, privacy: .public)")
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
