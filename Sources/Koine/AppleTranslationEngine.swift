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
		// 同 `TranslationSessionPool.init` 的理由：上限 ≤ 0 會讓每次預查立刻「逾時」、達門檻後
		// 循環重開窗口而永久短路（預查層形同不存在），且不產生任何錯誤訊號。
		precondition(availabilityTimeout > .zero, "availabilityTimeout 需大於零")
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
	/// 逾時保護：`LanguageAvailability` 同樣走跨程序往返、同樣可能永不返回，而本方法**排在每一段
	/// 翻譯之前**——它卡住，整頁就停在預查、連 `translate` 那層已有的上限都到不了。故查詢帶等待
	/// 上限，上限先到就放棄等待、回 `.undetermined`。（兩者是不是同一條通道、會不會一起壞，
	/// 未經驗證，所以兩層保護各自成立、互不假設對方；短路也因此分成兩顆，見下。）
	///
	/// `.undetermined` **不擋路**（`actionableMessage` 對它回 `nil`）：呼叫端照常往下走真正的
	/// 翻譯，由那層的上限與真實錯誤收場。預查是把常見失敗換成可行動訊息的優化，逾時把它降級成
	/// 「這次沒幫上忙」即可，不該讓它反過來否決一件翻譯得成的事。
	///
	/// 短路保護：連續逾時達門檻後，本方法直接回 `.undetermined`、不再送出注定同命運的查詢；
	/// 有回應（含已知失敗，只要不是逾時或呼叫端取消）則回報服務仍活著、計數歸零。短路路徑同樣
	/// 不動 `installedPairs`（短路是「暫時不試」、不是「語言包不見了」）。
	///
	/// ⚠ 這顆短路是**預查專屬**的，與 `TranslationSessionPool.translate` 那顆各自獨立（見該型別
	/// 說明末段）：本方法的逾時只會關掉本方法，**永遠不擋翻譯**。這不是保守，是上一段「不擋路」
	/// 原則的必然延伸——共用一顆計數時，預查端持續卡住而翻譯本身正常的情況下，健康的 `translate`
	/// 一次探測機會都拿不到（本 repo 的呼叫端都是先 `status` 後 `translate`，窗口期滿後第一個到的
	/// 因此是本方法，它再逾時一次就把窗口重新起算），該語言對會永久停用；那正是「憑一個沒查到的
	/// 答案否決一件做得到的事」，只是換成永久版本。
	///
	/// ⚠ 界限：本方法沒有 `translate` 那種 per 語言對門閂，呼叫端並發送出多段時彼此不序列化
	/// ——同語言對的多筆查詢會各自通過上面的短路檢查後同時在途，短路對「同時在途的那一批」零保護，
	/// 只擋得住其後才到達的；短路窗口期滿後同理，一個窗口會放進一批而非一件。要收掉它得為預查
	/// 另立門閂，代價是把每段翻譯前的預查變成序列化瓶頸。
	public func status(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> LanguagePairStatus {
		if await TranslationSessionPool.shared.isKnownInstalled(from: source, to: target) {
			return .installed
		}
		if await TranslationSessionPool.shared.isAvailabilityCircuitOpen(from: source, to: target) {
			return .undetermined
		}
		switch await queryWithTimeout(from: source, to: target) {
		case .result(let status):
			if case .installed = status {
				await TranslationSessionPool.shared.markInstalled(from: source, to: target)
			}
			await TranslationSessionPool.shared.recordAvailabilityReply(from: source, to: target)
			return status
		case .timedOut:
			await TranslationSessionPool.shared.recordAvailabilityTimeout(from: source, to: target)
			return .undetermined
		case .cancelled:
			// 呼叫端不等了，對服務是否卡住沒有訊號——不記進短路計數的任一邊（同 `TranslationSessionPool
			// .translate` 的 `CancellationError` 分支，理由詳見該處）。
			return .undetermined
		}
	}

	/// `queryWithTimeout` 的結果分流，供呼叫端（`status`）分別記入**預查側**短路計數（見
	/// `TranslationSessionPool` 型別說明末段）——逾時要計數，取消不算，
	/// 有結果（無論該結果是哪種 `LanguagePairStatus`）代表服務有回應、同樣不算逾時。
	private enum AvailabilityOutcome {

		/// 查詢在上限內返回。
		case result(LanguagePairStatus)

		/// 上限先到、放棄等待。
		case timedOut

		/// 呼叫端 task 被取消。
		case cancelled
	}

	/// 以 `availabilityTimeout` 為上限跑可用性查詢；上限先到就放棄等待、回 `.timedOut`
	/// （呼叫端 `status` 一律轉譯為 `.undetermined`，見該處）。
	///
	/// !!!: 與 `TranslationSessionPool.translateWithTimeout` 是同一套非結構化 `Task` 賽跑，
	/// **刻意各留一份而非抽共用工具**：那邊的操作閉包捕捉非 Sendable 的 `TranslationSession`，
	/// 靠 `Task` 繼承 actor 隔離才合法，抽成收 `@Sendable` 閉包的泛型工具當場編不過。
	/// 兩處同樣不能改用 task group——group 保證 body 返回前子任務全數結束，而本保護要解的正是
	/// 「查詢卡在不可取消的等待」：那種情況下子任務永不結束、group 跟著永不返回，上限形同不存在。
	private func queryWithTimeout(
		from source: Locale.Language,
		to target: Locale.Language
	) async -> AvailabilityOutcome {
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
		guard let outcome: RaceOutcome = await outcomeIterator.next() else {
			work.cancel()
			return .cancelled
		}
		switch outcome {
		case .settled:
			return .result(await work.value)
		case .timedOut:
			work.cancel()
			return .timedOut
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
