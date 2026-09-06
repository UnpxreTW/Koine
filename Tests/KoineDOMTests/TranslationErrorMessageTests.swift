//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import CharacterizationSupport
import Foundation
import Koine
import Testing

// MARK: - MessageCase

/// 單一錯誤型別×時距組合的使用者可讀訊息，收進批次 golden。
private struct MessageCase: Encodable {

	/// 錯誤型別名，用來在批次 golden 裡辨識本筆屬於哪一種錯誤。
	let errorType: String

	/// 產生本筆訊息的時距標籤（如「500 毫秒」），對應時距矩陣的一格。
	let duration: String

	/// 該組合下的使用者可讀訊息，即 `localizedDescription` 的實際輸出。
	let message: String
}

// MARK: - TranslationErrorMessageTests

/// `TranslationTimeoutError` 與 `TranslationCircuitOpenError` 的使用者可讀訊息特徵化。
///
/// 這兩串文字是跨邊界的承諾：bridge 以 `localizedDescription` 回給 JS 端當 `.failed` 的
/// `error` 欄、CLI 直接印給使用者。既有測試只斷言**丟出哪一種錯誤型別**，訊息本體與時距的
/// 可讀寫法完全無人看守——把 `errorDescription` 刪掉、或把次秒分支拿掉，整套測試照樣全綠，
/// 使用者收到的卻已不是這兩句話。
///
/// 取值刻意走 `localizedDescription` 而非直接讀 `errorDescription`：前者才是兩個呼叫端實際
/// 用的路徑，`LocalizedError` 一致性若破掉（例如型別不再宣告遵循），只有這條讀法看得出來。
///
/// 時距矩陣覆蓋兩個分支與其交界：整數秒走「N 秒」、次秒走「N 毫秒」，1500 毫秒釘住
/// `components.seconds` 截斷後落在秒側的既有行為。**本檔是特徵化、不是規格**——記的是現況
/// 輸出，不主張它就該長這樣。
private final class TranslationErrorMessageTests {

	/// 兩種錯誤×六個時距一次 golden。
	@Test
	private func `renders user facing messages across durations`() throws {
		let durations: [(label: String, value: Duration)] = [
			("30 秒", .seconds(30)),
			("5 秒", .seconds(5)),
			("1500 毫秒", .milliseconds(1500)),
			("500 毫秒", .milliseconds(500)),
			("1 毫秒", .milliseconds(1)),
			("零", .zero)
		]
		var cases: [MessageCase] = []
		for (label, value) in durations {
			cases.append(MessageCase(
				errorType: "TranslationTimeoutError",
				duration: label,
				message: TranslationTimeoutError(limit: value).localizedDescription
			))
			cases.append(MessageCase(
				errorType: "TranslationCircuitOpenError",
				duration: label,
				message: TranslationCircuitOpenError(retryAfter: value).localizedDescription
			))
		}
		try expectGolden(of: cases, as: .json)
	}
}
