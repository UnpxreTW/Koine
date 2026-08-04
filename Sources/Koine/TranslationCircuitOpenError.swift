//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// 該語言對連續逾時達門檻、目前短路中（`TranslationSessionPool` 的短路保護觸發）。
///
/// 與 `TranslationTimeoutError` 語義不同：後者代表「真的嘗試過、只是沒等到」；本錯誤代表
/// **完全沒有嘗試**——服務持續無回應時，短路保護刻意讓後續請求快速失敗，不再各自等滿逾時
/// 上限、不建 session，避免資源隨隊伍長度線性累積。短路解除後（見 `retryAfter`）下一次呼叫
/// 會照常嘗試（視為復原探測），與本錯誤無關。
public struct TranslationCircuitOpenError: LocalizedError, Sendable {

	/// 短路解除前還要多久（呼叫端可用來決定要不要提示使用者稍後再試，或直接靜默跳過此語言對）。
	public let retryAfter: Duration

	/// 記下短路解除前的剩餘時間。
	public init(retryAfter: Duration) {
		self.retryAfter = retryAfter
	}

	/// 使用者可讀訊息（bridge 以 `localizedDescription` 回給 JS 端、CLI 直接印，同
	/// `TranslationTimeoutError` 的既有路徑）。
	public var errorDescription: String? {
		"翻譯服務持續無回應，此語言組合暫時停用（約 \(readableRetryAfter) 後恢復嘗試）。"
	}

	/// 剩餘時間的可讀寫法，同 `TranslationTimeoutError.readableLimit` 的次秒處理
	/// （`retryAfter` 是 public init 參數，整數秒截斷會讓次秒值印成「約 0 秒後」）。
	///
	/// !!!: 與 `TranslationTimeoutError.readableLimit` 除了屬性名以外逐字相同，刻意不抽共用：
	/// 為一個六行純函式另立共用型別，代價是兩個本來各自獨立的 error 型別從此互相依賴（或多一個
	/// 只為它們存在的第三方型別）。語境差異住在 `errorDescription`、不在這裡，所以共用也省不掉
	/// 那一層——重複的成本低於耦合的成本。
	private var readableRetryAfter: String {
		let attosecondsPerMillisecond: Int64 = 1_000_000_000_000_000
		let (seconds, attoseconds): (Int64, Int64) = retryAfter.components
		guard seconds > 0 else {
			return "\(attoseconds / attosecondsPerMillisecond) 毫秒"
		}
		return "\(seconds) 秒"
	}
}
