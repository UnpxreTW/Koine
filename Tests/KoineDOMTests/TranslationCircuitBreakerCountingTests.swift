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

// MARK: - TranslationCircuitBreakerCountingTests

/// 短路計數的**跨呼叫記帳語義**——同檔的 `TranslationCircuitBreakerTests` 驗的是「短路開了之後
/// 會怎樣」，本檔驗的是「什麼會讓計數前進、歸零、或原地不動」。三條各自對應一種只在多筆交錯
/// 序列下才現形的失效：探測又逾時卻沒重新短路、真實錯誤沒把已累積的計數清掉、呼叫端取消被
/// 誤當成一種訊號。單筆序列（每次都從零計數起跑）分辨不出這三者，故獨立成檔補上。
private final class TranslationCircuitBreakerCountingTests {

	/// 復原探測本身又逾時：短路必須**重新**起算一輪，而不是就此放行。
	///
	/// 釘住 `recordTimeout` 的達門檻比較是 `>=` 而非 `==`——探測逾時時計數已越過門檻（門檻 1、
	/// 此時為 2），寫成 `==` 會讓這一輪短路悄悄不成立，型別說明承諾的「探測本身仍逾時則重新計時、
	/// 再短路一輪」靜默失效：服務持續卡住時，每個窗口期滿都會放一批人進去白等滿 `timeout`。
	@Test
	private func `a probe that also times out reopens the circuit`() async throws {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				_ = ledger.enter()
				await gate.wait()  // 每一件都卡死——連復原探測也逾時，正是本測試要看的情形。
				return text
			},
			timeout: .milliseconds(150),
			consecutiveTimeoutThreshold: 1,
			circuitOpenDuration: .milliseconds(500)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self, "門檻為 1，第一件逾時即短路") {
			try await pool.translate("一", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 1)
		try await Task.sleep(for: .milliseconds(700))  // 等窗口（500ms）過期。
		let openAfterWindow: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterWindow == false, "窗口期滿後應視為未短路（下一件是復原探測）")
		await #expect(throws: TranslationTimeoutError.self, "探測應真的嘗試、並再次逾時") {
			try await pool.translate("復原探測", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 2, "探測必須真的進場，否則後面驗的不是探測結果")
		let openAfterProbe: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterProbe == true, "探測逾時應重新短路一輪，而不是就此放行")
		await #expect(throws: TranslationCircuitOpenError.self, "重新短路後應再次快速失敗") {
			try await pool.translate("探測之後", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 2, "重新短路後不應再呼叫 translateOperation")
	}

	/// 真實錯誤不只是「不累加」，還必須把**已累積的**連續逾時計數歸零——「連續」是門檻的語義核心。
	///
	/// 交錯序列（逾時 ×2 → 真實錯誤 → 逾時）在門檻 3 下不該短路：計數歸零後只重數到 1。
	/// 若真實錯誤僅止於不累加、計數留在 2，第四件逾時就會湊滿門檻而短路——而從零計數起跑的
	/// 序列無論哪種寫法都不短路，觀察不到這個差別。
	@Test
	private func `a real error clears the accumulated timeout count`() async throws {
		struct SampleFailure: Error {}
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, text in
				let sequence: Int = ledger.enter()
				if sequence == 3 { throw SampleFailure() }  // 只有第三件是真實錯誤，其餘卡死。
				await gate.wait()
				return text
			},
			timeout: .milliseconds(150),
			consecutiveTimeoutThreshold: 3,
			circuitOpenDuration: .seconds(30)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		for index in 0..<2 {
			await #expect(throws: TranslationTimeoutError.self, "第 \(index) 件逾時（計數累到 2、未達門檻 3）") {
				try await pool.translate("逾時 \(index)", from: english, to: hant)
			}
		}
		await #expect(throws: SampleFailure.self, "第三件是真實錯誤：服務有回應，計數應歸零") {
			try await pool.translate("真實錯誤", from: english, to: hant)
		}
		await #expect(throws: TranslationTimeoutError.self, "第四件應照常嘗試並逾時（計數自 0 重數、為 1）") {
			try await pool.translate("再逾時", from: english, to: hant)
		}
		#expect(ledger.enteredCount == 4, "四件都該真的進場——沒有任何一件應被短路擋下")
		let isOpen: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(isOpen == false, "累計 3 次逾時但不連續，不應短路（計數未歸零時這裡會是 true）")
	}

	/// 呼叫端取消對計數**兩面都不動**：不累加（同檔另一條已釘住不累加的那一半），也不歸零。
	///
	/// 序列＝逾時 → 取消 → 逾時，門檻 2 下第二次逾時就該湊滿而短路。若取消被當成「有回應」
	/// 而清掉計數，第二次逾時只算到 1、不短路——關分頁這種與服務死活無關的使用者行為，
	/// 就成了讓短路永遠追不上的免死金牌。
	@Test
	private func `cancellation neither clears nor advances the timeout count`() async throws {
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
			timeout: .milliseconds(500),
			consecutiveTimeoutThreshold: 2,
			circuitOpenDuration: .seconds(30)
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await #expect(throws: TranslationTimeoutError.self, "第一件逾時（計數 1、未達門檻 2）") {
			try await pool.translate("一", from: english, to: hant)
		}
		let inFlight: Task<String, any Error> = Task {
			try await pool.translate("被取消的一句", from: english, to: hant)
		}
		var spins: Int = 0
		while ledger.enteredCount < 2, spins < 10_000 {
			await Task.yield()
			spins += 1
		}
		#expect(ledger.enteredCount == 2, "第二件應已進場，取消才打得到等待中的那一件")
		inFlight.cancel()
		await #expect(throws: CancellationError.self) {
			try await inFlight.value
		}
		let openAfterCancel: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterCancel == false, "取消不累加：計數仍為 1、未達門檻 2")
		await #expect(throws: TranslationTimeoutError.self, "第三件應照常嘗試並逾時（計數 1 → 2）") {
			try await pool.translate("二", from: english, to: hant)
		}
		let openAfterSecondTimeout: Bool = await pool.isCircuitOpen(from: english, to: hant)
		#expect(openAfterSecondTimeout == true, "取消不歸零：兩次逾時仍算連續、應湊滿門檻 2 而短路")
	}
}
