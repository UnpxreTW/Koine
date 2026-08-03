//
//  Koine
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Functional Source License 1.1. See LICENSE for details.
//
//  SPDX-License-Identifier: FSL-1.1-ALv2

import Foundation
import Translation

/// Apple Translation Framework 實作（基礎層、v1）。
///
/// 走 macOS 26 standalone init `TranslationSession(installedSource:target:)`，無 SwiftUI
/// lifecycle 依賴——純 async，命令列環境可直接呼叫。
///
/// 前提：來源 / 目標語言包須先於「系統設定 → 一般 → 語言與地區 → 翻譯語言」下載；
/// 參數名 `installedSource` 即要求語言包已安裝，未裝會 throw、不會自動 prompt 下載。
/// 呼叫端可先以 `status(from:to:)` 預查、把失敗轉成可行動的提示。
///
/// `Sendable` 顯式宣告：本型別只存 `@Sendable` 閉包與 `Duration`，但 public 型別不會自動推導出
/// 該符合性，而把預查放進 `Task`（可取消的逐段預查是可預見的用法，今天只有測試這樣用）就需要它。
/// 符合性由編譯器檢查、非 `@unchecked`：日後加進非 Sendable 的 stored property 會當場編不過。
/// ⚠ `TranslationEngine` 協定本身仍非 `Sendable`，`any TranslationEngine` 不會跟著取得該保證。
public struct AppleTranslationEngine: TranslationEngine, Sendable {

	/// 逾時賽跑的勝方。
	private enum RaceOutcome: Sendable {

		/// 可用性查詢先結束。
		case settled

		/// 等待上限先到。
		case timedOut
	}

	/// 可用性查詢實作（測試注入以模擬卡死；預設走真 `LanguageAvailability`）。
	private let availabilityQuery: @Sendable (Locale.Language, Locale.Language) async -> LanguagePairStatus

	/// 可用性預查的等待上限（見 `status` 的逾時保護段）。
	///
	/// 因為逾時**不擋路**，兩側代價不對稱、而且與 `TranslationSessionPool` 的 30 秒方向相反：
	/// 上限太緊只是少一次精確指引（照樣往下走翻譯，代價幾乎為零）；上限太鬆則是服務降級時
	/// 每段都得白等滿上限才去翻譯——`.undetermined` 刻意不進快取（見 `status`），所以每段各付
	/// 一次、整頁乘上去。故取值偏緊，5 秒是留給冷啟的餘裕、不是給慢查詢的寬限。
	private let availabilityTimeout: Duration

	/// 注入可用性查詢與其等待上限；預設走真 `LanguageAvailability` 加 5 秒上限
	/// （前者僅供測試模擬卡死，production 呼叫端不帶參數；後者是 production 行為參數）。
	public init(
		availabilityQuery: @escaping @Sendable (Locale.Language, Locale.Language) async -> LanguagePairStatus = {
			switch await LanguageAvailability().status(from: $0, to: $1) {
			case .installed: .installed
			case .supported: .supported
			case .unsupported: .unsupported
			@unknown default: .unsupported
			}
		},
		availabilityTimeout: Duration = .seconds(5)
	) {
		self.availabilityQuery = availabilityQuery
		self.availabilityTimeout = availabilityTimeout
	}

	/// 預查語言組合可用性（standalone init 並非 throws、錯誤會延後到 `translate` 才爆，
	/// 預查讓呼叫端能 fail fast 並給出準確指引）。
	///
	/// 每段翻譯前都會呼叫本方法；同頁 from/to 固定時逐段重查 `LanguageAvailability` 是冗餘的
	/// 跨程序往返，故先問 `TranslationSessionPool` 該語言對是否已知已裝妥、命中就跳過真查。
	/// 只快取正向結果——`.supported` / `.unsupported` 不快取，見 `TranslationSessionPool` 上的說明；
	/// `.undetermined` 同樣不快取，服務恢復後下一次查詢就該真的重查、不被一次逾時永久釘死。
	///
	/// 逾時保護：`LanguageAvailability` 走的是與 `translate` 同一條跨程序往返，同樣可能永不返回，
	/// 而本方法**排在每一段翻譯之前**——它卡住，整頁就停在預查、連 `translate` 那層已有的上限
	/// 都到不了。故查詢帶等待上限，上限先到就放棄等待、回 `.undetermined`。
	///
	/// `.undetermined` **不擋路**（`actionableMessage` 對它回 `nil`）：呼叫端照常往下走真正的
	/// 翻譯，由那層的上限與真實錯誤收場。預查是把常見失敗換成可行動訊息的優化，逾時把它降級成
	/// 「這次沒幫上忙」即可，不該讓它反過來否決一件翻譯得成的事。
	public func status(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus {
		if await TranslationSessionPool.shared.isKnownInstalled(from: source, to: target) {
			return .installed
		}
		let result: LanguagePairStatus = await queryWithTimeout(from: source, to: target)
		if case .installed = result {
			await TranslationSessionPool.shared.markInstalled(from: source, to: target)
		}
		return result
	}

	/// 以 `availabilityTimeout` 為上限跑可用性查詢；上限先到就放棄等待、回 `.undetermined`。
	///
	/// !!!: 與 `TranslationSessionPool.translateWithTimeout` 是同一套非結構化 `Task` 賽跑，
	/// **刻意各留一份而非抽共用工具**：那邊的操作閉包捕捉非 Sendable 的 `TranslationSession`，
	/// 靠 `Task` 繼承 actor 隔離才合法，抽成收 `@Sendable` 閉包的泛型工具當場編不過。
	/// 兩處同樣不能改用 task group——group 保證 body 返回前子任務全數結束，而本保護要解的正是
	/// 「查詢卡在不可取消的等待」：那種情況下子任務永不結束、group 跟著永不返回，上限形同不存在。
	private func queryWithTimeout(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus {
		let query: @Sendable (Locale.Language, Locale.Language) async -> LanguagePairStatus = availabilityQuery
		let limit: Duration = availabilityTimeout
		let outcomes: AsyncStream<RaceOutcome>
		let continuation: AsyncStream<RaceOutcome>.Continuation
		(outcomes, continuation) = AsyncStream<RaceOutcome>.makeStream()
		let work: Task<LanguagePairStatus, Never> = Task {
			defer { continuation.yield(.settled) }
			return await query(source, target)
		}
		let timer: Task<Void, Never> = Task {
			// 只有真的睡滿才算逾時：`.settled` 路徑會 cancel 本 task，此時不該再 yield。
			guard (try? await Task.sleep(for: limit)) != nil else { return }
			continuation.yield(.timedOut)
		}
		defer { timer.cancel() }
		var outcomeIterator: AsyncStream<RaceOutcome>.Iterator = outcomes.makeAsyncIterator()
		// 串流在本 task 被取消時直接結束（回 nil）——呼叫端已不要答案，同樣不等被放棄的那一件。
		// 本方法不 throws（協定簽章如此），故取消與逾時收在同一個「無從判定」的值上；兩者對呼叫端
		// 的意思一致（預查沒給出結論），而 `.undetermined` 不擋路，取消的那條路徑也不會誤導使用者。
		guard let outcome: RaceOutcome = await outcomeIterator.next() else {
			work.cancel()
			return .undetermined
		}
		switch outcome {
		case .settled:
			return await work.value
		case .timedOut:
			work.cancel()
			return .undetermined
		}
	}

	/// 本機 Apple Translation 支援的語言代碼（BCP-47 `minimalIdentifier`、去重後字典序）。
	///
	/// 供可發現性用途（CLI 列表、shell 補全），**不是翻譯前的前提檢查**——「支援」只代表
	/// Apple 認得這個語言，語言包裝了沒仍由 `status(from:to:)` 判定。兩者混用會把
	/// 「支援但未下載」誤讀成可直接翻譯。
	///
	/// 回傳 `minimalIdentifier` 而非 `maximalIdentifier`：前者（`ja`、`zh-TW`、`en-GB`）是
	/// 呼叫端能原樣填回 `--from` / `--to` 的形式，後者（`ja-Jpan-JP`）補全了書寫系統與地區、
	/// 讀起來像另一組代碼。排序固定讓輸出可 diff、可比 golden。
	public func supportedLanguages() async -> [String] {
		let identifiers = await LanguageAvailability().supportedLanguages.map(\.minimalIdentifier)
		return Set(identifiers).sorted()
	}

	/// 委派進程級 `TranslationSessionPool` 以複用 session（每句重建實測多耗約 50ms）。
	public func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		try await TranslationSessionPool.shared.translate(text, from: source, to: target)
	}
}
