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

// MARK: - LanguageRecognizerDetectorTests

/// 真偵測器的特徵化：只釘住跨版本穩定的部分（明顯長句的判定、門檻的作用方向）。
///
/// - Warning: 刻意不斷言「某個短字串一定判不出來」——那個界線由作業系統的模型決定，會隨
///   版本移動，寫進斷言等於讓測試在別台機器上紅。信心不足的**行為**由注入固定回答的那幾條釘住。
private final class LanguageRecognizerDetectorTests {

	/// 模型分得出簡繁——這是整條簡→繁路徑的前提。
	///
	/// 門檻取 0 是刻意的：本條問的是「分不分得出」，不是「信心夠不夠」。兩件事綁在同一條
	/// 斷言裡，任何一邊浮動都會紅，而讀的人分不出是哪一邊。
	@Test
	private func `scripts are told apart`() {
		let detector: LanguageRecognizerDetector = .init(confidenceThreshold: 0)
		#expect(detector.detect("这是一段用简体中文写成的内容，用来验证语言判定是否正确。") == "zh-Hans")
		#expect(detector.detect("這是一段用繁體中文寫成的內容，用來驗證語言判定是否正確。") == "zh-Hant")
	}

	/// 明顯的長句在預設門檻下判得出來——門檻沒有高到連這種輸入都擋掉。
	///
	/// 只斷言「判得出來」、不釘是哪個語碼：語碼由上一條在零門檻下釘，這裡問的是門檻值本身
	/// 選得合不合理。兩條合起來才是「0.72 這個值可用」的證據。
	@Test
	private func `obvious input clears the default threshold`() {
		let detector: LanguageRecognizerDetector = .init()
		#expect(detector.detect("这是一段用简体中文写成的内容，用来验证语言判定是否正确。") != nil)
	}

	/// 空字串判不出來——沒有內容就沒有假設可挑。
	@Test
	private func `empty text yields no language`() {
		#expect(LanguageRecognizerDetector().detect("") == nil)
	}

	/// 門檻的作用方向：不可能達到的門檻讓任何輸入都判不出來。
	///
	/// 這條與下一條成對，證明門檻真的接在判定上——只有預設門檻的測試無法分辨
	/// 「門檻生效」與「門檻被忽略」。
	@Test
	private func `unreachable threshold rejects everything`() {
		let detector: LanguageRecognizerDetector = .init(confidenceThreshold: 1.1)
		#expect(detector.detect("这是一段用简体中文写成的内容，用来验证语言判定是否正确。") == nil)
	}

	/// 門檻為零時同一段輸入照樣判得出來（對照組）。
	@Test
	private func `zero threshold accepts the same input`() {
		let detector: LanguageRecognizerDetector = .init(confidenceThreshold: 0)
		#expect(detector.detect("这是一段用简体中文写成的内容，用来验证语言判定是否正确。") == "zh-Hans")
	}

	/// 預設門檻＝0.72（`BridgeTranslator` 的預設偵測器用的就是它）。
	@Test
	private func `default threshold is pinned`() {
		#expect(LanguageRecognizerDetector.defaultConfidenceThreshold == 0.72)
	}
}
