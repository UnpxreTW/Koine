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
