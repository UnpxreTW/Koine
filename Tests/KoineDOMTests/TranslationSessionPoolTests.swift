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

// MARK: - ConstructionCounter

/// 執行緒安全的建構次數計數器（factory 是 `@Sendable` 同步閉包、不能進 actor，故用鎖）。
private final class ConstructionCounter: @unchecked Sendable {

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
	private var value = 0
}

// MARK: - TranslationSessionPoolTests

/// `TranslationSessionPool` 複用邏輯跑道：注入計數 factory 觀測建構次數。
/// 多數測試只建構 session、不碰真 `translationd`；唯 `error invalidates cached session`
/// 與 `translate failure invalidates installed cache` 兩者例外——皆靠真 `translationd`
/// 對未安裝語言對快速拋錯來驗失效重建路徑。
private final class TranslationSessionPoolTests {

	/// 同語言對重複取用：只建構一次（複用命中）。
	@Test
	private func `same pair constructs once`() async {
		let counter: ConstructionCounter = .init()
		let pool = TranslationSessionPool { source, target in
			counter.increment()
			return TranslationSession(installedSource: source, target: target)
		}
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		await pool.ensureSession(from: english, to: hant)
		await pool.ensureSession(from: english, to: hant)
		#expect(counter.count == 1, "同語言對第二次取用應命中快取、不重建")
	}

	/// 不同語言對各自建構、互不混用。
	@Test
	private func `distinct pairs construct separately`() async {
		let counter: ConstructionCounter = .init()
		let pool = TranslationSessionPool { source, target in
			counter.increment()
			return TranslationSession(installedSource: source, target: target)
		}
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		let japanese = Locale.Language(identifier: "ja")
		await pool.ensureSession(from: english, to: hant)
		await pool.ensureSession(from: english, to: japanese)
		await pool.ensureSession(from: english, to: hant)
		#expect(counter.count == 2, "兩個語言對各建一顆、重複取用不再建")
	}

	/// 譯出錯即失效：先證明 translate 吃快取（不自建）、出錯後才重建（計數 1 → 1 → 2）。
	/// 用未安裝的語言對讓 `translationd` 快速拋錯——standalone init 路徑不彈 UI、不需語言包。
	@Test
	private func `error invalidates cached session`() async {
		let counter: ConstructionCounter = .init()
		let pool = TranslationSessionPool { source, target in
			counter.increment()
			return TranslationSession(installedSource: source, target: target)
		}
		let bogusSource = Locale.Language(identifier: "xx")
		let bogusTarget = Locale.Language(identifier: "yy")
		await pool.ensureSession(from: bogusSource, to: bogusTarget)
		#expect(counter.count == 1, "預建一顆入快取")
		await #expect(throws: (any Error).self, "未安裝語言對應拋錯") {
			try await pool.translate("hi", from: bogusSource, to: bogusTarget)
		}
		#expect(counter.count == 1, "第一次 translate 應複用快取、不得自建")
		await #expect(throws: (any Error).self) {
			try await pool.translate("hi", from: bogusSource, to: bogusTarget)
		}
		#expect(counter.count == 2, "出錯後快取應失效、下一件重建而非複用壞 session")
	}

	/// 方向性：A→B 與 B→A 是不同語言對、各自建構。
	@Test
	private func `reversed pair constructs separately`() async {
		let counter: ConstructionCounter = .init()
		let pool = TranslationSessionPool { source, target in
			counter.increment()
			return TranslationSession(installedSource: source, target: target)
		}
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		await pool.ensureSession(from: english, to: hant)
		await pool.ensureSession(from: hant, to: english)
		#expect(counter.count == 2, "方向相反屬不同語言對")
	}

	/// 未標記過的語言對不視為已知已裝妥（`AppleTranslationEngine.status` 首次查詢應真查）。
	@Test
	private func `unknown pair is not known installed`() async {
		let pool = TranslationSessionPool()
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		let isKnown = await pool.isKnownInstalled(from: english, to: hant)
		#expect(isKnown == false)
	}

	/// 標記後同語言對回報已知已裝妥（供 `status` 跳過重查）。
	@Test
	private func `marked pair is known installed`() async {
		let pool = TranslationSessionPool()
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		await pool.markInstalled(from: english, to: hant)
		let isKnown = await pool.isKnownInstalled(from: english, to: hant)
		#expect(isKnown == true)
	}

	/// 已知已裝妥快取以語言對為 key、彼此不污染。
	@Test
	private func `installed cache is scoped per pair`() async {
		let pool = TranslationSessionPool()
		let english = Locale.Language(identifier: "en")
		let hant = Locale.Language(identifier: "zh-Hant")
		let japanese = Locale.Language(identifier: "ja")
		await pool.markInstalled(from: english, to: hant)
		let otherKnown = await pool.isKnownInstalled(from: english, to: japanese)
		#expect(otherKnown == false, "標記 en→zh-Hant 不應影響 en→ja")
	}

	/// translate 失敗時一併清掉已知已裝妥快取，強迫下次 `status` 查詢重新真查
	/// （語言包狀態可能已變，同 session 快取的失效原則）。
	@Test
	private func `translate failure invalidates installed cache`() async {
		let pool = TranslationSessionPool { source, target in
			TranslationSession(installedSource: source, target: target)
		}
		let bogusSource = Locale.Language(identifier: "xx")
		let bogusTarget = Locale.Language(identifier: "yy")
		await pool.markInstalled(from: bogusSource, to: bogusTarget)
		let markedKnown = await pool.isKnownInstalled(from: bogusSource, to: bogusTarget)
		#expect(markedKnown == true, "標記後應回報已知已裝妥")
		await #expect(throws: (any Error).self, "未安裝語言對應拋錯") {
			try await pool.translate("hi", from: bogusSource, to: bogusTarget)
		}
		let stillKnown = await pool.isKnownInstalled(from: bogusSource, to: bogusTarget)
		#expect(stillKnown == false, "出錯後應清掉已知已裝妥快取、強迫下次重查")
	}

	/// 同上規則、但**不碰真 `translationd`**：注入直接拋錯的樁，單獨釘住「真實錯誤會讓已知已裝妥
	/// 快取失效」。上一條靠未安裝語言對讓框架自己報錯，好處是連「框架真的會報錯」這個假設一併驗到，
	/// 代價是紅綠取決於執行環境；兩條並存才是既驗規則、又驗環境假設。缺了本條，失效那一臂在純樁
	/// 層面無人看守——`translate` catch 裡的 `installedPairs.remove` 被刪掉時，只剩環境相依的上一條會紅。
	@Test
	private func `a real error invalidates the installed cache without the framework`() async {
		struct SampleFailure: Error {}
		let pool: TranslationSessionPool = .init(
			factory: { source, target in TranslationSession(installedSource: source, target: target) },
			translateOperation: { _, _ in throw SampleFailure() }
		)
		let english: Locale.Language = .init(identifier: "en")
		let hant: Locale.Language = .init(identifier: "zh-Hant")
		await pool.markInstalled(from: english, to: hant)
		let markedKnown: Bool = await pool.isKnownInstalled(from: english, to: hant)
		#expect(markedKnown == true, "標記後應回報已知已裝妥——沒有這行就只觀測到 false 那端")
		await #expect(throws: SampleFailure.self, "樁應原樣拋出真實錯誤") {
			try await pool.translate("一", from: english, to: hant)
		}
		let stillKnown: Bool = await pool.isKnownInstalled(from: english, to: hant)
		#expect(stillKnown == false, "真實錯誤是語言包狀態可能已變的證據、已裝妥快取應失效")
	}
}
