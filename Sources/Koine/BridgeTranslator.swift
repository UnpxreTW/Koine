//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// bridge 譯文核心：把一筆 `{ id, source, from?, to? }` 請求委派 `TranslationEngine`
/// 譯成 `{ id, text }`，缺欄位或引擎失敗回 `{ id, error }`。
///
/// 抽出 handler 的訊息拆解 + 引擎呼叫，讓其可注入 mock engine 單測（不碰真 `translationd`）；
/// 與 §9.4 Bridge JSON（`{id,source}` → `{id,text}`）對齊，`id` 供 JS 端一一對回。
public struct BridgeTranslator {

	/// 委派的翻譯引擎（v1 = `AppleTranslationEngine`；測試注入 mock）。
	private let engine: any TranslationEngine

	/// 注入翻譯引擎。
	public init(engine: any TranslationEngine) {
		self.engine = engine
	}

	/// 拆一筆 bridge 請求 dict → 回應 payload dict。
	/// 缺 `id` / `source` 回 error；`from` 預設 `en`、`to` 預設 `zh-Hant`。
	public func handle(_ message: [String: Any]) async -> [String: Any] {
		guard let identifier = message["id"] as? String else {
			return ["error": "missing id"]
		}
		guard let source = message["source"] as? String else {
			return ["id": identifier, "error": "missing source"]
		}
		let from = (message["from"] as? String) ?? "en"
		let to = (message["to"] as? String) ?? "zh-Hant"
		let sourceLanguage = Locale.Language(identifier: from)
		let targetLanguage = Locale.Language(identifier: to)
		// 預查：把最常見的首跑失敗（語言包未下載 / 不支援）轉成可行動訊息，
		// 不讓 translationd 的不可讀 framework error 直接外洩到 JS 端（與 CLI 同路徑）。
		if let hint = (await engine.status(from: sourceLanguage, to: targetLanguage))
			.actionableMessage(from: from, to: to) {
			return ["id": identifier, "error": hint]
		}
		do {
			let text = try await engine.translate(source, from: sourceLanguage, to: targetLanguage)
			return ["id": identifier, "text": text]
		} catch {
			return ["id": identifier, "error": error.localizedDescription]
		}
	}
}
