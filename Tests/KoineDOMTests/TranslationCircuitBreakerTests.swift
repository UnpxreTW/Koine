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

// MARK: - TranslationCircuitBreakerTests

/// `TranslationSessionPool` 的短路保護（見該型別說明「短路保護」段）：解決逾時保護解決不了的
/// 「服務**持續**卡住時資源仍累積」——連續逾時達門檻後，後續請求不再各自等滿 `timeout`、
/// 不建 session、不呼叫 `translateOperation`，直接以 `TranslationCircuitOpenError` 快速失敗；
/// 短路窗口期滿後下一次呼叫視為復原探測，探測有回應即關閉短路。
///
/// 本檔沿用 `HangGate`（不理會取消的卡死樁），但失敗形態與既有逾時測試**不同**：短路保護若失效，
/// 請求會落回仍然完好的逾時層、在一個 `timeout` 後拋 `TranslationTimeoutError`，於是斷言以
/// 錯誤型別不符**轉紅**，不會掛住。掛住只在逾時層本身也被改壞時才會發生（那是
/// `TranslationSessionPoolTimeoutTests` 的守備範圍）。
private final class TranslationCircuitBreakerTests {

	/// 連續逾時達門檻（3）即短路：第 1～3 件各自真的逾時一次（計數 1→2→3），第 4 件命中門檻、
	/// 應立即以 `TranslationCircuitOpenError` 失敗且明顯快於 `timeout`——證明它沒有真的嘗試
	/// （未進 `translateOperation`）。門檻本身是「已發生的連續逾時次數」，故「第 N 件觸發門檻」
	/// 與「第 N 件被短路擋下」是不同兩回事：擋下的是門檻達成**之後**的下一件。
	@Test
	private func `consecutive timeouts trip the circuit`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				_ = ledger.enter()
				await gate.wait()  // 每一件都卡死、不只第一件——本測試要連續逾時。
				return text
			},
			timeout: .milliseconds(300),
			consecutiveTimeoutThreshold: 3,
			circuitOpenDuration: .seconds(30)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self, "第一件應逾時（計數 1，未達門檻）") {
			try await pool.translate("一", from: english, to: hant)
		}
		await #expect(throws: TranslationTimeoutError.self, "第二件仍逾時（計數 2，未達門檻）") {
			try await pool.translate("二", from: english, to: hant)
		}
		await #expect(throws: TranslationTimeoutError.self, "第三件仍逾時（計數達門檻 3、短路自本件之後生效）") {
			try await pool.translate("三", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 3, "前三件都應真的進場嘗試、各自付出一次逾時")
		let clock: ContinuousClock = .init()
		let start: ContinuousClock.Instant = clock.now
		await #expect(throws: TranslationCircuitOpenError.self, "第四件應短路而非逾時") {
			try await pool.translate("四", from: english, to: hant)
		}
		let elapsed: Duration = clock.now - start
		#expect(elapsed < .milliseconds(150), "短路應立即失敗、明顯快於 300ms 的 timeout（實測 \(elapsed)）")
		#expect(ledger.enteredCount == 3, "短路中不應再呼叫 translateOperation")
	}

	/// 短路期間連續多筆請求全數快速失敗、不再實際等待——不只擋下第一筆，整個開路窗口內皆然。
	@Test
	private func `requests during the open window fail fast without attempting`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				_ = ledger.enter()
				await gate.wait()
				return text
			},
			timeout: .milliseconds(300),
			consecutiveTimeoutThreshold: 1,
			circuitOpenDuration: .seconds(30)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self, "門檻為 1，第一件逾時即觸發短路") {
			try await pool.translate("一", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 1)
		let isOpen: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(isOpen == true, "第一件逾時後應已短路")
		let clock: ContinuousClock = .init()
		for index in 0..<5 {
			let start: ContinuousClock.Instant = clock.now
			await #expect(throws: TranslationCircuitOpenError.self, "短路窗口內第 \(index) 筆應快速失敗") {
				try await pool.translate("後續 \(index)", from: english, to: hant)
			}
			let elapsed: Duration = clock.now - start
			#expect(elapsed < .milliseconds(150), "第 \(index) 筆應近乎即時失敗（實測 \(elapsed)）")
		}
		#expect(ledger.enteredCount == 1, "短路窗口內 5 筆皆不應呼叫 translateOperation")
	}

	/// 短路窗口期滿後，下一次呼叫視為復原探測：探測成功即關閉短路、計數歸零，
	/// 之後的請求恢復正常路徑（不再被短路擋下）。
	@Test
	private func `circuit closes after a successful probe once the open window elapses`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				let sequence: Int = ledger.enter()
				if sequence == 1 { await gate.wait() }  // 只有第一件卡死觸發短路，之後正常返回。
				return text
			},
			timeout: .milliseconds(150),
			consecutiveTimeoutThreshold: 1,
			circuitOpenDuration: .milliseconds(500)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self) {
			try await pool.translate("一", from: english, to: hant)
		}
		let openRightAfter: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openRightAfter == true, "逾時後應立即短路")
		await #expect(throws: TranslationCircuitOpenError.self, "窗口內應仍短路") {
			try await pool.translate("窗口內", from: english, to: hant)
		}
		try await Task.sleep(for: .milliseconds(700))  // 等窗口（500ms）過期。
		let openAfterWindow: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterWindow == false, "窗口期滿後應視為未短路（下一件是復原探測）")
		let recovered: String = try await pool.translate("復原探測", from: english, to: hant)
		#expect(recovered == "復原探測", "探測本身應正常返回（第二件不再卡死）")
		let openAfterRecovery: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterRecovery == false, "探測成功應關閉短路")
		let followUp: String = try await pool.translate("後續一句", from: english, to: hant)
		#expect(followUp == "後續一句", "短路解除後應照常放行、不再快速失敗")
	}

	/// 真實錯誤（非逾時）不計進短路計數，即使連續發生也不會觸發短路——那不是「服務卡住」的訊號。
	@Test
	private func `real errors do not trip the circuit`() async {
		struct SampleFailure: Error {}
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, _ in throw SampleFailure() },
			timeout: .seconds(30),
			consecutiveTimeoutThreshold: 2,
			circuitOpenDuration: .seconds(60)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		for index in 0..<5 {
			await #expect(throws: SampleFailure.self, "第 \(index) 次應原樣拋出真實錯誤") {
				try await pool.translate("句 \(index)", from: english, to: hant)
			}
		}
		let isOpen: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(isOpen == false, "連續 5 次真實錯誤（遠超門檻 2）仍不應短路")
	}

	/// 呼叫端取消不計進短路計數：取消一次不觸發短路，後續正常請求不受影響。
	@Test
	private func `caller cancellation does not trip the circuit`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				let sequence: Int = ledger.enter()
				if sequence == 1 { await gate.wait() }
				return text
			},
			timeout: .seconds(10),
			consecutiveTimeoutThreshold: 1,
			circuitOpenDuration: .seconds(60)
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
		await #expect(throws: CancellationError.self) {
			try await inFlight.value
		}
		let isOpen: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(isOpen == false, "取消不應觸發短路（門檻為 1，若誤計數這裡會是 true）")
		let recovered: String = try await pool.translate("後續的一句", from: english, to: hant)
		#expect(recovered == "後續的一句", "短路未觸發，後續請求應照常完成")
	}

	/// 預查側短路**只關掉預查、不擋翻譯**（見 `TranslationSessionPool` 型別說明末段）：
	/// `AppleTranslationEngine.status` 連續逾時達 `TranslationSessionPool.shared` 的 production
	/// 門檻後，後續查詢應直接短路、不再送出真查；而同語言對的 `translate` 側短路必須維持關閉。
	///
	/// 這條是行為回歸的守門員。兩側若共用一顆計數，預查端持續卡住時會這樣走：呼叫端一律先
	/// `status` 後 `translate`，所以窗口期滿後第一個到的必是 `status`，它再逾時一次就把窗口
	/// 重新起算，如此循環——健康的 `translate` 一次探測機會都拿不到，該語言對永久停用，而
	/// 使用者收到的錯誤還寫著「稍後恢復」。把「預查逾時後 translate 側仍關閉」釘死，那條路徑
	/// 就長不回來。
	///
	/// 走 `.shared` 單例（`AppleTranslationEngine` 內部固定委派它、無法注入替身），故用私用區
	/// 語言碼＋四字母後綴（同既有慣例）避免與其他測試的語言對互相污染 `.shared` 的進程級狀態。
	/// 放行與否改以讀 `isCircuitOpen` 判定、不實際呼叫 `.shared.translate`——後者會落到真的
	/// `TranslationSession`，語義相同卻要依賴系統服務。
	@Test
	private func `availability timeouts trip only the availability circuit`() async throws {
		let source: Locale.Language = .init(identifier: "qaa-circ")
		let target: Locale.Language = .init(identifier: "qab-circ")
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				_ = ledger.enter()
				await gate.wait()
				return .installed
			},
			availabilityTimeout: .milliseconds(300)
		)
		// `TranslationSessionPool.shared` 未注入自訂門檻、走 production 預設 3。
		for index in 0..<3 {
			let status: LanguagePairStatus = await engine.status(from: source, to: target)
			#expect(status == .undetermined, "第 \(index) 次查詢應逾時而非查到結果")
		}
		#expect(ledger.enteredCount == 3, "門檻達成前三次都應真的送出查詢")
		let fourthStatus: LanguagePairStatus = await engine.status(from: source, to: target)
		#expect(fourthStatus == .undetermined, "預查側短路中仍回 undetermined（不擋路，只是不查）")
		#expect(ledger.enteredCount == 3, "預查側已短路，不應再送出第四次查詢")
		let translateSideOpen: Bool = await TranslationSessionPool.shared.isCircuitOpen(
			from: source,
			to: target
		)
		#expect(translateSideOpen == false, "預查側連續逾時不得讓 translate 側短路——兩顆各自獨立")
	}
}
