//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import Testing

import Koine

/// mock 翻譯引擎：`status` 回可設定狀態、`translate` 回固定譯文或依旗標拋錯，
/// 供 `BridgeTranslator` 單測不碰真 `translationd`。
private struct MockEngine: TranslationEngine {

	/// 為 true 時 `translate` 一律拋錯（測引擎失敗路徑）。
	let shouldFail: Bool

	/// `status` 回傳的狀態（測預查分支；預設 `.installed`）。
	let statusResult: LanguagePairStatus

	/// 預設成功可用：`shouldFail=false`、`statusResult=.installed`。
	init(shouldFail: Bool = false, statusResult: LanguagePairStatus = .installed) {
		self.shouldFail = shouldFail
		self.statusResult = statusResult
	}

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

/// mock 引擎的測試用錯誤。
private enum MockError: Error {

	/// 泛用失敗。
	case boom
}

/// 核心 bridge 邏輯跑道：`BridgeTranslator.handle` 的訊息拆解 + 引擎委派（注入 mock、不碰真 `translationd`）。
struct BridgeTranslatorTests {

	/// 成功：`{id, source}` → `{id, text}`、無 error。
	@Test func successReturnsIDAndText() async {
		let translator = BridgeTranslator(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["id": "k1-0", "source": "Hello", "from": "en", "to": "zh-Hant"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["text"] as? String == "譯:Hello")
		#expect(out["error"] == nil)
	}

	/// 缺 id：回 error、無 id（無從對回、屬協定違規）。
	@Test func missingIDReturnsError() async {
		let translator = BridgeTranslator(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["source": "Hello"])
		#expect(out["error"] != nil)
		#expect(out["id"] == nil)
	}

	/// 缺 source：回 `{id, error}`（保留 id 供 JS 端對回該段的失敗）。
	@Test func missingSourceReturnsIDAndError() async {
		let translator = BridgeTranslator(engine: MockEngine(shouldFail: false))
		let out = await translator.handle(["id": "k1-0"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["error"] != nil)
		#expect(out["text"] == nil)
	}

	/// 引擎拋錯：回 `{id, error}`、無 text。
	@Test func engineFailureReturnsIDAndError() async {
		let translator = BridgeTranslator(engine: MockEngine(shouldFail: true))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["error"] != nil)
		#expect(out["text"] == nil)
	}

	/// 預查 supported（語言包未下載）：回 `{id, error}` 含可行動提示、不進 translate。
	@Test func statusSupportedReturnsActionableError() async {
		let translator = BridgeTranslator(engine: MockEngine(statusResult: .supported))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["text"] == nil)
		#expect((out["error"] as? String)?.contains("語言包未下載") == true, "應給可行動的語言包提示")
	}

	/// 預查 unsupported：回 `{id, error}` 含不支援提示、不進 translate。
	@Test func statusUnsupportedReturnsActionableError() async {
		let translator = BridgeTranslator(engine: MockEngine(statusResult: .unsupported))
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["text"] == nil)
		#expect((out["error"] as? String)?.contains("不支援") == true, "應給不支援組合提示")
	}

	/// 不帶 from/to：走預設 en → zh-Hant、installed → 成功 `{id, text}`。
	@Test func defaultFromToSucceeds() async {
		let translator = BridgeTranslator(engine: MockEngine())
		let out = await translator.handle(["id": "k1-0", "source": "Hello"])
		#expect(out["id"] as? String == "k1-0")
		#expect(out["text"] as? String == "譯:Hello")
		#expect(out["error"] == nil)
	}
}
