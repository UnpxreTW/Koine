//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// 依內容判定一段文字是什麼語言的抽象層。
///
/// 抽成協定是為了讓 `BridgeTranslator` 的語言解析可被注入測試——真偵測器的輸出隨作業系統
/// 版本浮動，拿它斷言「這個短字串一定判不出來」會在不同機器上閃紅。
public protocol LanguageDetecting {

	/// 判定 `text` 的語言。
	///
	/// - Returns: BCP-47 語言標籤；信心不足或判不出來一律回 `nil`，呼叫端據此回退到標記語言
	///   （最近帶 `lang` 的祖先，再無則頁面語言）。
	/// - Note: 回 `nil` 不是錯誤、是正常結局。
	func detect(_ text: String) -> String?
}
