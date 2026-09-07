//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import Koine
import Testing

// MARK: - FailingEngine

/// 一律以指定錯誤失敗的 mock 引擎：`status` 回 `.installed` 讓預查放行，
/// `translate` 拋出注入的那一個錯誤，供本檔只看「錯誤怎麼穿過 bridge」這一段。
private struct FailingEngine: TranslationEngine {

	/// `translate` 每次拋出的錯誤（注入真實的 production 錯誤型別、不是測試專用樁）。
	fileprivate let error: any Error

	/// 一律回 `.installed`：預查對本值回 `nil`、不早退，讓請求走到 `translate`。
	fileprivate func status(from source: Locale.Language, to target: Locale.Language) async -> LanguagePairStatus {
		.installed
	}

	/// 一律拋出注入的錯誤。
	fileprivate func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		throw error
	}
}

// MARK: - BridgeTranslatorErrorPassthroughTests

/// 兩個真實翻譯錯誤穿過 `BridgeTranslator` 到 JS 端 `error` 欄的傳遞路徑特徵化。
///
/// `BridgeTranslatorTests` 的失敗路徑只餵了測試專用的 `MockError`，斷言的是「有錯就回
/// `.failed`」；至於 production 真正會丟出來的 `TranslationTimeoutError` 與
/// `TranslationCircuitOpenError`，它們的訊息本體能不能帶著參數（等待上限／剩餘時間）一路
/// 穿到線上 dict 的 `error` 欄，沒有任何測試看守。把 `respond(to:)` 的 catch 改成回一句
/// 泛用文案、或把訊息取值換成型別描述，整套測試照樣全綠，JS 端收到的卻已不是使用者讀得懂
/// 的那句話。
///
/// 與訊息本身的 golden 分工：那份釘的是「這兩句話長什麼樣」，本檔釘的是「這兩句話有沒有
/// 送到」——訊息文案日後改寫時，本檔的斷言取值自同一個錯誤實例、不會跟著紅。
///
/// 斷言一路做到 `payload`：`.failed` 對不對只是型別層的事實，真正跨到 JS 端的是那份
/// `[String: Any]`，鍵名（`id`／`error`）即 §9.4 契約本身。
private final class BridgeTranslatorErrorPassthroughTests {

	/// 逾時錯誤：`.failed` 的訊息＝該錯誤自己的 `localizedDescription`，且原樣落在線上 `error` 欄。
	@Test
	private func `timeout error reaches the wire error field`() async {
		let error: TranslationTimeoutError = .init(limit: .seconds(30))
		let translator: BridgeTranslator = .init(engine: FailingEngine(error: error))
		let out: BridgeResponse = await translator.handle(["id": "k1-0", "source": "Hello", "from": "en", "to": "zh-Hant"])
		#expect(out == .failed(identifier: "k1-0", message: error.localizedDescription))
		let payload: [String: Any] = out.payload
		#expect(payload["error"] as? String == error.localizedDescription)
		#expect(payload["id"] as? String == "k1-0")
		#expect(payload["text"] == nil, "失敗回應不該同時帶譯文欄——JS 端讀 error 判失敗")
	}

	/// 短路錯誤：同一條路徑、同樣帶著自己的訊息落在線上 `error` 欄。
	@Test
	private func `circuit open error reaches the wire error field`() async {
		let error: TranslationCircuitOpenError = .init(retryAfter: .seconds(60))
		let translator: BridgeTranslator = .init(engine: FailingEngine(error: error))
		let out: BridgeResponse = await translator.handle(["id": "k1-0", "source": "Hello", "from": "en", "to": "zh-Hant"])
		#expect(out == .failed(identifier: "k1-0", message: error.localizedDescription))
		let payload: [String: Any] = out.payload
		#expect(payload["error"] as? String == error.localizedDescription)
		#expect(payload["id"] as? String == "k1-0")
		#expect(payload["text"] == nil, "失敗回應不該同時帶譯文欄——JS 端讀 error 判失敗")
	}

	/// 兩種錯誤在邊界上仍是兩句不同的話。
	///
	/// 上面兩條各自比對同一個錯誤實例，catch 若被改成「一律回同一句泛用文案」而那句話恰好
	/// 取自某個錯誤，單看各自那條未必紅；這條把兩者擺在一起，堵掉「兩種處境壓成一句」——
	/// 使用者看到「請再試一次」與「暫時停用」該做的事並不相同。
	@Test
	private func `the two errors stay distinguishable at the boundary`() async {
		let timeout: BridgeTranslator = .init(
			engine: FailingEngine(error: TranslationTimeoutError(limit: .seconds(30)))
		)
		let circuitOpen: BridgeTranslator = .init(
			engine: FailingEngine(error: TranslationCircuitOpenError(retryAfter: .seconds(60)))
		)
		let message: [String: Any] = ["id": "k1-0", "source": "Hello", "from": "en", "to": "zh-Hant"]
		let timeoutOut: BridgeResponse = await timeout.handle(message)
		let circuitOpenOut: BridgeResponse = await circuitOpen.handle(message)
		#expect(timeoutOut != circuitOpenOut, "兩種處境對使用者的下一步不同，訊息不該被壓成同一句")
	}

	/// 引擎失敗時 `id` 照樣附回：JS 端靠它把失敗對回那一段，掉了就變成整筆訊息不合法。
	@Test
	private func `identifier survives an engine failure`() async {
		let error: TranslationTimeoutError = .init(limit: .milliseconds(500))
		let translator: BridgeTranslator = .init(engine: FailingEngine(error: error))
		let out: BridgeResponse = await translator.handle(["id": "k7-42", "source": "Hello", "from": "en", "to": "zh-Hant"])
		#expect(out == .failed(identifier: "k7-42", message: error.localizedDescription))
	}
}
