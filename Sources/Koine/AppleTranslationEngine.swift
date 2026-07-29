//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation
import Translation

/// Apple Translation Framework 實作（基礎層、v1）。
///
/// 走 macOS 26 standalone init `TranslationSession(installedSource:target:)`，無 SwiftUI
/// lifecycle 依賴——純 async，命令列環境可直接呼叫。
///
/// 前提：來源 / 目標語言包須先於「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載；
/// 參數名 `installedSource` 即要求語言包已安裝，未裝會 throw、不會自動 prompt 下載。
/// 呼叫端可先以 `status(from:to:)` 預查、把失敗轉成可行動的提示。
public struct AppleTranslationEngine: TranslationEngine {

	/// 無狀態建構（v1 無可注入依賴；session 快取由進程級 `TranslationSessionPool` 管）。
	public init() {}

	/// 預查語言組合可用性（standalone init 並非 throws、錯誤會延後到 `translate` 才爆，
	/// 預查讓呼叫端能 fail fast 並給出準確指引）。
	///
	/// 每段翻譯前都會呼叫本方法；同頁 from/to 固定時逐段重查 `LanguageAvailability` 是冗餘的
	/// 跨程序往返，故先問 `TranslationSessionPool` 該語言對是否已知已裝妥、命中就跳過真查。
	/// 只快取正向結果——`.supported` / `.unsupported` 不快取，見 `TranslationSessionPool` 上的說明。
	public func status(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus {
		if await TranslationSessionPool.shared.isKnownInstalled(from: source, to: target) {
			return .installed
		}
		let result: LanguagePairStatus =
			switch await LanguageAvailability().status(from: source, to: target) {
			case .installed: .installed
			case .supported: .supported
			case .unsupported: .unsupported
			@unknown default: .unsupported
			}
		if case .installed = result {
			await TranslationSessionPool.shared.markInstalled(from: source, to: target)
		}
		return result
	}

	/// 本機 Apple Translation 支援的語言代碼（BCP-47 `minimalIdentifier`、去重後字典序）。
	///
	/// 供可發現性用途（CLI 列表、shell 補全），**不是翻譯前的前提檢查**——「支援」只代表
	/// Apple 認得這個語言，語言包裝了沒仍由 `status(from:to:)` 判定。兩者混用會把
	/// 「支援但未下載」誤讀成可直接翻譯。
	///
	/// 回傳 `minimalIdentifier` 而非 `maximalIdentifier`：前者（`ja`、`zh-TW`、`en-GB`）是
	/// 呼叫端能原樣填回 `--from` / `--to` 的形式，後者（`ja-Jpan-JP`）補全了書寫系統與地區、
	/// 讀起來像另一組代碼。排序固定讓輸出可 diff、可比 golden。
	public func supportedLanguages() async -> [String] {
		let identifiers = await LanguageAvailability().supportedLanguages.map(\.minimalIdentifier)
		return Set(identifiers).sorted()
	}

	/// 委派進程級 `TranslationSessionPool` 以複用 session（每句重建實測多耗約 50ms）。
	public func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		try await TranslationSessionPool.shared.translate(text, from: source, to: target)
	}
}
