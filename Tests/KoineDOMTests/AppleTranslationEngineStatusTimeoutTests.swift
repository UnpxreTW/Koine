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

// MARK: - QueryCounter

/// 執行緒安全的查詢計數器（注入的可用性查詢是 `@Sendable` 閉包、不能進 actor，故用鎖）。
private final class QueryCounter: @unchecked Sendable {

	/// 已進場的查詢次數。
	var count: Int {
		lock.lock()
		defer { lock.unlock() }
		return calls
	}

	/// 記一次查詢進場。
	func increment() {
		lock.lock()
		defer { lock.unlock() }
		calls += 1
	}

	/// 保護以下計數的鎖。
	private let lock: NSLock = .init()

	/// 累計進場次數。
	private var calls: Int = 0
}

// MARK: - AppleTranslationEngineStatusTimeoutTests

/// `AppleTranslationEngine.status` 的逾時保護：可用性預查與 `translate` 走同一條跨程序往返、
/// 同樣可能永不返回，而它**排在每一段翻譯之前**——卡住就是整頁停在預查，連 `translate` 那層
/// 已有的上限都到不了。
///
/// 首條測試在保護層被拿掉時會**掛住而不是失敗**（樁不理會取消），與 `TranslationSessionPool`
/// 的逾時測試同型，也同樣靠 CI test job 的 `timeout-minutes` 收場。
///
/// 語言碼一律取 ISO 639-2 私用區（`qaa`–`qtz`）且逐條測試互不重複：`status` 的正向結果會寫進
/// **進程級**的 `TranslationSessionPool.shared`，共用語言對會讓測試之間互相汙染。
/// ⚠ 後綴一律**四個字母**（`-hang`／`-pass`／`-keep`／`-stop`）：`Locale.Language` 把四字母子標籤
/// 當書寫系統保留（`qaa-hang` → `qaa-Hang`），五字母的當 variant **直接丟掉**（`qaa-cache` → `qaa`），
/// 後者會讓兩對看似不同的語言碼實為同一顆鍵、隔離只是巧合成立。
private final class AppleTranslationEngineStatusTimeoutTests {

	/// 可用性查詢永不返回（且不理會取消）：預查在上限後以 `.undetermined` 收場、不無限等待。
	@Test
	private func `hung availability query settles as undetermined`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				await gate.wait()
				return .installed
			},
			availabilityTimeout: .milliseconds(500)
		)
		let status: LanguagePairStatus = await engine.status(
			from: .init(identifier: "qaa-hang"),
			to: .init(identifier: "qab-hang")
		)
		#expect(status == .undetermined, "卡死的預查應以「無從判定」收場、不無限等待")
	}

	/// `.undetermined` **不擋路**：`actionableMessage` 回 `nil`，呼叫端（一律「非 nil 才早退」）
	/// 照常往下走真正的翻譯。這是預查層的核心釘子——預查逾時若回出一句訊息，就等於憑一個
	/// 沒查到的答案否決一件翻譯得成的事，把優化升格成新的失敗閘門。
	/// 另兩種已知失敗照舊擋，文案以字面錨點釘住（不從實作推導期望值）。
	@Test
	private func `undetermined yields no message so it cannot block translation`() throws {
		#expect(
			LanguagePairStatus.undetermined.actionableMessage(from: "en", to: "zh-Hant") == nil,
			"查不出來不是失敗，不該產生阻擋用的訊息"
		)
		#expect(
			LanguagePairStatus.installed.actionableMessage(from: "en", to: "zh-Hant") == nil,
			"可直接翻譯時同樣不該有提示"
		)
		let supported: String = try #require(
			LanguagePairStatus.supported.actionableMessage(from: "en", to: "zh-Hant")
		)
		let unsupported: String = try #require(
			LanguagePairStatus.unsupported.actionableMessage(from: "en", to: "zh-Hant")
		)
		#expect(supported.contains("語言包未下載"), "已知失敗照舊給可行動指引")
		#expect(unsupported.contains("不支援的語言組合"), "已知失敗照舊給可行動指引")
	}

	/// 上限之內返回的查詢完全不受保護層影響：三種狀態一律原樣透傳、不誤判逾時。
	@Test
	private func `status within the limit passes through untouched`() async {
		let cases: [(LanguagePairStatus, String)] = [
			(.installed, "qaa-pass"),
			(.supported, "qab-pass"),
			(.unsupported, "qac-pass")
		]
		for (expected, identifier) in cases {
			let engine: AppleTranslationEngine = .init(
				availabilityQuery: { _, _ in expected },
				availabilityTimeout: .seconds(30)
			)
			let actual: LanguagePairStatus = await engine.status(
				from: .init(identifier: identifier),
				to: .init(identifier: "qad-pass")
			)
			#expect(actual == expected, "上限之內返回的狀態應原樣透傳：\(identifier)")
		}
	}

	/// 逾時不進「已知已裝妥」快取，已裝妥則照舊進——服務恢復後下一次查詢必須真的重查，
	/// 不因一次逾時被永久釘在無從判定；而既有的跳過重查路徑也不因保護層而失效。
	@Test
	private func `undetermined is not cached while installed still is`() async {
		let installedCounter: QueryCounter = .init()
		let installedEngine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				installedCounter.increment()
				return .installed
			},
			availabilityTimeout: .seconds(30)
		)
		let installedSource: Locale.Language = .init(identifier: "qaa-keep")
		let installedTarget: Locale.Language = .init(identifier: "qab-keep")
		_ = await installedEngine.status(from: installedSource, to: installedTarget)
		_ = await installedEngine.status(from: installedSource, to: installedTarget)
		#expect(installedCounter.count == 1, "已裝妥的正向結果進池快取、第二次不再真查")
		let gate: HangGate = .init()
		defer { gate.release() }
		let hungCounter: QueryCounter = .init()
		let hungEngine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				hungCounter.increment()
				await gate.wait()
				return .installed
			},
			availabilityTimeout: .milliseconds(300)
		)
		let hungSource: Locale.Language = .init(identifier: "qac-keep")
		let hungTarget: Locale.Language = .init(identifier: "qad-keep")
		let first: LanguagePairStatus = await hungEngine.status(from: hungSource, to: hungTarget)
		let second: LanguagePairStatus = await hungEngine.status(from: hungSource, to: hungTarget)
		#expect(first == .undetermined, "第一次逾時")
		#expect(second == .undetermined, "第二次仍逾時（服務還沒恢復）")
		#expect(hungCounter.count == 2, "逾時不入快取：每次都必須重新真查")
	}

	/// 呼叫端 task 在預查途中被取消：該次查詢即刻收場（而非拖到上限），結果同樣是「無從判定」。
	/// 這是保護層唯一靠串流取消語義（iterator 回 nil）撐住的分支，特別釘成回歸測試——
	/// 把 `guard let outcome` 改寫成別的取值形狀時，只有這條會紅（或掛住：例如 nil 分支改成
	/// 直接 `await work.value`，那是等一個永不結束的 task，同本 suite 首條的失敗形態）。
	///
	/// 上限設 10 秒、斷言收在 5 秒內：判別靠時間差而非錯誤型別（`status` 依協定不 throws，
	/// 取消與逾時收在同一個值上，型別分不出來）。**「必然轉紅」的依據是保護層內建的 `timer`**：
	/// 它是非結構化 `Task`、不繼承呼叫端的取消，故取消偵測若失效，卡死的查詢雖永不 yield
	/// `.settled`，`timer` 仍會睡滿 10 秒 yield `.timedOut`——時間超出斷言而紅，不會靜靜掛住。
	@Test
	private func `cancelling the caller does not wait out the limit`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let entries: QueryCounter = .init()
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				entries.increment()
				await gate.wait()
				return .installed
			},
			availabilityTimeout: .seconds(10)
		)
		let inFlight: Task<LanguagePairStatus, Never> = Task {
			await engine.status(from: .init(identifier: "qaa-stop"), to: .init(identifier: "qab-stop"))
		}
		var spins: Int = 0
		while entries.count < 1, spins < 10_000 {
			await Task.yield()
			spins += 1
		}
		#expect(entries.count == 1, "樁應已進場，取消才打得到等待中的那一次查詢")
		let clock: ContinuousClock = .init()
		let start: ContinuousClock.Instant = clock.now
		inFlight.cancel()
		let status: LanguagePairStatus = await inFlight.value
		let elapsed: Duration = clock.now - start
		#expect(status == .undetermined, "取消同樣以「無從判定」收場")
		#expect(elapsed < .seconds(5), "取消應即刻收場、不拖到 10 秒上限（實測 \(elapsed)）")
	}
}
