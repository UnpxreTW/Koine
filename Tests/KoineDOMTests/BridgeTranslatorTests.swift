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

// MARK: - MockEngine

/// mock 翻譯引擎：`status` 回可設定狀態、`translate` 回固定譯文或依旗標拋錯，
/// 供 `BridgeTranslator` 單測不碰真 `translationd`。
private struct MockEngine: TranslationEngine {

	/// 預設成功可用：`shouldFail=false`、`statusResult=.installed`。
	init(shouldFail: Bool = false, statusResult: LanguagePairStatus = .installed) {
		self.shouldFail = shouldFail
		self.statusResult = statusResult
	}

	/// 為 true 時 `translate` 一律拋錯（測引擎失敗路徑）。
	let shouldFail: Bool

	/// `status` 回傳的狀態（測預查分支；預設 `.installed`）。
	let statusResult: LanguagePairStatus

	/// 回設定的 `statusResult`。
	func status(from source: Locale.Language, to target: Locale.Language) async -> LanguagePairStatus {
		statusResult
	}

	/// 回 `譯:<原文>`；`shouldFail` 為 true 則拋 `MockError.boom`。
	func translate(_ text: String, from source: Locale.Language, to target: Locale.Language) async throws -> String {
		if shouldFail { throw MockError.boom }
		return "譯:\(text)"
	}
}

// MARK: - MockError

/// mock 引擎的測試用錯誤。
private enum MockError: Error {

	/// 泛用失敗。
	case boom
}

// MARK: - BridgeTranslatorTests

/// 核心 bridge 邏輯跑道：`BridgeTranslator.handle` 的訊息拆解 + 引擎委派（注入 mock、不碰真 `translationd`）。
private final class BridgeTranslatorTests {

	/// 成功：`{id, source}` → `.translated`。
	@Test
	private func `success returns ID and text`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["id": "k1-0", "source": "Hello", "from": "en", "to": "zh-Hant"])
		#expect(out == .translated(identifier: "k1-0", text: "譯:Hello"))
	}

	/// 缺 id：回 `.unidentified`（無從對回、屬協定違規）。
	@Test
	private func `missing ID returns error`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["source": "Hello"])
		#expect(out == .unidentified(message: "missing id"))
	}

	/// 缺 source：回 `.failed`（保留 id 供 JS 端對回該段的失敗）。
	@Test
	private func `missing source returns ID and error`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["id": "k1-0"])
		#expect(out == .failed(identifier: "k1-0", message: "missing source"))
	}

	/// 引擎拋錯：回 `.failed`、帶引擎的錯誤描述。
	@Test
	private func `engine failure returns ID and error`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(shouldFail: true))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out == .failed(identifier: "k1-0", message: MockError.boom.localizedDescription))
	}

	/// 預查 supported（語言包未下載）：回 `.failed` 含可行動提示、不進 translate。
	@Test
	private func `status supported returns actionable error`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(statusResult: .supported))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		guard case .failed(let identifier, let message) = out else {
			Issue.record("預查擋下時應回 .failed，實得 \(out)")
			return
		}
		#expect(identifier == "k1-0")
		#expect(message.contains("語言包未下載"), "應給可行動的語言包提示")
	}

	/// 預查 unsupported：回 `.failed` 含不支援提示、不進 translate。
	@Test
	private func `status unsupported returns actionable error`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(statusResult: .unsupported))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		guard case .failed(let identifier, let message) = out else {
			Issue.record("預查擋下時應回 .failed，實得 \(out)")
			return
		}
		#expect(identifier == "k1-0")
		#expect(message.contains("不支援"), "應給不支援組合提示")
	}

	/// 預查 undetermined（可用性查詢逾時／被取消）：**不早退**，照常進 translate 回 `.translated`。
	/// 這條釘住「預查查不出來時讓開」——失去它，可用性端點慢而翻譯本身正常的頁面會整頁譯不出來。
	/// 兩種回歸的偵測分工：早退條件被改成「非 installed 就擋」→ 只有本條會紅（`actionableMessage`
	/// 那層看不到呼叫端）；`.undetermined` 又生出可行動訊息 → 本條與 `undetermined yields no
	/// message so it cannot block translation` 一起紅。
	@Test
	private func `status undetermined falls through to translate`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(statusResult: .undetermined))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out == .translated(identifier: "k1-0", text: "譯:Hello"), "查不出來不是失敗、不該擋下翻譯")
	}

	/// 不帶 from/to：走預設 en → zh-Hant、installed → `.translated`。
	@Test
	private func `default from to succeeds`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine())
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out == .translated(identifier: "k1-0", text: "譯:Hello"))
	}

	/// 直接餵 typed 請求（跳過邊界解析）：與同內容的 dict 走 `handle` 得到同一個回應。
	/// 這條釘住「`handle` 只是解析 + 委派」，別讓兩條入口日後各自長出行為。
	///
	/// 它**不**負責看守預設語言值——`MockEngine` 不看 from/to，預設值改掉這裡照樣全綠。
	/// 看守那件事的是 `BridgeWireContractTests` 的 `parse fills in the default language tags`。
	@Test
	private func `typed request matches untyped entry`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine())
		let request: BridgeRequest = .init(
			identifier: "k1-0",
			source: "Hello",
			sourceLanguage: "en",
			targetLanguage: "zh-Hant"
		)
		let typed = await translator.respond(to: request)
		let untyped = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(typed == untyped)
		#expect(typed == .translated(identifier: "k1-0", text: "譯:Hello"))
	}

	/// 語言標籤原樣進 `actionableMessage`：訊息裡印的是呼叫端送來的標籤、不是正規化後的值。
	/// 失去這條，`BridgeRequest` 若改存 `Locale.Language` 會讓提示印出使用者沒打過的字串。
	///
	/// 兩個標籤刻意選會被 ICU 改寫的形狀（`zh-hant` → `zh-TW`、`iw` → `he`，皆為 deprecated
	/// 語言碼或大小寫非正規形）——用 `xx` / `yy` 這種進出同形的標籤，正規化與否測不出差別，
	/// 這條斷言就只是恆真。
	@Test
	private func `unsupported message echoes the caller tags`() async {
		let translator: BridgeTranslator = .init(engine: MockEngine(statusResult: .unsupported))
		let out = await translator.handle(["id": "k1-0", "source": "Hello", "from": "zh-hant", "to": "iw"])
		guard case .failed(_, let message) = out else {
			Issue.record("預查擋下時應回 .failed，實得 \(out)")
			return
		}
		// 斷言取「兩個標籤相鄰」而非各自 contains：訊息尾端的示例清單也列了語言碼，
		// 單獨 contains 一旦文案示例改成小寫就自動恆真；代入槽的形狀只有這裡湊得出來。
		#expect(message.contains("zh-hant → iw"), "訊息應原樣印回呼叫端送來的標籤，不是 zh-TW → he")
	}
}
