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
///
/// 短路保護：上述逾時保護解決的是「一件卡死不拖垮隊伍」，但服務**持續**卡住時，隊伍裡每一件仍會
/// 各自等滿 `timeout` 才失敗、各留一個被放棄的 `Task` 與（在逾時前）一顆 session——資源仍隨隊伍
/// 長度線性累積。故加一層跨呼叫的連續逾時計數（per 語言對）：連續逾時達 `consecutiveTimeoutThreshold`
/// 即短路，短路持續 `circuitOpenDuration`——期間新請求**不建 session、不呼叫 `translateOperation`**、
/// 以 `TranslationCircuitOpenError` 失敗（短路檢查排在門閂 `acquire` **之後**、建 session 之前，
/// 理由見 `translate` 的說明；因此排在「仍在途那一件」後方的請求，會先等到門閂才快速失敗，
/// 最壞一個 `timeout`——不論那一件是復原探測、還是首次觸發短路的最後一件逾時）。
/// 期滿後下一件呼叫視為復原探測：探測有回應（成功或真實錯誤，只要不是逾時或呼叫端取消）即關閉短路、
/// 計數歸零；探測本身仍逾時則重新計時、再短路一輪。計數只認「逾時」，真實錯誤（如語言碼有誤）與
/// 呼叫端取消都不計數也不觸發短路——那不是「服務卡住」的訊號，見 `recordTimeout`／`translate` 的
/// catch 區塊。⚠ 短路不可誤清 `installedPairs`（同逾時保護的既有原則）：短路是「暫時不試」、
/// 不是「語言包不見了」，短路路徑全程不動該快取。
///
/// 兩個入口**各自一顆短路、互不阻斷**：`AppleTranslationEngine.status` 的可用性預查同樣可能卡住、
/// 同樣值得停止白送查詢，故它也有一顆（見 `recordAvailabilityTimeout` / `recordAvailabilityReply`），
/// 但**預查側的逾時只關掉預查、永遠不擋 `translate`**。⚠ 這條分離是必要的、不是潔癖（兩者是不是
/// 同一條跨程序通道、會不會一起壞，未經驗證，所以不假設它們同生共死）：兩側共用一顆
/// 計數時，預查端持續卡住而翻譯本身正常的情況下，健康的 `translate` 一次探測機會都拿不到——本 repo
/// 的兩個呼叫端（`BridgeTranslator` / `KoineCLI`）都是先 `status` 後 `translate`，窗口期滿後第一個
/// 到的因此是 `status`，它再逾時一次就把窗口重新起算，如此循環，該語言對永久停用。預查逾時是「這次沒查到」、
/// 不是「翻譯做不到」，用它否決一件做得成的翻譯，正是 `LanguagePairStatus.undetermined` 明文否決的事。
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

	/// 短路保護的 per 語言對狀態（見型別說明「短路保護」段）。
	private struct CircuitState {

		/// 連續逾時次數；任何一次有回應（見 `recordReply`）即歸零。
		var consecutiveTimeouts: Int = 0

		/// 短路解除時刻。`nil` 或已過皆代表未短路——後者的下一次呼叫視為復原探測，
		/// 不需另外的「已過期」旗標：時刻本身既是判斷依據，過期值留著不清也不影響語義。
		var openUntil: ContinuousClock.Instant?
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

	/// `translate` 入口的 per 語言對短路狀態（見型別說明「短路保護」段）。缺鍵＝從未逾時過、未短路。
	private var translateCircuits: [PairKey: CircuitState] = [:]

	/// 可用性預查入口的 per 語言對短路狀態，與 `translateCircuits` **各自獨立**（見型別說明末段）：
	/// 這一顆只決定 `AppleTranslationEngine.status` 要不要再送查詢，對 `translate` 沒有任何否決權。
	private var availabilityCircuits: [PairKey: CircuitState] = [:]

	/// session 建構器（測試注入以觀測建構次數；預設走 macOS 26 standalone init）。
	private let factory: @Sendable (Locale.Language, Locale.Language) -> TranslationSession

	/// 單件翻譯的實際執行封裝（測試注入以觀測同時執行中數／模擬失敗；預設走真 `session.translate`）。
	private let translateOperation: @Sendable (TranslationSession, String) async throws -> String

	/// 單件翻譯的等待上限（見型別說明的逾時保護段）。
	///
	/// 預設 30 秒刻意寬鬆：本上限要擋的是「永不返回」的隊頭阻塞、不是延遲 SLA，
	/// 而首件翻譯要付語言模型冷啟成本、抓太緊會把正常的慢請求誤判成逾時（使用者端表現為整頁漏譯）。
	private let timeout: Duration

	/// 短路門檻：同語言對連續逾時達此次數即短路（見型別說明「短路保護」段）。
	///
	/// 預設 3：低於它會把「連續兩件恰好都慢」這種偶發情形也判成服務卡住（`timeout` 本身已刻意
	/// 寬鬆 30 秒，兩件慢請求疊在一起並非罕見）；抓太高則短路保護要解的資源累積問題本身會先
	/// 累積到有感。
	///
	/// 兩個入口共用這個門檻值、但各自計數，故達成門檻要付的時間兩側不同：
	/// - `translate` 側有門閂、逾時必然序列發生，代價就是 `threshold × timeout`（預設約 90 秒）。
	/// - 預查側的上限是 `availabilityTimeout`（預設 5 秒）且**沒有門閂**（見 `status` 的說明），
	///   呼叫端一次派多段時多筆查詢同時在途、同時逾時，最快一個 `availabilityTimeout`（約 5 秒）
	///   就會達門檻；完全序列時則是 `threshold × availabilityTimeout`（約 15 秒）。
	///
	/// 兩側代價相差一個量級是可接受的，因為兩顆短路的後果不同：預查側只是停止送出注定沒結果的
	/// 查詢（回 `.undetermined`、不擋路），誤判的代價是一個窗口內少一次可行動指引；`translate` 側
	/// 才是真的拒絕服務，所以由它自己較貴的逾時來決定。
	private let consecutiveTimeoutThreshold: Int

	/// 短路持續時間：期滿前一律快速失敗，期滿後下一次呼叫視為復原探測（見型別說明）。
	///
	/// 預設 60 秒＝`timeout` 的 2 倍，方向與 30 秒逾時上限一致但更保守：太短＝探測頻率高、
	/// 抵銷短路保護的意義；太長＝服務其實已恢復卻仍白白多擋一段時間。取 2 倍的實際效果是把
	/// 探測週期壓到「窗口＋一次探測」——`translate` 側因門閂序列化，最壞是每 90 秒放**一件**
	/// 進去試（60 秒窗口＋最多等滿 30 秒的探測）；預查側沒有門閂，是每 65 秒放**一批**
	/// （60 秒窗口＋5 秒的預查上限，批量上限由呼叫端的並發數決定）。
	/// ⚠ 它**不是**「讓窗口與探測不前後緊貼」——探測逾時後的新窗口按 `recordTimeout` 的寫法
	/// 本來就從探測結束那一刻起算，任何取值皆然。
	/// 偏保守的另一個理由屬推測而非實測：`translationd` 這類系統服務的卡死若源於程序級問題，
	/// 秒級重試多半只會製造更多被放棄的探測。
	private let circuitOpenDuration: Duration

	/// 注入 session 建構器、翻譯執行封裝、逾時上限與短路兩參數；預設
	/// `TranslationSession(installedSource:target:)` 加真 `session.translate`——前兩者僅供測試觀測，
	/// production 呼叫端不帶參數；`timeout`／`consecutiveTimeoutThreshold`／`circuitOpenDuration`
	/// 皆為 production 行為參數，測試另以短上限／低門檻注入以免拖長測試。
	public init(
		factory: @escaping @Sendable (Locale.Language, Locale.Language) -> TranslationSession = {
			TranslationSession(installedSource: $0, target: $1)
		},
		translateOperation: @escaping @Sendable (TranslationSession, String) async throws -> String = {
			try await $0.translate($1).targetText
		},
		timeout: Duration = .seconds(30),
		consecutiveTimeoutThreshold: Int = 3,
		circuitOpenDuration: Duration = .seconds(60)
	) {
		// 三個行為參數取非正值時保護都會**靜默失效**而不是明顯壞掉：門檻 ≤ 0 讓 `recordTimeout` 的
		// 比較恆真、第一次逾時就短路；窗口 ≤ 0 讓 `openUntil` 永遠已過期＝短路形同不存在，
		// 但連續逾時計數仍在無上限累加；上限 ≤ 0 讓每件立刻逾時、達門檻後循環重開窗口而永久短路。
		// 三者都不會產生任何錯誤訊號，故在建構期就擋下。
		precondition(timeout > .zero, "timeout 需大於零")
		precondition(consecutiveTimeoutThreshold > 0, "consecutiveTimeoutThreshold 需為正整數")
		precondition(circuitOpenDuration > .zero, "circuitOpenDuration 需大於零")
		self.factory = factory
		self.translateOperation = translateOperation
		self.timeout = timeout
		self.consecutiveTimeoutThreshold = consecutiveTimeoutThreshold
		self.circuitOpenDuration = circuitOpenDuration
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

	/// 該語言對的 **`translate` 入口**目前是否短路中（見型別說明「短路保護」段）。
	///
	/// `translate` 內部走同一份狀態做同樣的檢查（見其實作）；本方法只是把該狀態讀出來，
	/// 供呼叫端與測試觀測。⚠ 預查側另有一顆獨立的短路，**不由本方法反映**。
	public func isCircuitOpen(from source: Locale.Language, to target: Locale.Language) -> Bool {
		openRemaining(for: PairKey(source: source, target: target), in: translateCircuits) != nil
	}

	/// 該語言對的**預查入口**目前是否短路中：供 `AppleTranslationEngine.status` 在動手查詢前先問，
	/// 短路中就不必再送一次注定和先前幾次同命運的可用性查詢，直接回 `.undetermined`。
	///
	/// 與 `isCircuitOpen` 讀的是**不同**一顆（見型別說明末段）：預查側短路只停掉預查本身，
	/// 不影響 `translate`。
	///
	/// 刻意留在 module 內（唯一呼叫端是同 module 的 `AppleTranslationEngine`）：這是內部協作面、
	/// 不是對外能力。
	func isAvailabilityCircuitOpen(from source: Locale.Language, to target: Locale.Language) -> Bool {
		openRemaining(for: PairKey(source: source, target: target), in: availabilityCircuits) != nil
	}

	/// 供 `AppleTranslationEngine.status` 回報一次可用性查詢逾時，計進**預查側**那顆計數
	/// （見型別說明末段）——不碰 `translate` 側，故預查再怎麼逾時也不會讓翻譯被拒。
	///
	/// 刻意留在 module 內（唯一呼叫端是同 module 的 `AppleTranslationEngine`）：這是記帳鉤子、
	/// 不是對外能力，公開出去等於讓任何呼叫端都能憑空觸發或清掉任一語言對的短路。
	func recordAvailabilityTimeout(from source: Locale.Language, to target: Locale.Language) {
		recordTimeout(PairKey(source: source, target: target), in: &availabilityCircuits)
	}

	/// 供 `AppleTranslationEngine.status` 回報一次「有回應」（結果為哪種 `LanguagePairStatus`
	/// 不重要，只要不是逾時或呼叫端取消）：預查顯然沒有卡住，預查側計數歸零、短路（若有）解除。
	/// 同 `recordAvailabilityTimeout`，只動預查側、刻意留在 module 內。
	///
	/// !!!: 這裡的 `availabilityCircuits` 誤植成 `translateCircuits` 兩側都會壞，而且**現有測試
	/// 全綠**——`translate` 側每被預查答對一次就清零、短路至少遲一輪才開（取消反覆發生時長期
	/// 湊不滿門檻），預查側則再也不會歸零、連不連續的逾時也累加而誤開。前者穩定態下撞不到
	/// （已裝妥時 `status` 停在 `isKnownInstalled` 就返回、走不到本方法），後者只靠 `status`
	/// 即可觀測（交替 hang／回 `.supported` 的查詢樁）。動 `availabilityCircuits` 的三個觸點
	/// （`isAvailabilityCircuitOpen`／`recordAvailabilityTimeout`／本方法）時逐一確認傳哪一份。
	func recordAvailabilityReply(from source: Locale.Language, to target: Locale.Language) {
		recordReply(PairKey(source: source, target: target), in: &availabilityCircuits)
	}

	/// 以複用 session 翻譯一句；失敗（含逾時）時先丟棄該語言對快取（語言包狀態可能已變）再拋出。
	/// 同語言對序列化執行（先取門閂再取 session：前一件失效重建後、下一件拿到的是新 session）。
	///
	/// 短路檢查刻意排在 `acquire` **之後**、建 session **之前**：排在 `acquire` 之前雖然對
	/// 「隊伍已空」的常見情形無差別（`busy` 未命中時 `acquire` 同步返回、無真正等待），但排在
	/// 之後才能同時擋住「本已排隊、等待期間短路才剛觸發」這種情形——`release` 會把門閂直接轉移
	/// 給下一位等候者，若不在拿到門閂後重新檢查，該等候者仍會被送去 `translateWithTimeout` 各自
	/// 等滿 `timeout`，正是短路保護要解的資源累積。短路時不建 session、不呼叫 `translateOperation`，
	/// 且**不動** `installedPairs`（短路是「暫時不試」、不是「語言包不見了」）。
	public func translate(
		_ text: String,
		from source: Locale.Language,
		to target: Locale.Language
	) async throws -> String {
		let key = PairKey(source: source, target: target)
		await acquire(key)
		if let remaining = openRemaining(for: key, in: translateCircuits) {
			release(key)
			throw TranslationCircuitOpenError(retryAfter: remaining)
		}
		let session = session(for: key)
		do {
			let translated: String = try await translateWithTimeout(using: session, text: text)
			// 記帳一律排在 `release` 之前（catch 區塊同序）：`release` 會把門閂直接轉移給下一位
			// 等候者，狀態先更新完再放行，正確性就不必依賴「這兩行之間剛好沒有 await」。
			recordReply(key, in: &translateCircuits)
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
			// 短路計數只認「逾時」：真實錯誤（如語言碼有誤）代表服務有回應、只是這次做不到，
			// 與「卡住」是不同訊號，故走 `recordReply` 歸零而非累加；呼叫端取消（`CancellationError`，
			// 見 `translateWithTimeout` 的取消分支）兩者都不算——那只代表呼叫端不等了，對服務是否
			// 卡住沒有訊號，計進任一邊都會扭曲短路判斷（取消常見於使用者關分頁等場景，若算「有回應」
			// 會讓短路永遠追不上真正卡住的情形；算「逾時」則使用者行為變成觸發短路的訊號，同樣不對）。
			switch error {
			case is TranslationTimeoutError:
				recordTimeout(key, in: &translateCircuits)
			case is CancellationError:
				break
			default:
				recordReply(key, in: &translateCircuits)
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

	/// 若該語言對在 `states` 這一側短路中，回傳距解除還有多久；未短路（含從未逾時過、
	/// 或短路窗口已過）回 `nil`。
	///
	/// 兩個入口各自傳自己那份狀態進來（見型別說明末段），三個私有記帳方法因此都吃
	/// `states` 參數而非直取欄位——分離的是狀態、不是邏輯，兩側的判斷規則刻意保持同一份。
	///
	/// 窗口已過即視同未短路、不在此清 `states[key]`——下一次呼叫走正常路徑即是復原探測，
	/// 探測結果由 `recordTimeout`／`recordReply` 決定要不要重新短路，本方法只負責讀、不負責寫。
	private func openRemaining(for key: PairKey, in states: [PairKey: CircuitState]) -> Duration? {
		guard let openUntil = states[key]?.openUntil else { return nil }
		let now: ContinuousClock.Instant = ContinuousClock().now
		guard now < openUntil else { return nil }
		return now.duration(to: openUntil)
	}

	/// 記一次逾時；連續次數達 `consecutiveTimeoutThreshold` 即（重新）短路 `circuitOpenDuration`。
	/// 未達門檻只累加計數、不影響行為——每件仍照樣各自嘗試，見型別說明。
	private func recordTimeout(_ key: PairKey, in states: inout [PairKey: CircuitState]) {
		var state: CircuitState = states[key] ?? CircuitState()
		state.consecutiveTimeouts += 1
		if state.consecutiveTimeouts >= consecutiveTimeoutThreshold {
			state.openUntil = ContinuousClock().now.advanced(by: circuitOpenDuration)
		}
		states[key] = state
	}

	/// 記一次有回應：連續逾時計數歸零、短路（若處於短路中）解除。
	private func recordReply(_ key: PairKey, in states: inout [PairKey: CircuitState]) {
		states[key] = nil
	}
}
