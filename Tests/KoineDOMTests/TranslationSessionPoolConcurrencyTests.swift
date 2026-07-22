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

// MARK: - ConcurrencyRecorder

/// 執行緒安全的「同時執行中數」記錄器(翻譯執行封裝是 `@Sendable` 閉包、不能進 actor,故用鎖)。
private final class ConcurrencyRecorder: @unchecked Sendable {

	/// 歷史同時執行中數峰值。
	var maxInFlight: Int {
		lock.lock()
		defer { lock.unlock() }
		return peak
	}

	/// 進場:執行中數 +1、更新峰值;回傳本次進場序號(1 起算,供依呼叫序決定行為的測試樁使用)。
	func enter() -> Int {
		lock.lock()
		defer { lock.unlock() }
		inFlight += 1
		entered += 1
		peak = max(peak, inFlight)
		return entered
	}

	/// 離場:執行中數 -1。
	func exit() {
		lock.lock()
		defer { lock.unlock() }
		inFlight -= 1
	}

	/// 保護以下計數的鎖。
	private let lock: NSLock = .init()

	/// 當前執行中數。
	private var inFlight: Int = 0

	/// 歷史峰值。
	private var peak: Int = 0

	/// 累計進場次數。
	private var entered: Int = 0
}

// MARK: - SessionBuildCounter

/// 執行緒安全的 session 建構次數計數器(factory 是 `@Sendable` 同步閉包、不能進 actor,故用鎖)。
private final class SessionBuildCounter: @unchecked Sendable {

	/// 讀回當前計數。
	var count: Int {
		lock.lock()
		defer { lock.unlock() }
		return value
	}

	/// 計數 +1。
	func increment() {
		lock.lock()
		defer { lock.unlock() }
		value += 1
	}

	/// 保護 `value` 的鎖。
	private let lock: NSLock = .init()

	/// 當前計數。
	private var value: Int = 0
}

// MARK: - StubTranslateError

/// 測試樁專用錯誤(模擬 translate 失敗、觸發快取失效路徑)。
private struct StubTranslateError: Error {}

// MARK: - TranslationSessionPoolConcurrencyTests

/// `TranslationSessionPool` 門閂並發壓測:注入翻譯執行封裝觀測同時執行中數,
/// 驗證同語言對序列化(actor 於 `await` 期間可重入、靠門閂不交錯)、
/// 跨語言對各自序列化且全數完成、失敗路徑照樣釋放門閂並失效重建。
/// FIFO 喚醒序不直接斷言——等候佇列是私有實作、無公開觀測點;
/// 「序列化」與「全數完成(無漏喚醒,漏了測試會卡死不會誤過)」已間接覆蓋。
/// 樁內 `Task.sleep` 製造真懸掛點,讓可重入交錯有機會發生、峰值斷言才有鑑別力。
private final class TranslationSessionPoolConcurrencyTests {

	/// 100 件並發打同一語言對:同時執行中數峰值必為 1(門閂序列化)、
	/// 全數完成(無漏喚醒)、session 只建構一次(無失敗即全程複用)。
	@Test
	private func `concurrent same pair translates serialize`() async throws {
		let buildCounter: SessionBuildCounter = .init()
		let recorder: ConcurrencyRecorder = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				buildCounter.increment()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				_ = recorder.enter()
				try await Task.sleep(for: .milliseconds(1))
				recorder.exit()
				return text
			}
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		try await withThrowingTaskGroup(of: String.self) { group in
			for index in 0..<100 {
				group.addTask { try await pool.translate("句 \(index)", from: english, to: hant) }
			}
			var finished: Int = 0
			for try await _ in group { finished += 1 }
			#expect(finished == 100, "全數完成＝門閂無漏喚醒")
		}
		#expect(recorder.maxInFlight == 1, "同語言對同時執行中數峰值應為 1(序列化、可重入不交錯)")
		#expect(buildCounter.count == 1, "無失敗時全程應複用同一顆 session")
	}

	/// 兩語言對各 50 件並發:門閂以語言對為粒度——各自峰值為 1、
	/// 彼此皆全數完成(互不阻塞對方收尾)、各建一顆 session。
	@Test
	private func `distinct pairs serialize independently`() async throws {
		let buildCounter: SessionBuildCounter = .init()
		let recorderHant: ConcurrencyRecorder = .init()
		let recorderJapanese: ConcurrencyRecorder = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				buildCounter.increment()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				let recorder: ConcurrencyRecorder = text.hasPrefix("hant") ? recorderHant : recorderJapanese
				_ = recorder.enter()
				try await Task.sleep(for: .milliseconds(1))
				recorder.exit()
				return text
			}
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		let japanese: Locale.Language = .init(identifier: "ja")
		try await withThrowingTaskGroup(of: String.self) { group in
			for index in 0..<50 {
				group.addTask { try await pool.translate("hant \(index)", from: english, to: hant) }
				group.addTask { try await pool.translate("ja \(index)", from: english, to: japanese) }
			}
			var finished: Int = 0
			for try await _ in group { finished += 1 }
			#expect(finished == 100, "兩語言對皆全數完成、互不阻塞")
		}
		#expect(recorderHant.maxInFlight == 1, "en→zh-Hant 門閂各自序列化")
		#expect(recorderJapanese.maxInFlight == 1, "en→ja 門閂各自序列化")
		#expect(buildCounter.count == 2, "兩語言對各建構一顆 session")
	}

	/// 20 件並發同語言對、前 10 件模擬失敗:失敗照樣釋放門閂(後續全數完成、不卡死)、
	/// 每次失敗即丟棄快取(第 1〜10 件各自建構、第 11 件重建後 12〜20 複用＝共建 11 顆)、
	/// 序列化不因錯誤路徑破功(峰值仍 1)。
	@Test
	private func `failures release latch and invalidate cache`() async {
		let buildCounter: SessionBuildCounter = .init()
		let recorder: ConcurrencyRecorder = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in
				buildCounter.increment()
				return TranslationSession(installedSource: source, target: target)
			},
			translateOperation: { _, text in
				let sequence: Int = recorder.enter()
				try await Task.sleep(for: .milliseconds(1))
				recorder.exit()
				guard sequence > 10 else { throw StubTranslateError() }
				return text
			}
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		var successCount: Int = 0
		var failureCount: Int = 0
		await withTaskGroup(of: Bool.self) { group in
			for index in 0..<20 {
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
		#expect(successCount == 10, "序號 11〜20 應成功")
		#expect(failureCount == 10, "序號 1〜10 應失敗(樁模擬)")
		#expect(recorder.maxInFlight == 1, "錯誤路徑不破壞序列化")
		#expect(buildCounter.count == 11, "每次失敗即失效重建:10 次失敗各 1 顆＋成功後複用的 1 顆")
	}
}
