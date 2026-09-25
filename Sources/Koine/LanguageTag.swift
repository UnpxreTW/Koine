//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// BCP-47 語言標籤的比對。
internal enum LanguageTag {

	/// 漢字書寫系統的子標籤。
	private static let hanScripts: Set<String> = ["Hans", "Hant", "Hani"]

	/// 來源語是否**已經滿足**目標語（滿足＝這段文字不必翻）。
	///
	/// 比對在補齊 likely subtags 之後做，故 `zh-TW` 與 `zh-Hant`、`zh-CN` 與 `zh-Hans` 各自
	/// 視為同一件事——頁面上兩種寫法都常見，逐字比字串會讓前者永遠判成「要翻」。
	///
	/// - Warning: 書寫系統不同即不滿足：`zh-Hans` 對 `zh-Hant` 回 `false`，簡體段因此會走到
	///   翻譯，這正是簡體轉繁體就地換字所依賴的判準。
	/// - Warning: 裸 `zh` 經補齊後落在簡體（CLDR 的 likely subtag 預設），對繁體目標判不滿足、
	///   該段會送翻一次。只有「偵測信心不足、且回退到的標記語言恰為裸 `zh`」時才會碰到，
	///   代價是一次多餘的翻譯、不是破壞性行為。
	internal static func satisfies(source: String, target: String) -> Bool {
		let resolvedSource: Locale.Language = .init(
			identifier: Locale.Language(identifier: source).maximalIdentifier
		)
		let resolvedTarget: Locale.Language = .init(
			identifier: Locale.Language(identifier: target).maximalIdentifier
		)
		guard
			let sourceCode: String = resolvedSource.languageCode?.identifier,
			let targetCode: String = resolvedTarget.languageCode?.identifier,
			sourceCode == targetCode
		else { return false }
		return resolvedSource.script?.identifier == resolvedTarget.script?.identifier
	}

	/// 這段文字看起來像不像 `tag` 所宣告的書寫系統。
	///
	/// 只對漢字書寫系統有意見，其餘一律回 `true`（不表態）：問題出在漢字這一側——`zh-Hant`
	/// 頁面上的 `Home`／`Menu` 這類短英文字串，標籤說它們已達目標語，但內容一個漢字都沒有。
	///
	/// 用途限「標籤是用猜的」那條路：偵測判得出來時採信偵測、不必回頭問內容。
	///
	/// - Warning: 判準是 Unicode 的 `Ideographic` 屬性，與瀏覽器端那條 `Script=Han` 在部首區
	///   與 `々` 上不完全重疊。真實中文段落必然兩側同時命中（統一表意文字全在交集內）；分歧
	///   只在「整段只有部首或 `々`」這種構造，且方向是守門不過＝多翻一次，落在安全側。
	internal static func content(_ text: String, looksLike tag: String) -> Bool {
		let resolved: Locale.Language = .init(identifier: Locale.Language(identifier: tag).maximalIdentifier)
		guard
			let script: String = resolved.script?.identifier,
			hanScripts.contains(script)
		else { return true }
		return text.unicodeScalars.contains { $0.properties.isIdeographic }
	}
}
