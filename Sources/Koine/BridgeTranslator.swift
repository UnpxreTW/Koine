//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// bridge 譯文核心：把一筆 `BridgeRequest` 委派 `TranslationEngine` 譯成 `BridgeResponse`。
///
/// 抽出 handler 的訊息拆解 + 引擎呼叫，讓其可注入 mock engine 單測（不碰真 `translationd`）；
/// 與 §9.4 Bridge JSON（`{id,source}` → `{id,text}`）對齊，`id` 供 JS 端一一對回。
///
/// untyped 的 `[String: Any]` 只剩兩個端點：入口在 `BridgeRequest.parse(_:)`、出口在
/// `BridgeResponse.payload`。`handle(_:)` 只是把入口接上核心，`respond(to:)` 之後全程 typed。
public struct BridgeTranslator {

	/// 委派的翻譯引擎（v1 = `AppleTranslationEngine`；測試注入 mock）。
	private let engine: any TranslationEngine

	/// 注入翻譯引擎。
	public init(engine: any TranslationEngine) {
		self.engine = engine
	}

	/// 譯一筆已解析的請求。
	public func respond(to request: BridgeRequest) async -> BridgeResponse {
		let sourceLanguage: Locale.Language = .init(identifier: request.sourceLanguage)
		let targetLanguage: Locale.Language = .init(identifier: request.targetLanguage)
		// 預查：把最常見的首跑失敗（語言包未下載 / 不支援）轉成可行動訊息，
		// 不讓 translationd 的不可讀 framework error 直接外洩到 JS 端（與 CLI 同路徑）。
		if let hint = (await engine.status(from: sourceLanguage, to: targetLanguage))
			.actionableMessage(from: request.sourceLanguage, to: request.targetLanguage) {
			return .failed(identifier: request.identifier, message: hint)
		}
		do {
			let text = try await engine.translate(request.source, from: sourceLanguage, to: targetLanguage)
			return .translated(identifier: request.identifier, text: text)
		} catch {
			return .failed(identifier: request.identifier, message: error.localizedDescription)
		}
	}

	/// 邊界形：解析 native message 邊界的 untyped 訊息，再委派 `respond(to:)`。
	///
	/// 解析失敗時 `BridgeRequest.parse(_:)` 已把該失敗表達成回應形狀，這裡原樣回出——
	/// 「缺哪個鍵該回哪種回應」只此一份定義，不在呼叫端各寫一次。
	public func handle(_ message: [String: Any]) async -> BridgeResponse {
		switch BridgeRequest.parse(message) {
		case .request(let request):
			return await respond(to: request)
		case .malformed(let response):
			return response
		}
	}
}
