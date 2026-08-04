//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation

/// 執行緒安全的樁帳本：記進場序號（供「只讓特定序號走某條路」的樁分流）與進場總次數
/// （observe 短路中是否仍真的呼叫到被短路的那條路）。
///
/// 閉包是 `@Sendable`、不能進 actor，故用鎖。供短路相關測試共用——同 `HangGate` 的理由：
/// 這一型的正確性全靠「進場計數與序號來自同一次上鎖」撐著，抄成多份等於埋下遲早會被寫成
/// 裸 `var` 的假帳本。
///
/// `TranslationSessionPoolTimeoutTests` 的 `TranslateLedger` 是同形狀的另一份，但它多帶一組
/// session 建構計數；併進來會讓只需要進場計數的呼叫端也扛著那組欄位，故暫不合併。
final class CircuitLedger: @unchecked Sendable {

	/// 已進場次數。
	var enteredCount: Int {
		lock.lock()
		defer { lock.unlock() }
		return entered
	}

	/// 進場並取本次序號（1 起算）。
	func enter() -> Int {
		lock.lock()
		defer { lock.unlock() }
		entered += 1
		return entered
	}

	/// 保護以下計數的鎖。
	private let lock: NSLock = .init()

	/// 累計進場次數。
	private var entered: Int = 0
}
