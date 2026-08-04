//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

/// 語言組合的可用狀態（包裝 `LanguageAvailability.Status`，讓呼叫端不必依賴 Translation）。
///
/// `Sendable` 是跨 `Task` 邊界的必要條件（可用性預查在非結構化 `Task` 內跑）——public 型別
/// 不會自動推導出該符合性，故顯式宣告；`Equatable` 供呼叫端與測試直接比值。
public enum LanguagePairStatus: Equatable, Sendable {

	/// 語言包已就緒、可直接翻譯。
	case installed

	/// 組合受支援、但語言包尚未下載。
	case supported

	/// 不支援的組合（含無法識別的語言碼——`Locale.Language(identifier:)` 對亂碼不會失敗）。
	case unsupported

	/// 可用性查詢未在等待上限內返回，狀態無從判定。
	///
	/// **語義是「預查不做結論」、不是一種失敗**：`actionableMessage` 對本值回 `nil`，呼叫端照常
	/// 往下走真正的翻譯。預查的職責只是把最常見的兩種失敗換成可行動訊息，查不出來時它該讓開，
	/// 不該升格成一道新的閘門——可用性端點慢而翻譯本身正常時，擋下來等於憑一個沒查到的答案
	/// 否決一件做得到的事。真失敗仍會在翻譯層現形（那層有自己的等待上限與真實錯誤）。
	///
	/// 那為什麼不乾脆回 `installed` 混過去：`status` 對 `installed` 會把該語言對寫進
	/// `TranslationSessionPool` 的「已知已裝妥」快取——語言包真的沒裝時，下一次翻譯就拿不到
	/// 「請去下載語言包」的指引、改吃一則原始 framework error，要等那次真失敗才把假標清掉。
	/// 獨立一個值讓「不擋路」與「不記帳」兩件事同時成立。
	case undetermined
}

extension LanguagePairStatus {

	/// 已知失敗時的可行動訊息（CLI 與 bridge 共用單一出處，避免文案分歧）；
	/// `installed` 與 `undetermined` 回 `nil`——前者可直接翻譯，後者是「沒查出來」而非失敗，
	/// 呼叫端照常往下走（理由見該 case 的說明）。呼叫端一律以「非 nil 才早退」消費本方法，
	/// 故這裡回什麼就等於決定了預查擋不擋路。
	public func actionableMessage(from: String, to: String) -> String? {
		switch self {
		case .installed:
			return nil
		case .supported:
			return "語言包未下載（\(from) → \(to)）。請至「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載後再試。"
		case .unsupported:
			return "不支援的語言組合：\(from) → \(to)。請確認語言碼（BCP-47，如 en、zh-Hant、ja）。"
		case .undetermined:
			return nil
		}
	}
}
