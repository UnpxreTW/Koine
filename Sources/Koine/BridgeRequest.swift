//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

/// 一筆 bridge 翻譯請求（§9.4 Bridge JSON 的 `{ id, source, from?, to? }`）。
///
/// 缺席的語言欄位在 `parse(_:)` 就補成預設值，核心因此拿不到「還沒決定用哪個語言」的中間
/// 狀態——語言標籤在型別上永遠是有值的 `String`，不是每個讀取點各自 `?? "en"` 一次。
///
/// `Sendable` 是跨 `Task` 邊界的必要條件——public 型別不會自動推導出該符合性，故顯式宣告；
/// `Equatable` 供呼叫端與測試直接比值。
public struct BridgeRequest: Equatable, Sendable {

	/// 線上訊息缺 `from` 時採用的來源語標籤。content script 只在頁面帶 `lang` 屬性時送 `from`，
	/// 沒有時就落到這個值。
	///
	/// 這兩個常數是**瀏覽器端的線上契約**、不是本型別的通用預設。故不 `public`、也不當 `init`
	/// 的預設引數：擺上公開面就等於邀請其他呼叫端（例如 CLI）靜默繼承擴充的假設，而那正是
	/// 這裡要避免的事。
	static let defaultSourceLanguage: String = "en"

	/// 線上訊息缺 `to` 時採用的目標語標籤，與 content script 的 `DEFAULT_TARGET_LANG` 同值
	/// （不公開、不當 `init` 預設引數的理由同 `defaultSourceLanguage`）。
	static let defaultTargetLanguage: String = "zh-Hant"

	/// 段落識別碼，原樣回填進回應供 JS 端一一對回。
	public let identifier: String

	/// 待譯原文。
	public let source: String

	/// 來源語 BCP-47 標籤。
	///
	/// 留 `String` 而不在此轉成 `Locale.Language`：`actionableMessage` 的文案要把使用者
	/// 原本送進來的標籤原樣印回去（「不支援的語言組合：xx → yy」），轉型後就拿不回那個字串了。
	public let sourceLanguage: String

	/// 目標語 BCP-47 標籤（不轉型的理由同 `sourceLanguage`）。
	public let targetLanguage: String

	/// 以 typed 值建構。語言標籤無預設引數——缺席語言該落到哪個值是線上契約，
	/// 由 `parse(_:)` 一處決定（見 `defaultSourceLanguage`）。
	public init(
		identifier: String,
		source: String,
		sourceLanguage: String,
		targetLanguage: String
	) {
		self.identifier = identifier
		self.source = source
		self.sourceLanguage = sourceLanguage
		self.targetLanguage = targetLanguage
	}
}

extension BridgeRequest {

	/// `parse(_:)` 的兩種結局。
	public enum Parsed: Equatable, Sendable {

		/// 必要欄位齊備，可送進核心。
		case request(BridgeRequest)

		/// 缺必要欄位；附帶的回應**就是**這個失敗的線上形狀，呼叫端直接回覆即可。
		///
		/// 本 case 只承載失敗形狀（`.failed` / `.unidentified`）。型別上構造得出
		/// `.malformed(.translated(...))`，那是自相矛盾的值——`parse(_:)` 不會產生它，
		/// 也不要在別處這樣構造。
		case malformed(BridgeResponse)
	}

	/// 解析 native message 邊界送來的 untyped 訊息。
	///
	/// 這是**入口側**唯一一處 `[String: Any]`（出口側對應的是 `BridgeResponse.payload`）。
	/// 邊界本身無型別可言（`SFExtensionMessageKey` 只給得出 dict），但缺鍵與型別不符在這裡
	/// 一次收斂，之後全程 typed。
	///
	/// 缺席的 `from` / `to` 在此補上 `defaultSourceLanguage` / `defaultTargetLanguage`
	/// （`en` / `zh-Hant`）——補值只發生在這裡，`init` 沒有對應的預設引數。
	///
	/// 回 `Parsed` 而不是 `throws`：兩種失敗各自對應一種**線上回應形狀**（缺 `id` 回不帶 `id`
	/// 的錯誤、缺 `source` 回帶 `id` 的錯誤）。把那個形狀直接放進結果，呼叫端就不必再維護一份
	/// 「哪個錯誤該組成哪種回應」的對照表——而那份對照表正是本型別要消滅的東西。
	///
	/// 未消費的欄位（如 JS 端送的 `type` 判別欄）在此一律忽略，維持既有行為。
	public static func parse(_ message: [String: Any]) -> Parsed {
		guard let identifier = message["id"] as? String else {
			return .malformed(.unidentified(message: "missing id"))
		}
		guard let source = message["source"] as? String else {
			return .malformed(.failed(identifier: identifier, message: "missing source"))
		}
		return .request(BridgeRequest(
			identifier: identifier,
			source: source,
			sourceLanguage: (message["from"] as? String) ?? defaultSourceLanguage,
			targetLanguage: (message["to"] as? String) ?? defaultTargetLanguage
		))
	}
}
