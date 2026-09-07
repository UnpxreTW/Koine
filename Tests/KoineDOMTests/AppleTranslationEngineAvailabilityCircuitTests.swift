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

// MARK: - AppleTranslationEngineAvailabilityCircuitTests

/// 可用性預查那顆短路的記帳語義：什麼會讓計數前進、什麼讓它歸零、短路開著時誰不受影響。
///
/// 既有的 `AppleTranslationEngineStatusTimeoutTests` 驗的是單次逾時怎麼收場，本檔驗的是**跨呼叫**
/// 那一層——預查側的計數與 `translate` 側各自獨立，兩者接錯或共用一顆時，單筆序列一律看不出來。
///
/// - Warning: 三條測試都與 `TranslationSessionPool.shared` 的預設短路門檻（3）耦合，且短路狀態是
///   **進程級**的。門檻若改動，要修的是這裡的預期次數、不是把保護關掉。
///
/// 語言碼取 ISO 639-2 私用區（`qaa`–`qtz`）、逐條測試互不重複，且後綴一律**四個字母**——理由同
/// `AppleTranslationEngineStatusTimeoutTests`（五字母子標籤會被 `Locale.Language` 當 variant 丟掉，
/// 兩對看似不同的語言碼實為同一顆鍵）。
private final class AppleTranslationEngineAvailabilityCircuitTests {

	/// 連續逾時達門檻後，預查不再送出注定和前幾次同命運的查詢，直接以「無從判定」收場。
	///
	/// 短路檢查若被拿掉，第四次仍會真的進場查詢、進場計數變 4 而轉紅；服務持續卡住時，
	/// 那正是每一段翻譯前都白等滿一次上限、資源隨頁面長度線性累積的情形。
	@Test
	private func `availability circuit stops sending doomed queries`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				_ = ledger.enter()
				await gate.wait()
				return .supported
			},
			availabilityTimeout: .milliseconds(200)
		)
		let source: Locale.Language = .init(identifier: "qaa-shut")
		let target: Locale.Language = .init(identifier: "qab-shut")
		for _ in 1...3 {
			let status: LanguagePairStatus = await engine.status(from: source, to: target)
			#expect(status == .undetermined, "卡死的預查一律以「無從判定」收場")
		}
		#expect(ledger.enteredCount == 3, "達門檻之前每次都必須真的送出查詢")
		let afterThreshold: LanguagePairStatus = await engine.status(from: source, to: target)
		#expect(afterThreshold == .undetermined, "短路中回的仍是「無從判定」、不是另一種失敗")
		#expect(ledger.enteredCount == 3, "短路中不得再送出查詢")
	}

	/// 預查側短路開著時，`translate` 那顆短路仍是關的、「已知已裝妥」快取也不被動到。
	///
	/// 這條分離是必要的：兩側共用一顆計數時，預查持續卡住而翻譯本身正常的情況下，健康的
	/// `translate` 一次機會都拿不到——呼叫端都是先預查後翻譯，窗口期滿後第一個到的是預查，
	/// 它再逾時一次就把窗口重新起算，該語言對等於永久停用。
	@Test
	private func `an open availability circuit leaves translation untouched`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				_ = ledger.enter()
				await gate.wait()
				return .supported
			},
			availabilityTimeout: .milliseconds(200)
		)
		let source: Locale.Language = .init(identifier: "qaa-open")
		let target: Locale.Language = .init(identifier: "qab-open")
		for _ in 1...4 {
			_ = await engine.status(from: source, to: target)
		}
		#expect(ledger.enteredCount == 3, "第四次已被預查側短路擋下＝短路確實開著")
		let translateCircuitOpen: Bool = await TranslationSessionPool.shared.isCircuitOpen(
			from: source,
			to: target
		)
		#expect(translateCircuitOpen == false, "預查再怎麼逾時都不得關掉翻譯那條路")
		let knownInstalled: Bool = await TranslationSessionPool.shared.isKnownInstalled(
			from: source,
			to: target
		)
		#expect(knownInstalled == false, "逾時與短路都不是「已裝妥」的證據，正向快取不得被寫進去")
	}

	/// 中途有回應即把預查側的連續逾時計數歸零：不連續的逾時不得累加成短路。
	///
	/// 第三次查詢在上限內回話，其後要再連續三次逾時才短路，故六次呼叫每一次都真的進場。
	/// 歸零若記到了 `translate` 那份狀態上，預查側的計數再也不歸零、第四次就短路，
	/// 進場計數停在 4 而轉紅——只有多筆交錯的序列分辨得出這一型。
	@Test
	private func `a replying query resets the availability timeout count`() async {
		let gate: HangGate = .init()
		defer { gate.release() }
		let ledger: CircuitLedger = .init()
		let engine: AppleTranslationEngine = .init(
			availabilityQuery: { _, _ in
				let entry: Int = ledger.enter()
				if entry == 3 { return .supported }
				await gate.wait()
				return .supported
			},
			availabilityTimeout: .milliseconds(200)
		)
		let source: Locale.Language = .init(identifier: "qaa-zero")
		let target: Locale.Language = .init(identifier: "qab-zero")
		for _ in 1...6 {
			_ = await engine.status(from: source, to: target)
		}
		#expect(ledger.enteredCount == 6, "有回應那次把計數歸零，其後三次逾時才重新達門檻")
		_ = await engine.status(from: source, to: target)
		#expect(ledger.enteredCount == 6, "重新達門檻後照樣短路，計數不再前進")
	}
}
