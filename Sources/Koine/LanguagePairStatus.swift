//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

/// 語言組合的可用狀態（包裝 `LanguageAvailability.Status`，讓呼叫端不必依賴 Translation）。
public enum LanguagePairStatus {

	/// 語言包已就緒、可直接翻譯。
	case installed

	/// 組合受支援、但語言包尚未下載。
	case supported

	/// 不支援的組合（含無法識別的語言碼——`Locale.Language(identifier:)` 對亂碼不會失敗）。
	case unsupported
}

extension LanguagePairStatus {

	/// 非 `installed` 時的可行動失敗訊息（CLI 與 bridge 共用單一出處，避免文案分歧）；
	/// `installed` 回 `nil`（可直接翻譯、無需提示）。
	public func actionableMessage(from: String, to: String) -> String? {
		switch self {
		case .installed:
			return nil
		case .supported:
			return "語言包未下載（\(from) → \(to)）。請至「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載後再試。"
		case .unsupported:
			return "不支援的語言組合：\(from) → \(to)。請確認語言碼（BCP-47，如 en、zh-Hant、ja）。"
		}
	}
}
