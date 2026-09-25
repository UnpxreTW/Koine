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

	/// 逐段判定來源語的偵測器（測試注入 mock）。
	private let detector: any LanguageDetecting

	/// 注入翻譯引擎與語言偵測器。
	public init(engine: any TranslationEngine, detector: any LanguageDetecting = LanguageRecognizerDetector()) {
		self.engine = engine
		self.detector = detector
	}

	/// 譯一筆已解析的請求。
	///
	/// 來源語**以內容偵測為主、請求帶來的標籤為回退**：`request.sourceLanguage` 是瀏覽器端
	/// 由最近帶 `lang` 的祖先（再無則頁面語言）推出來的標記值，而標記與實際內容分歧是常態
	/// ——繁體頁面內嵌一塊簡體、或整塊內容根本沒標 `lang`，都只有看內容才判得出來。
	public func respond(to request: BridgeRequest) async -> BridgeResponse {
		let detected: String? = detector.detect(request.source)
		let resolvedSourceTag: String = detected ?? request.sourceLanguage
		// 來源語已滿足目標語＝這段不必翻。回空譯文走既有的「譯文＝原文、不顯示」終態
		// （見 `BridgeResponse.translated`），不呼叫引擎、也不佔語言包配額。
		//
		// 只有「標籤自稱已達目標語」這一種情形要多問一句內容像不像：那是唯一會讓段落**完全不譯**
		// 的路，而偵測判不出來時標籤常是繼承來的——繁體頁面上的 `Home`／`Menu` 就會因此被判成
		// 已達標、靜默不譯，且是正常終態、不留任何失敗紀錄。
		//
		// 標籤沒有自稱已達標時（`zh-Hant → ja` 之類）一律採信：那是呼叫端明確要的語言對，
		// 內容像不像不是我們該否決的事。
		let tagClaimsAlreadyTarget: Bool = LanguageTag.satisfies(
			source: resolvedSourceTag,
			target: request.targetLanguage
		)
		let trustsTag: Bool = detected != nil
			|| !tagClaimsAlreadyTarget
			|| LanguageTag.content(request.source, looksLike: resolvedSourceTag)
		if tagClaimsAlreadyTarget, trustsTag {
			return .translated(identifier: request.identifier, text: "")
		}
		// 守門沒過＝已經證明那個標籤對這段文字是錯的，故它也不能當引擎的來源語——否則繁體標記
		// 配英文內容會送出 `zh-Hant → zh-Hant` 這種自我翻譯，回來的不論是「不支援」還是原文，
		// 使用者拿到的都是壞結果。改用線上契約的預設來源語：那正是標記缺席時本來就會用的猜測。
		let engineSourceTag: String = trustsTag ? resolvedSourceTag : BridgeRequest.defaultSourceLanguage
		let sourceLanguage: Locale.Language = .init(identifier: engineSourceTag)
		let targetLanguage: Locale.Language = .init(identifier: request.targetLanguage)
		// 預查：把最常見的首跑失敗（語言包未下載 / 不支援）轉成可行動訊息，
		// 不讓 translationd 的不可讀 framework error 直接外洩到 JS 端（與 CLI 同路徑）。
		//
		// 訊息印的是**實際採用的**來源語標籤：不支援的是真正送出去的那個組合，印回原始標記
		// 會讓使用者照著一個沒被嘗試過的組合去找語言包。
		if let hint = (await engine.status(from: sourceLanguage, to: targetLanguage))
			.actionableMessage(from: engineSourceTag, to: request.targetLanguage) {
			return .failed(identifier: request.identifier, message: hint)
		}
		do {
			let text: String = try await engine.translate(request.source, from: sourceLanguage, to: targetLanguage)
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
