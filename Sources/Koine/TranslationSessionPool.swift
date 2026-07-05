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
/// （`busy` + `waiters`）保證同語言對同時只有一件 translate 在跑。吞吐不受影響：
/// `translationd` 內部本就序列化（實測多路併發無吞吐增益）。
/// 譯出錯即丟棄該語言對的快取 session：語言包狀態可能已變（如剛下載完成），下次呼叫重建。
///
/// 已知限制：單件 translate 若永不返回（translationd 走 XPC、中斷通常以 error 收場，機率低），
/// 該語言對門閂將永久持有、後續請求隊頭阻塞——若觀測到 appex 卡死優先懷疑此處
/// （解法＝對 translate 包 timeout、超時視同 session 失效走既有丟棄路徑）。
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

	/// 每語言對一顆的 session 快取。
	private var sessions: [PairKey: TranslationSession] = [:]

	/// 門閂：當前有 translate 進行中的語言對（actor 於 `await` 期間可重入，靠此擋同 session 併發）。
	private var busy: Set<PairKey> = []

	/// 門閂等候佇列（FIFO、per 語言對）。
	private var waiters: [PairKey: [CheckedContinuation<Void, Never>]] = [:]

	/// session 建構器（測試注入以觀測建構次數；預設走 macOS 26 standalone init）。
	private let factory: @Sendable (Locale.Language, Locale.Language) -> TranslationSession

	/// 注入 session 建構器；預設 `TranslationSession(installedSource:target:)`。
	public init(
		factory: @escaping @Sendable (Locale.Language, Locale.Language) -> TranslationSession = {
			TranslationSession(installedSource: $0, target: $1)
		}
	) {
		self.factory = factory
	}

	/// 取回或建構該語言對的快取 session（測試觀測複用命中的鉤子）。
	/// 注意這不是效能暖機：同步建構實測僅 ~0.2ms，session 成本 lazy 到首次 translate 才付。
	public func ensureSession(from source: Locale.Language, to target: Locale.Language) {
		_ = session(for: PairKey(source: source, target: target))
	}

	/// 以複用 session 翻譯一句；失敗時先丟棄該語言對快取（語言包狀態可能已變）再拋出。
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
			let translated = try await session.translate(text).targetText
			release(key)
			return translated
		} catch {
			sessions[key] = nil
			release(key)
			throw error
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
