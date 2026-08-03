//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation

/// 單件翻譯超過等待上限仍未返回（`TranslationSessionPool` 的逾時保護觸發）。
///
/// 語義是「**放棄等待**」而非「已知失敗」——`translationd` 走跨程序往返，被判逾時的那一件仍可能
/// 在背景跑完，只是結果已無人接收。池同時把該語言對的 session 視為失效、下次呼叫重建。
public struct TranslationTimeoutError: LocalizedError, Sendable {

	/// 觸發本次逾時的等待上限。
	public let limit: Duration

	/// 記下觸發逾時的等待上限。
	public init(limit: Duration) {
		self.limit = limit
	}

	/// 使用者可讀訊息（bridge 以 `localizedDescription` 回給 JS 端、CLI 直接印）。
	public var errorDescription: String? {
		"翻譯逾時（超過 \(readableLimit) 未返回）。請再試一次；若持續發生，請確認系統翻譯服務是否正常。"
	}

	/// 等待上限的可讀寫法。次秒上限改印毫秒——`limit` 是 public init 參數，
	/// 整數秒截斷會讓 `.milliseconds(500)` 印成「超過 0 秒未返回」。
	private var readableLimit: String {
		let attosecondsPerMillisecond: Int64 = 1_000_000_000_000_000
		let (seconds, attoseconds): (Int64, Int64) = limit.components
		guard seconds > 0 else {
			return "\(attoseconds / attosecondsPerMillisecond) 毫秒"
		}
		return "\(seconds) 秒"
	}
}
