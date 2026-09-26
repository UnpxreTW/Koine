//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import Koine

/// 固定回答的語言偵測器（bridge 測試共用）。
///
/// 回 `nil`＝「判不出來」，`BridgeTranslator` 因此原樣採用請求帶來的語言標籤。與語言無關的
/// bridge 測試（訊息拆解、錯誤傳遞）一律注入這個預設值：真偵測器的輸出隨作業系統版本浮動，
/// 拿它當那些測試的前提會讓斷言在不同機器上閃紅。
internal struct FixedLanguageDetector: LanguageDetecting {

	/// `detect` 的固定回答。
	internal let result: String?

	/// 預設判不出來。
	internal init(result: String? = nil) {
		self.result = result
	}

	/// 回固定值、不看輸入。
	internal func detect(_ text: String) -> String? {
		result
	}
}
