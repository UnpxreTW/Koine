//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

/// 一筆 bridge 請求的回覆（§9.4 Bridge JSON），三種線上形狀窮舉。
///
/// 線上仍是 `[String: Any]`——NSExtension 的 `userInfo` 只收得下 property list——但那份
/// dict 只由 `payload` 一處組出。差別在於形狀從此是型別層的事實而非「哪幾個鍵剛好有值」的
/// 隱含約定：組回應漏鍵、讀回應漏分支，都變成編譯期問題。
///
/// `Sendable` 是跨 `Task` 邊界的必要條件（native handler 在非結構化 `Task` 內取得回覆）——
/// public 型別不會自動推導出該符合性，故顯式宣告；`Equatable` 供呼叫端與測試直接比值。
public enum BridgeResponse: Equatable, Sendable {

	/// 譯出：`{ id, text }`。
	///
	/// `text` 為空字串是**有效終態**（譯文＝原文、不顯示），不是失敗——JS 端據此跳過插回。
	case translated(identifier: String, text: String)

	/// 該段失敗：`{ id, error }`。`id` 原樣附回，JS 端據以把失敗對回那一段。
	case failed(identifier: String, message: String)

	/// 連 `id` 都取不到：`{ error }`。沒有任何段對得回來，屬協定違規。
	///
	/// 不與 `failed` 合併成「`identifier` 可為 nil」的單一 case：兩者對 JS 端是不同事件
	/// （某一段譯不出來 vs 整筆訊息不合法），型別層分開，組回應時才不可能漏掉沒有 `id`
	/// 的那條路——那正是 dict 形狀下最容易漏的一條。
	case unidentified(message: String)
}

extension BridgeResponse {

	/// 送回 JS 端的線上形狀。
	///
	/// 這裡的鍵名**就是** §9.4 契約的鍵名，改動即等於改協定：JS 端 `translateSegment` 讀
	/// `res.error` 判失敗、讀 `res.text` 取譯文（見 `content.js`）。
	///
	/// 值型別維持 `Any` 而非收窄成 `String`：這份 dict 直接進 `NSExtensionItem.userInfo`
	/// （`[AnyHashable: Any]`）由 Safari 序列化，收窄會改變送進橋接層的具體型別，而該行為
	/// 只有真的跑一次擴充才驗得出。現行三種形狀的值恰好都是字串是巧合，不是契約。
	public var payload: [String: Any] {
		switch self {
		case .translated(let identifier, let text):
			return ["id": identifier, "text": text]
		case .failed(let identifier, let message):
			return ["id": identifier, "error": message]
		case .unidentified(let message):
			return ["error": message]
		}
	}
}
