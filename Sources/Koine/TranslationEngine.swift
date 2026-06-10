//
//  Koine
//
//  SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
//  SPDX-License-Identifier: MPL-2.0

import Foundation

/// 翻譯引擎的基礎抽象層。
///
/// v1 只實作 `AppleTranslationEngine`（Apple Translation Framework）；未來的優化層
/// （post-edit）走另一個協定、不在此。
///
/// 目前採單句 `String` 簽名；整篇批次（`translate(batch:)`）待後續擴充。
public protocol TranslationEngine {

	func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String
}
