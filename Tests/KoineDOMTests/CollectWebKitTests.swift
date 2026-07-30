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

	/// 讀注入 WKWebView 的採集層腳本 content.js，補 `;0` 固定完成值。
	///
	/// content.js 的程式完成值是尾巴 `globalThis.__koine__ = __koineExports` 賦值出來的
	/// exports 物件（成員全是 function、不可序列化）：macOS 26 的 WebKit 對此讓 async
	/// `evaluateJavaScript` 丟 WKError 5（`javaScriptResultTypeIsUnsupported`），macOS 27
	/// 則丟掉 function 成員回空物件。補一個可序列化的完成值（`0`）讓注入跨版本穩定。
	static func contentJS() throws -> String {
		try String(contentsOf: repoRoot.appending(path: "Sources/Extension/Resources/content.js"), encoding: .utf8)
			+ "\n;0"
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

/// insertMode driver：採集 → 回每段的 (order, source, insertMode, kind)，供跑道 B 斷言插回模式。
/// golden 通道刻意只留 order/source/state（丟 anchor），故語言對軸只能靠這支專用 driver 驗。
private let insertModeDriverJS = """
	(() => {
	  const k = globalThis.__koine__;
	  const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	  const segs = k.collectSegments(document.body, ctx, { walkId: 1 });
	  return JSON.stringify(segs.map((s) => ({
	    order: s.order, source: s.source,
	    insertMode: s.anchor.insertMode, kind: s.kind || null,
	  })));
	})();
	"""

/// 語言對 replace 往返 driver：採集 → 塞假 draft → `insertTranslations` → 回插回後的 DOM 實況。
private let langPairRenderBody = """
	(() => {
	  const k = globalThis.__koine__;
	  const ctx = k.makeContext({ targetLang: 'zh-Hant' });
	  const segs = k.collectSegments(document.body, ctx, { walkId: 1 });
	  for (const s of segs) {
	    if (s.state === k.SegmentState.PENDING) { s.draft = '譯:' + s.source; s.state = k.SegmentState.DRAFTED; }
	  }
	  k.insertTranslations(segs);
	  const read = (id) => {
	    const el = document.getElementById(id);
	    return { text: el.textContent, translated: el.hasAttribute('data-koine-translated') };
	  };
	  return JSON.stringify({
	    zh: read('zh'), en: read('en'),
	    wrappers: document.querySelectorAll('.koine-translated').length,
	  });
	})();
	"""

// MARK: - InsertModeSeg

/// insertMode driver 回傳形狀。
private struct InsertModeSeg: Decodable {

	/// 文件序連號。
	let order: Int

	/// 段落原文。
	let source: String

	/// 插回模式（`after-segment` / `replace`）。
	let insertMode: String

	/// 段的種類分類（`button` 或 nil）。
	let kind: String?
}

// MARK: - LangPairRender

/// 語言對 replace 往返回傳形狀：兩顆受測元素插回後的實況。
private struct LangPairRender: Decodable {

	/// 單一元素的插回後狀態。
	struct ElementState: Decodable {

		/// 插回後的 textContent。
		let text: String

		/// 是否帶 `data-koine-translated` 防自吞標記。
		let translated: Bool
	}

	/// 簡中段（預期就地取代）。
	let zh: ElementState

	/// 英文段（預期並列、原文不動）。
	let en: ElementState

	/// 插回後全頁的譯文 wrapper 數。少了這條，「英文段完全沒插回」與「英文段正確並列插回」
	/// 對其餘斷言而言長得一模一樣（原文未變、未帶標記），測試會對 render 失敗毫無鑑別力。
	let wrappers: Int
}

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

	/// `<body translate="no">` 降級：真 WebKit 下內文仍採得到。
	///
	/// 這條是 `el.translate` IDL 繼承回歸的偵測器。該 IDL 反映**繼承後**的值——祖先標了
	/// `translate="no"`，子孫的 `el.translate` 全是 `false`；`respectsTranslateNo` 若改回讀
	/// IDL，body 降級放行後子代仍會被判成 no 而整棵跳，整頁採不到段。linkedom 不實作該 IDL、
	/// 跑道 A 永遠是綠的，只有這裡抓得到。
	///
	/// 原本擔這個角色的是 fixture `13-translate-no-bulk`（golden 期望 1 段），但降級門檻收緊為
	/// 只有 BODY 之後，`<article translate="no">` 的正確輸出與 bug 輸出都是 0 段、分不出來；
	/// 而 fixture 格式表達不了 body 屬性，故改在此處手搭 HTML。
	@Test
	private func `body level translate no still collects in real WebKit`() async throws {
		let html = "<html translate=\"no\"><body translate=\"no\">"
			+ "<p>Framework mislabel, still translated.</p>"
			+ "<p>Second paragraph also translated.</p></body></html>"
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		await load(webView, html: html)
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let json = try await webView.evaluateJavaScript(driverJS) as? String ?? "[]"
		let segs = try JSONDecoder().decode([NormSeg].self, from: Data(json.utf8))
		#expect(segs.count == 2, "body 降級後內文應照常採集（讀 IDL 而非自身屬性會在此歸零）")
		#expect(segs.map(\.source) == [
			"Framework mislabel, still translated.",
			"Second paragraph also translated.",
		])
	}

	/// §9.2 語言對軸在真 WebKit：`<html lang="zh-CN">` 下，簡中段就地取代、同頁英文段並列。
	///
	/// 語言判定走祖先鏈（`walkAndLabel` 的 lang 下行增量），與 `el.translate` 同屬「繼承語義」
	/// 那一類——正是跑道 A 的 DOM 模擬最容易與真引擎分歧的地方；且 golden 通道丟掉 anchor、
	/// 載不動 `insertMode`，故另開這支 driver。
	@Test
	private func `insert mode language pair in real WebKit`() async throws {
		let html = "<html lang=\"zh-CN\"><body>"
			+ "<p id=\"zh\">这是简体中文段落内容。</p>"
			+ "<p id=\"en\">An English comment in a simplified Chinese page.</p></body></html>"
		let webView: WKWebView = .init(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		await load(webView, html: html)
		_ = try await webView.evaluateJavaScript(Source.contentJS())

		let modeJSON = try await webView.evaluateJavaScript(insertModeDriverJS) as? String ?? "[]"
		let segs = try JSONDecoder().decode([InsertModeSeg].self, from: Data(modeJSON.utf8))
		#expect(segs.count == 2, "兩段皆應採到")
		#expect(segs.first?.insertMode == "replace", "簡中段：語言對軸命中、就地取代")
		#expect(segs.last?.insertMode == "after-segment", "同頁英文段：漢字安全閘擋下、走並列")

		let renderJSON = try await webView.evaluateJavaScript(langPairRenderBody) as? String ?? "{}"
		let render = try JSONDecoder().decode(LangPairRender.self, from: Data(renderJSON.utf8))
		#expect(render.zh.text == "譯:这是简体中文段落内容。", "簡中段原地換字")
		#expect(render.zh.translated, "簡中段應帶防自吞標記")
		#expect(
			render.en.text == "An English comment in a simplified Chinese page.",
			"英文原文必須原封不動留在頁面上",
		)
		#expect(!render.en.translated, "英文段走並列、原元素不被標記")
		#expect(render.wrappers == 1, "恰好一個譯文 wrapper：英文段真的並列插回了，不是整段沒插")
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
