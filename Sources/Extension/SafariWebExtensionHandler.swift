//
//  KoineExtension
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import SafariServices
import os.log

private let logger: Logger = .init(subsystem: "\(#bundle)", category: "extension")

/// Safari Web Extension 的 native handler。
///
/// 翻譯本體委派核心庫 `AppleTranslationEngine`，與 CLI 共用同一條路徑；
/// 在 NSExtension 子進程（無 SwiftUI scene / lifecycle）內直連 `translationd`。
class SafariWebExtensionHandler: NSObject {}

extension SafariWebExtensionHandler: NSExtensionRequestHandling {

	func beginRequest(with context: NSExtensionContext) {
		let item = context.inputItems.first as? NSExtensionItem
		let message = (item?.userInfo?[SFExtensionMessageKey] as? [String: Any]) ?? [:]
		Task {
			// 訊息拆解 + 引擎呼叫委派核心 BridgeTranslator（§9.4：{id,source} → {id,text}）；
			// handler 只負責 NSExtension I/O 橋接，譯文邏輯與 CLI 共用同一路徑。
			let translator = BridgeTranslator(engine: AppleTranslationEngine())
			let payload = await translator.handle(message)
			if let error = payload["error"] as? String {
				logger.error("翻譯失敗: \(error, privacy: .public)")
			} else if let text = payload["text"] as? String {
				logger.log("翻譯完成: \(text, privacy: .public)")
			}
			respond(context, with: payload)
		}
	}

	private func respond(_ context: NSExtensionContext, with payload: [String: Any]) {
		let response = NSExtensionItem()
		response.userInfo = [SFExtensionMessageKey: payload]
		context.completeRequest(returningItems: [response], completionHandler: nil)
	}
}
