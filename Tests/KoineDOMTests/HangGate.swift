//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation

/// 可控的「永不返回」閘：樁在此懸掛，且**不理會取消**——`withCheckedContinuation` 沒有取消路徑，
/// 正好模擬跨程序呼叫卡在不可取消的等待（逾時保護要解的就是這一型）。
/// 用長 `Task.sleep` 當卡死樁測不到這一型：那種樁一 cancel 就收工，保護層拿掉照樣綠。
/// 測試收尾呼叫 `release()` 讓樁收工，不留常駐任務污染同進程的其他測試。
///
/// 供全部逾時測試共用（翻譯與可用性預查各有一套保護層、卡死樁的形狀相同）——這一型的正確性
/// 全靠「不理會取消」這個細節撐著，抄成兩份等於埋一份遲早會被寫成 `Task.sleep` 的假樁。
final class HangGate: @unchecked Sendable {

	/// 懸掛直到 `release()` 被呼叫；已放行過則立即返回。
	func wait() async {
		await withCheckedContinuation { continuation in
			lock.lock()
			guard !isReleased else {
				lock.unlock()
				continuation.resume()
				return
			}
			waiters.append(continuation)
			lock.unlock()
		}
	}

	/// 放行所有懸掛者，並讓之後的 `wait()` 直接通過。
	func release() {
		lock.lock()
		isReleased = true
		let pending: [CheckedContinuation<Void, Never>] = waiters
		waiters.removeAll()
		lock.unlock()
		for continuation in pending { continuation.resume() }
	}

	/// 保護以下狀態的鎖。
	private let lock: NSLock = .init()

	/// 尚未放行的懸掛者。
	private var waiters: [CheckedContinuation<Void, Never>] = []

	/// 是否已放行。
	private var isReleased: Bool = false
}
