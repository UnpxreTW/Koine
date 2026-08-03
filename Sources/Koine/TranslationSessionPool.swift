//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation
import Translation

/// `TranslationSession` 的進程級複用池（每語言對一顆、actor 圈護＋門閂單線使用）。
///
/// 實測 session 建構約佔每句 50ms（複用約省 13%）；`TranslationSession` 非 Sendable、
/// 併發呼叫無官方安全保證，且 actor 在 `await` 期間可重入——故以 per 語言對門閂
/// （`busy` + `waiters`）保證同語言對同時只有一件**未被放棄的** translate 在跑
/// （逾時後被放棄的那一件仍可能在背景跑，但它握的是已被丟棄的舊 session，見下）。吞吐不受影響：
/// `translationd` 內部本就序列化（實測多路併發無吞吐增益）。
/// 譯出錯即丟棄該語言對的快取 session：語言包狀態可能已變（如剛下載完成），下次呼叫重建。
///
/// 另附帶一個輕量「已知已裝妥」快取（`installedPairs`），供 `AppleTranslationEngine.status`
/// 跳過重複的 `LanguageAvailability` 查詢——只快取正向結果，`translate` 失敗時一併失效，
/// 避免使用者事後才下載語言包卻仍被過期快取擋下。
///
/// 逾時保護：單件 translate 若永不返回（translationd 走跨程序往返、中斷通常以 error 收場，機率低），
/// 該語言對門閂本會永久持有、後續請求隊頭阻塞。故每件翻譯帶 `timeout` 等待上限——上限先到就
/// 放棄等待、視同該語言對 session 失效走既有丟棄路徑，門閂照常釋放，隊伍不因一件卡死而全滅。
public actor TranslationSessionPool {

	/// 進程共用單例（appex / CLI 同一進程內跨請求複用）。
	public static let shared = TranslationSessionPool()

	/// 語言對快取鍵。
	private struct PairKey: Hashable {

		/// 來源語言。
		let source: Locale.Language

		/// 目標語言。
		let target: Locale.Language
	}

	/// 逾時賽跑的勝方。
	private enum RaceOutcome: Sendable {

		/// 翻譯先結束（成功或拋錯皆算）。
		case settled

		/// 等待上限先到。
		case timedOut
	}

	/// 每語言對一顆的 session 快取。
	private var sessions: [PairKey: TranslationSession] = [:]

	/// 門閂：當前有 translate 進行中的語言對（actor 於 `await` 期間可重入，靠此擋同 session 併發）。
	private var busy: Set<PairKey> = []

	/// 門閂等候佇列（FIFO、per 語言對）。
	private var waiters: [PairKey: [CheckedContinuation<Void, Never>]] = [:]

	/// 語言對「已知已裝妥」快取。只記正向結果——`.supported` / `.unsupported` 不快取，
	/// 因為兩者之後都可能轉為已裝妥（使用者去系統設定下載語言包），沒有天然的失效訊號可跟隨。
	/// 反向（使用者事後移除已裝語言包）靠 `translate` 失敗時失效，見下方 `translate` 的 catch；
	/// 該失效發生前、同語言對已通過 `isKnownInstalled` 檢查的並發請求仍會照常送去 `translate`，
	/// 差別只是失敗時收到的是原始 framework 錯誤而非 `LanguagePairStatus.actionableMessage`
	/// 的可行動提示——下一次 `status` 查詢即會重新真查、非永久錯誤狀態。
	private var installedPairs: Set<PairKey> = []

	/// session 建構器（測試注入以觀測建構次數；預設走 macOS 26 standalone init）。
	private let factory: @Sendable (Locale.Language, Locale.Language) -> TranslationSession

	/// 單件翻譯的實際執行封裝（測試注入以觀測同時執行中數／模擬失敗；預設走真 `session.translate`）。
	private let translateOperation: @Sendable (TranslationSession, String) async throws -> String

	/// 單件翻譯的等待上限（見型別說明的逾時保護段）。
	///
	/// 預設 30 秒刻意寬鬆：本上限要擋的是「永不返回」的隊頭阻塞、不是延遲 SLA，
	/// 而首件翻譯要付語言模型冷啟成本、抓太緊會把正常的慢請求誤判成逾時（使用者端表現為整頁漏譯）。
	private let timeout: Duration

	/// 注入 session 建構器、翻譯執行封裝與等待上限；預設 `TranslationSession(installedSource:target:)`
	/// 加真 `session.translate`——前兩者僅供測試觀測，production 呼叫端不帶參數；
	/// `timeout` 則是 production 行為參數，測試另以短上限注入以免拖長測試。
	public init(
		factory: @escaping @Sendable (Locale.Language, Locale.Language) -> TranslationSession = {
			TranslationSession(installedSource: $0, target: $1)
		},
		translateOperation: @escaping @Sendable (TranslationSession, String) async throws -> String = {
			try await $0.translate($1).targetText
		},
		timeout: Duration = .seconds(30)
	) {
		self.factory = factory
		self.translateOperation = translateOperation
		self.timeout = timeout
	}

	/// 取回或建構該語言對的快取 session（測試觀測複用命中的鉤子）。
	/// 注意這不是效能暖機：同步建構實測僅 ~0.2ms，session 成本 lazy 到首次 translate 才付。
	public func ensureSession(from source: Locale.Language, to target: Locale.Language) {
		_ = session(for: PairKey(source: source, target: target))
	}

	/// 該語言對是否已知已裝妥（跳過 `LanguageAvailability` 重查的依據）。
	public func isKnownInstalled(from source: Locale.Language, to target: Locale.Language) -> Bool {
		installedPairs.contains(PairKey(source: source, target: target))
	}

	/// 記下該語言對已確認就緒；下次 `status` 查詢可直接回 `.installed`、不再真查。
	public func markInstalled(from source: Locale.Language, to target: Locale.Language) {
		installedPairs.insert(PairKey(source: source, target: target))
	}

	/// 以複用 session 翻譯一句；失敗（含逾時）時先丟棄該語言對快取（語言包狀態可能已變）再拋出。
	/// 同語言對序列化執行（先取門閂再取 session：前一件失效重建後、下一件拿到的是新 session）。
	public func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		let key = PairKey(source: source, target: target)
		await acquire(key)
		let session = session(for: key)
		do {
			let translated: String = try await translateWithTimeout(using: session, text: text)
			release(key)
			return translated
		} catch {
			// !!!: 丟棄 session 必須發生在 `release` 之前，且兩者之間不得插入 `await`——逾時後
			// 被放棄的那一件仍握著這顆 session 在跑，先清快取，下一位等候者才會拿到新建的另一顆。
			// 順序顛倒或中間讓出 actor，同一顆非 Sendable 的 session 就會被兩件 translate 併發使用，
			// 正是門閂要擋的事，且不會有任何編譯錯誤或測試變紅。
			sessions[key] = nil
			// 逾時＝放棄等待、不是「語言包不見了」的證據，故不動已裝妥快取：清掉會讓下一件重新真查
			// `LanguageAvailability`，服務降級時該查詢回 `.supported`，使用者就收到「請去下載語言包」
			// ——而那個語言包明明已經裝好。真失敗才是語言包狀態可能已變的證據。
			if !(error is TranslationTimeoutError) {
				installedPairs.remove(key)
			}
			release(key)
			throw error
		}
	}

	/// 以 `timeout` 為上限執行單件翻譯；上限先到就放棄等待、拋 `TranslationTimeoutError`。
	///
	/// !!!: 這裡刻意用**非結構化** `Task` 賽跑，而不是 task group——task group 保證 body 返回前
	/// 所有子任務都已結束，而本保護要解的正是「translate 卡在不可取消的等待」：那種情況下子任務
	/// 永不結束、group 也就永不返回，門閂照樣永久持有＝逾時形同不存在。只有非結構化 Task 能
	/// 「不等它、直接走人」。逾時仍呼叫 `cancel()` 盡力回收（操作若可取消便會即時收工），
	/// 但**不以它真的結束為前提**——被放棄的那一件即使日後跑完，結果也無人接收。
	/// 放棄後的安全性靠 `translate` catch 區塊的丟棄順序維持，見該處 `!!!:`。
	private func translateWithTimeout(using session: TranslationSession, text: String) async throws -> String {
		let operation: @Sendable (TranslationSession, String) async throws -> String = translateOperation
		let limit: Duration = timeout
		let outcomes: AsyncStream<RaceOutcome>
		let continuation: AsyncStream<RaceOutcome>.Continuation
		(outcomes, continuation) = AsyncStream<RaceOutcome>.makeStream()
		let work: Task<String, any Error> = Task {
			defer { continuation.yield(.settled) }
			return try await operation(session, text)
		}
		let timer: Task<Void, Never> = Task {
			// 只有真的睡滿才算逾時：`.settled` 路徑會 cancel 本 task，此時不該再 yield
			// （目前沒人讀、無害，但別讓正確性建立在「剛好沒人讀」上）。
			guard (try? await Task.sleep(for: limit)) != nil else { return }
			continuation.yield(.timedOut)
		}
		defer { timer.cancel() }
		var outcomeIterator: AsyncStream<RaceOutcome>.Iterator = outcomes.makeAsyncIterator()
		// 串流在本 task 被取消時直接結束（回 nil）——此時同樣不等被放棄的那一件。
		guard let outcome: RaceOutcome = await outcomeIterator.next() else {
			work.cancel()
			throw CancellationError()
		}
		switch outcome {
		case .settled:
			return try await work.value
		case .timedOut:
			work.cancel()
			throw TranslationTimeoutError(limit: limit)
		}
	}

	/// 取得該語言對門閂；忙碌則 FIFO 排隊（`withCheckedContinuation` 閉包同步執行、
	/// 檢查與入列之間無懸掛點，不會漏喚醒）。
	private func acquire(_ key: PairKey) async {
		if !busy.contains(key) {
			busy.insert(key)
			return
		}
		await withCheckedContinuation { continuation in
			waiters[key, default: []].append(continuation)
		}
	}

	/// 釋放門閂：有等候者則喚醒下一位（門閂直接轉移、`busy` 不動）、否則清旗標。
	private func release(_ key: PairKey) {
		if var queue = waiters[key], !queue.isEmpty {
			let next = queue.removeFirst()
			waiters[key] = queue.isEmpty ? nil : queue
			next.resume()
		} else {
			busy.remove(key)
		}
	}

	/// 取快取 session、沒有就以 `factory` 建構入池。
	private func session(for key: PairKey) -> TranslationSession {
		if let cached = sessions[key] { return cached }
		let created = factory(key.source, key.target)
		sessions[key] = created
		return created
	}
}
