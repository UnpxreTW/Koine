//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// 翻譯引擎的基礎抽象層。
///
/// v1 只實作 `AppleTranslationEngine`（Apple Translation Framework）；未來的優化層
/// （post-edit）走另一個協定、不在此。
///
/// 目前採單句 `String` 簽名；整篇批次（`translate(batch:)`）待後續擴充。
public protocol TranslationEngine {

	/// 預查語言組合可用性（讓呼叫端 fail fast、把失敗轉成可行動提示、不洩漏 framework error）。
	func status(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus

	func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String
}
