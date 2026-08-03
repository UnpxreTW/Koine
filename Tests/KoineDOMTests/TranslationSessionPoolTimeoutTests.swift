//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Foundation
import Koine
import Testing
import Translation

// MARK: - HangGate

/// 可控的「永不返回」閘：翻譯樁在此懸掛，且**不理會取消**——`withCheckedContinuation` 沒有取消路徑，
/// 正好模擬 translate 卡在不可取消的跨程序等待（逾時保護要解的就是這一型）。
/// 用長 `Task.sleep` 當卡死樁測不到這一型：那種樁一 cancel 就收工，保護層拿掉照樣綠。
/// 測試收尾呼叫 `release()` 讓樁收工，不留常駐任務污染同進程的其他測試。
private final class HangGate: @unchecked Sendable {

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

// MARK: - TranslateLedger

/// 執行緒安全的樁帳本：記進場序號（供「只讓第一件卡死」的樁分流）與 session 建構次數
/// （factory 與翻譯執行封裝都是 `@Sendable` 閉包、不能進 actor，故用鎖）。
private final class TranslateLedger: @unchecked Sendable {

	/// 已進場的翻譯件數。
	var enteredCount: Int {
		lock.lock()
		defer { lock.unlock() }
		return entered
	}

	/// 已建構的 session 顆數。
	var builtCount: Int {
		lock.lock()
		defer { lock.unlock() }
		return built
	}

	/// 進場並取本次序號（1 起算）。
	func enter() -> Int {
		lock.lock()
		defer { lock.unlock() }
		entered += 1
		return entered
	}

	/// 記一次 session 建構。
	func recordBuild() {
		lock.lock()
		defer { lock.unlock() }
		built += 1
	}

	/// 保護以下計數的鎖。
	private let lock: NSLock = .init()

	/// 累計進場件數。
	private var entered: Int = 0

	/// 累計建構顆數。
	private var built: Int = 0
}

// MARK: - TranslationSessionPoolTimeoutTests

/// `TranslationSessionPool` 的逾時保護（門閂安全的另一半）：單件 translate 卡在**不可取消**的
/// 等待時，該件必須被放棄、門閂必須回到隊伍手上，而上限之內返回的翻譯不受任何影響。
///
/// 逾時保護若改用 task group 賽跑，前兩條會**卡死而不是失敗**——task group 保證 body 返回前
/// 所有子任務都已結束，卡死的子任務會把 group 一起綁住。那正是這兩條非測不可的理由，
/// 也是 CI test job 需要 `timeout-minutes` 的理由（回歸時會掛住、不會自己收工）。
private final class TranslationSessionPoolTimeoutTests {

	/// 首件 translate 永不返回（且不理會取消）：該件在上限後以 `TranslationTimeoutError` 收場、
	/// 門閂隨即釋放，後續同語言對請求照常完成，且逾時視同該語言對 session 失效（下一件重建一顆）。
	@Test
	private func `hung translate times out and unblocks the queue`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: TranslateLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				ledger.recordBuild()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				if ledger.enter() == 1 { await gate.wait() }
				return text
			},
			timeout: .milliseconds(500)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self, "卡死的那件應以逾時收場、不無限等待") {
			try await pool.translate("卡住的一句", from: english, to: hant)
		}
		let recovered: String = try await pool.translate("後續的一句", from: english, to: hant)
		#expect(recovered == "後續的一句", "逾時後門閂已釋放、後續請求不再被隊頭阻塞")
		#expect(ledger.builtCount == 2, "逾時視同該語言對 session 失效、後續請求重建一顆")
	}

	/// 隊頭卡死時整條隊伍不陪葬：5 件並發同語言對、最先進場的那件永不返回——
	/// 恰 1 件逾時失敗、其餘 4 件全數完成（門閂在逾時後轉交、非全隊卡死）。
	@Test
	private func `queued requests survive a hung head of line`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: TranslateLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				ledger.recordBuild()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				if ledger.enter() == 1 { await gate.wait() }
				return text
			},
			timeout: .milliseconds(500)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		var successCount: Int = 0
		var failureCount: Int = 0
		await withTaskGroup(of: Bool.self) { group in
			for index in 0..<5 {
				group.addTask {
					do {
						_ = try await pool.translate("句 \(index)", from: english, to: hant)
						return true
					} catch {
						return false
					}
				}
			}
			for await didSucceed in group {
				if didSucceed {
					successCount += 1
				} else {
					failureCount += 1
				}
			}
		}
		#expect(failureCount == 1, "只有卡死的隊頭該失敗")
		#expect(successCount == 4, "排在後面的全數完成＝門閂已從卡死者手上取回")
		#expect(ledger.builtCount == 2, "逾時失效重建一顆，之後 4 件複用")
	}

	/// 呼叫端 task 在翻譯途中被取消：該件以 `CancellationError` 收場（而非拖到逾時），
	/// 且門閂必須歸還、後續請求照常完成。這是保護層唯一靠串流取消語義（iterator 回 nil）
	/// 撐住的分支，特別釘成回歸測試；上限設 10 秒，取消若失效會拖到逾時而錯誤型別對不上＝失敗。
	@Test
	private func `cancelling the caller releases the latch`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: TranslateLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				if ledger.enter() == 1 { await gate.wait() }
				return text
			},
			timeout: .seconds(10)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		let inFlight: Task<String, any Error> = Task {
			try await pool.translate("被取消的一句", from: english, to: hant)
		}
		var spins: Int = 0
		while ledger.enteredCount < 1, spins < 10_000 {
			await Task.yield()
			spins += 1
		}
		#expect(ledger.enteredCount == 1, "樁應已進場，取消才打得到等待中的那一件")
		inFlight.cancel()
		await #expect(throws: CancellationError.self, "取消應即刻以取消收場、不是拖到逾時") {
			try await inFlight.value
		}
		let recovered: String = try await pool.translate("後續的一句", from: english, to: hant)
		#expect(recovered == "後續的一句", "取消後門閂已歸還、後續請求照常完成")
	}

	/// 上限之內返回的翻譯完全不受保護層影響：不誤判逾時、譯文原樣透傳、session 照常複用。
	@Test
	private func `translate within the limit is unaffected`() async throws {
		let ledger: TranslateLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				ledger.recordBuild()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				try await Task.sleep(for: .milliseconds(1))
				return text
			},
			timeout: .seconds(30)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		let first: String = try await pool.translate("一", from: english, to: hant)
		let second: String = try await pool.translate("二", from: english, to: hant)
		#expect(first == "一", "譯文原樣透傳、未被保護層改寫")
		#expect(second == "二", "譯文原樣透傳、未被保護層改寫")
		#expect(ledger.builtCount == 1, "未逾時就不該丟棄快取")
	}
}
