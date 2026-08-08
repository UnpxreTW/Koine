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

// subsystem 必須是固定字串：`"\(#bundle)"` 插值出 `NSBundle </path…> (loaded)`，
// 任何 `log stream` predicate 都對不上、appex log 因此完全不可觀測。
private let logger: Logger = .init(subsystem: "me.unpxre.koine.Extension", category: "extension")

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
			let response = await translator.handle(message)
			// 窮舉 switch 而非回頭翻 payload 的鍵：新增一種回應形狀時這裡會編不過，
			// 不會靜默地既不記成功也不記失敗。
			switch response {
			case .translated(_, let text):
				logger.log("翻譯完成: \(text, privacy: .public)")
			case .failed(_, let reason), .unidentified(let reason):
				logger.error("翻譯失敗: \(reason, privacy: .public)")
			}
			respond(context, with: response.payload)
		}
	}

	private func respond(_ context: NSExtensionContext, with payload: [String: Any]) {
		let response = NSExtensionItem()
		response.userInfo = [SFExtensionMessageKey: payload]
		context.completeRequest(returningItems: [response], completionHandler: nil)
	}
}
