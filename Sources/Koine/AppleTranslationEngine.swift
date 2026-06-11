//
//  Koine
//
//  SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
//  SPDX-License-Identifier: MPL-2.0

import Foundation
import Translation

/// 語言組合的可用狀態（包裝 `LanguageAvailability.Status`，讓呼叫端不必依賴 Translation）。
public enum LanguagePairStatus {

	/// 語言包已就緒、可直接翻譯。
	case installed
	/// 組合受支援、但語言包尚未下載。
	case supported
	/// 不支援的組合（含無法識別的語言碼——`Locale.Language(identifier:)` 對亂碼不會失敗）。
	case unsupported
}

/// Apple Translation Framework 實作（基礎層、v1）。
///
/// 走 macOS 26 standalone init `TranslationSession(installedSource:target:)`，無 SwiftUI
/// lifecycle 依賴——純 async，命令列環境可直接呼叫。
///
/// 前提：來源 / 目標語言包須先於「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載；
/// 參數名 `installedSource` 即要求語言包已安裝，未裝會 throw、不會自動 prompt 下載。
/// 呼叫端可先以 `status(from:to:)` 預查、把失敗轉成可行動的提示。
public struct AppleTranslationEngine: TranslationEngine {

	public init() {}

	/// 預查語言組合可用性（standalone init 並非 throws、錯誤會延後到 `translate` 才爆，
	/// 預查讓呼叫端能 fail fast 並給出準確指引）。
	public func status(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus {
		switch await LanguageAvailability().status(from: source, to: target) {
		case .installed: .installed
		case .supported: .supported
		case .unsupported: .unsupported
		@unknown default: .unsupported
		}
	}

	public func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		let session = TranslationSession(installedSource: source, target: target)
		let response = try await session.translate(text)
		return response.targetText
	}
}
