//
//  KoineDOMTests
//
//  Copyright © 2026 Unpxre (GitHub: UnpxreTW)
//  Licensed under the Apache License 2.0. See LICENSES/Apache-2.0.txt for details.
//
//  SPDX-License-Identifier: Apache-2.0

import Testing
import WebKit

// MARK: - ProtectedSpan

/// 比對用 protected span：`code` / `time` 等不可分割原子在 source 字串內的字元範圍。
private struct ProtectedSpan: Decodable, Equatable {

	/// 原子在 source 內的起始字元 offset。
	let start: Int

	/// 原子在 source 內的結束字元 offset（exclusive）。
	let end: Int

	/// 原子種類（`code` / `time`）。
	let kind: String
}

// MARK: - NormSeg

/// golden 比對形狀：對齊跑道 A `helpers.normalize`（留 order / source / state，丟 anchor 與 id）。
private struct NormSeg: Decodable, Equatable {

	/// 文件序連號。
	let order: Int

	/// 段落原文（空白正規化後）。
	let source: String

	/// 段落狀態（`pending` / `skipped` 等）。
	let state: String

	/// `skipped` 段的略過原因；非 skipped 為 nil。
	let skipReason: String?

	/// 段內 protected span 清單；無則 nil。
	let protectedSpans: [ProtectedSpan]?
}

// MARK: - RenderResult

/// render 插回往返驗證形狀：採集 → 塞假 draft → `insertTranslations` → 二次採集的各階段計數（§7.1）。
private struct RenderResult: Decodable {

	/// 第一次採集（render 前）的段數。
	let firstCount: Int

	/// 被塞假 draft 並轉 `drafted` 的段數（= 應插 wrapper 數）。
	let drafted: Int

	/// `insertTranslations` 實際插入的 wrapper 數。
	let inserted: Int

	/// 第二次採集（render 後）的段數；自吞防護正常時應等於 `firstCount`。
	let secondCount: Int

	/// 二次採集中 source 含譯文標記的段數；自吞防護正常時應為 0。
	let leaked: Int
}

// MARK: - ObserveResult

/// observe 進場驗證形狀：pending 段數 vs 真 IntersectionObserver 觸發 onEnter 的段數。
private struct ObserveResult: Decodable {

	/// 採集得到的 pending（待譯）段數。
	let pending: Int

	/// 進場觸發 onEnter 的段數。
	let entered: Int
}

// MARK: - EnterOrderResult

/// P3 進場順序驗證形狀：pending 段數＋依 dispatch 序記錄的（order, region）串。
private struct EnterOrderResult: Decodable {

	/// 單筆 dispatch 記錄。
	struct EnteredSeg: Decodable {

		/// 段的文件序。
		let order: Int

		/// 段的區域分類（`main` / `chrome`）。
		let region: String
	}

	/// 採集得到的 pending（待譯）段數。
	let pending: Int

	/// 依 dispatch 序的進場記錄。
	let entered: [EnteredSeg]
}

// MARK: - Manifest

/// fixture 清單（`manifest.json` 解碼）。
private struct Manifest: Decodable {

	/// 單一 fixture 條目。
	struct Case: Decodable {

		/// fixture 檔名（不含副檔名）。
		let name: String

		/// 所屬跑道（`a` / `b` / `both`）。
		let lane: String

		/// 人類可讀說明。
		let desc: String
	}

	/// 全部 fixture 條目。
	let cases: [Case]
}

// MARK: - Source

/// 來源路徑解析：`#filePath` → repo root，再相對取 content.js / fixture / golden / manifest。
private enum Source {

	/// repo root：`#filePath` = `<repo>/Tests/KoineDOMTests/CollectWebKitTests.swift`，往上三層。
	static let repoRoot = URL(filePath: #filePath)
		.deletingLastPathComponent() // KoineDOMTests
		.deletingLastPathComponent() // Tests
		.deletingLastPathComponent() // <repo>

	/// 讀注入 WKWebView 的採集層腳本 content.js。
	static func contentJS() throws -> String {
		try String(contentsOf: repoRoot.appending(path: "Sources/Extension/Resources/content.js"), encoding: .utf8)
	}

	/// 讀指定 fixture 的 HTML。
	static func fixtureHTML(_ name: String) throws -> String {
		try String(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/cases/\(name).html"), encoding: .utf8)
	}

	/// 讀並解碼指定 fixture 的 golden。
	static func golden(_ name: String) throws -> [NormSeg] {
		let data = try Data(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/golden/\(name).json"))
		return try JSONDecoder().decode([NormSeg].self, from: data)
	}

	/// 讀並解碼 fixture 清單。
	static func manifest() throws -> Manifest {
		let data = try Data(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/manifest.json"))
		return try JSONDecoder().decode(Manifest.self, from: data)
	}
}

/// driver：以真 `getComputedStyle` 跑採集、回 normalize 後 JSON（與跑道 A `helpers.normalize` 同欄位）。
private let driverJS = """
	(() => {
	  const k = globalThis.__koine__;
	  const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	  const segs = k.collectSegments(document.body, ctx, { walkId: 1 });
	  return JSON.stringify(segs.map((s) => {
	    const o = { order: s.order, source: s.source, state: s.state };
	    if (s.meta && s.meta.skipReason) o.skipReason = s.meta.skipReason;
	    if (s.meta && s.meta.protectedSpans) o.protectedSpans = s.meta.protectedSpans;
	    return o;
	  }));
	})();
	"""

/// render driver：採集 → 對 pending 段塞假 draft（前綴標記）並轉 `drafted` → `insertTranslations`
/// 插回 → 以新 `walkId` 二次採集；回各階段計數（JSON）供自吞往返斷言（§7.1）。
private let renderDriverJS = """
	(() => {
	  const k = globalThis.__koine__;
	  const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	  const MARK = '@@TR@@';
	  const first = k.collectSegments(document.body, ctx, { walkId: 1 });
	  let drafted = 0;
	  for (const s of first) {
	    if (s.state === k.SegmentState.PENDING) {
	      s.draft = MARK + s.source;
	      s.state = k.SegmentState.DRAFTED;
	      drafted++;
	    }
	  }
	  const inserted = k.insertTranslations(first);
	  const second = k.collectSegments(document.body, ctx, { walkId: 2 });
	  const leaked = second.filter((s) => s.source.indexOf(MARK) !== -1).length;
	  return JSON.stringify({
	    firstCount: first.length, drafted: drafted, inserted: inserted.length,
	    secondCount: second.length, leaked: leaked,
	  });
	})();
	"""

/// observe driver（`callAsyncJavaScript` body，await 真 IntersectionObserver）：採集 → 對 pending 段掛
/// `observeSegments`（走瀏覽器預設 IntersectionObserver）→ 收進場 onEnter 觸發數；全進場或 2s timeout 回報。
private let observeBody = """
	const k = globalThis.__koine__;
	const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	const segs = k.collectSegments(document.body, ctx, { walkId: 1 });
	const pending = segs.filter((s) => s.state === k.SegmentState.PENDING);
	return await new Promise((resolve) => {
	  const entered = [];
	  const done = () => resolve(JSON.stringify({ pending: pending.length, entered: entered.length }));
	  if (pending.length === 0) { done(); return; }
	  k.observeSegments(segs, {
	    onEnter: (s) => { entered.push(s.id); if (entered.length === pending.length) done(); },
	  });
	  setTimeout(done, 2000);
	});
	"""

/// P3 進場順序 driver（`callAsyncJavaScript` body）：採集 → `observeSegments`（預設 eager +
/// tiered IO + priorityGate、真 IntersectionObserver）→ 依 dispatch 序記（order, region）；
/// 全 pending 進場或 3s timeout 回報（§10.1 / §10.2）。
private let enterOrderBody = """
	const k = globalThis.__koine__;
	const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	const segs = k.collectSegments(document.body, ctx, { walkId: 1 });
	const pending = segs.filter((s) => s.state === k.SegmentState.PENDING);
	return await new Promise((resolve) => {
	  const entered = [];
	  const done = () => resolve(JSON.stringify({ pending: pending.length, entered: entered }));
	  if (pending.length === 0) { done(); return; }
	  k.observeSegments(segs, {
	    onEnter: (s) => {
	      entered.push({ order: s.order, region: s.region });
	      if (entered.length === pending.length) done();
	    },
	  });
	  setTimeout(done, 3000);
	});
	"""

// MARK: - NavDelegate

/// `loadHTMLString` 完成回呼橋接（`navigationDelegate` 為 weak，呼叫端需保強參考至完成）。
private final class NavDelegate: NSObject, WKNavigationDelegate {

	/// 導航完成時觸發。
	var onFinish: (() -> Void)?

	/// `WKNavigationDelegate`：導航完成回呼。
	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		onFinish?()
	}
}

// MARK: - CollectWebKitTests

/// 採集層跑道 B（WKWebView / 真 WebKit）：載 fixture HTML → 注入 content.js（universal script，
/// 設 `globalThis.__koine__`、`main()` 因無 browser API 不自動跑）→ driver 以真 `getComputedStyle`
/// 跑 `collectSegments` → JSON 回 Swift 比對 golden。
///
/// fixture / golden / content.js 由 `#filePath` 相對讀源檔本身（本機 dev 測試、非 CI 攜帶）。
@MainActor
private final class CollectWebKitTests {

	/// 所有 lane b / both fixture：真 WebKit 採集對齊 golden（§11.1 both case 過同一份 golden）。
	@Test
	private func `fixtures against golden`() async throws {
		let cases = try Source.manifest().cases.filter { $0.lane == "b" || $0.lane == "both" }
		#expect(!cases.isEmpty, "manifest 無 b/both case")
		for testCase in cases {
			let got = try await collect(fixture: testCase.name)
			let want = try Source.golden(testCase.name)
			#expect(got == want, "fixture \(testCase.name)（\(testCase.desc)）與 golden 不符")
		}
	}

	/// 並列插回往返：真 WebKit 採集 → 插回譯文 wrapper → 二次採集應 0 新段（§7.1 自吞防護）。
	@Test
	private func `render insert then recollect`() async throws {
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		try await load(webView, html: Source.fixtureHTML("01-basic-paragraphs"))
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let json = try await webView.evaluateJavaScript(renderDriverJS) as? String ?? "{}"
		let result = try JSONDecoder().decode(RenderResult.self, from: Data(json.utf8))
		#expect(result.drafted > 0, "fixture 應至少有一段 pending 可 draft")
		#expect(result.inserted == result.drafted, "插入 wrapper 數應 = drafted 段數")
		#expect(result.secondCount == result.firstCount, "render 後再採集應 0 新段（wrapper 全被 classifyNode [1] 擋）")
		#expect(result.leaked == 0, "二次採集不得撈到任何譯文（自吞防護 §7.1 c）")
	}

	/// 進場觀察跑道 B：真 IntersectionObserver 對所有 pending 段觸發 onEnter（§10 lazy 進場）。
	@Test
	private func `observe enters pending segments`() async throws {
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		try await load(webView, html: Source.fixtureHTML("01-basic-paragraphs"))
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let raw = try await webView.callAsyncJavaScript(observeBody, arguments: [:], in: nil, contentWorld: .page)
		let json = raw as? String ?? "{}"
		let result = try JSONDecoder().decode(ObserveResult.self, from: Data(json.utf8))
		#expect(result.pending > 0, "fixture 應有 pending 段")
		#expect(result.entered == result.pending, "真 IntersectionObserver 應對所有 pending 段觸發 onEnter（進場）")
	}

	/// P3 進場順序（§10.1/§10.2）：主文（`<main>`、全數落 eager 預算內）先出且依文件序；
	/// 視窗下方 400px 內的 footer（chrome）之後仍進場（順序非範圍）、排在全部 main 之後。
	@Test
	private func `p3 enter order: main eager first, chrome after`() async throws {
		// 版面固定高（layout 確定性）：main 10 段 × 60px = 600px（前 12 屏內）、spacer 300px、
		// footer 起點 ~900px——在視窗（768px）外、chrome IO rootMargin（400px）內。
		let mainParagraphs = (0 ..< 10)
			.map { "<p style='margin:0;height:60px'>Main content paragraph number \($0) with enough words.</p>" }
			.joined()
		let html = "<body style='margin:0'><main>\(mainParagraphs)</main>"
			+ "<div style='height:300px'></div>"
			+ "<footer><p style='margin:0'>Footer copyright notice text</p>"
			+ "<p style='margin:0'><a href='#'>About this project</a> <a href='#'>Contact the team</a></p>"
			+ "</footer></body>"
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		await load(webView, html: html)
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let raw = try await webView.callAsyncJavaScript(enterOrderBody, arguments: [:], in: nil, contentWorld: .page)
		let json = raw as? String ?? "{}"
		let result = try JSONDecoder().decode(EnterOrderResult.self, from: Data(json.utf8))
		let mains = result.entered.filter { $0.region == "main" }
		let chromes = result.entered.filter { $0.region == "chrome" }
		#expect(result.pending == 12, "前提：10 main + 2 footer 段皆 pending")
		#expect(result.entered.count == result.pending, "全 pending 進場（chrome 降權仍翻、順序非範圍）")
		#expect(mains.count == 10 && chromes.count == 2, "region 分類：main 10、chrome 2")
		#expect(result.entered.prefix(10).allSatisfy { $0.region == "main" }, "全部 main 先於全部 chrome（eager + regionRank）")
		#expect(mains.map(\.order) == mains.map(\.order).sorted(), "main 依文件序 dispatch（eager 文件序前 N + order tie-break）")
	}

	/// SPEC §1 實測基準 smoke：照抄者以此為準的關鍵值，對齊真 WebKit。
	@Test
	private func `display baseline smoke`() async throws {
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
		let html = "<div style='display:flex'><span id='ib' style='display:inline-block'>x</span></div>"
			+ "<ruby>漢<rt id='rt'>k</rt></ruby>"
		await load(webView, html: html)
		let inlineBlockDisplay = try await webView.evaluateJavaScript(
			"getComputedStyle(document.getElementById('ib')).display"
		) as? String
		let rubyTextDisplay = try await webView.evaluateJavaScript(
			"getComputedStyle(document.getElementById('rt')).display"
		) as? String
		#expect(inlineBlockDisplay == "block", "inline-block 在 flex 容器內被 blockify（SPEC §1 A1）")
		#expect(
			rubyTextDisplay == "ruby-text",
			"rt → ruby-text（真 WKWebView/系統 WebKit 實證；SPEC §1 A3 的 Playwright 值 inline 在系統 WebKit 不成立）"
		)
	}

	/// 載入 HTML 並 await 導航完成（保留 delegate 強參考至完成）。
	private func load(_ webView: WKWebView, html: String) async {
		let delegate: NavDelegate = .init()
		webView.navigationDelegate = delegate
		await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
			delegate.onFinish = { cont.resume() }
			webView.loadHTMLString(html, baseURL: nil)
		}
		// 保留 delegate 強參考至導航完成（navigationDelegate 為 weak）。
		withExtendedLifetime(delegate) {}
	}

	/// 載入指定 fixture、注入 content.js、跑 driver，回 normalize 後段落。
	private func collect(fixture name: String) async throws -> [NormSeg] {
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		try await load(webView, html: Source.fixtureHTML(name))
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let json = try await webView.evaluateJavaScript(driverJS) as? String ?? "[]"
		return try JSONDecoder().decode([NormSeg].self, from: Data(json.utf8))
	}
}
