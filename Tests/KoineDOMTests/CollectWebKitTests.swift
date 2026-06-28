// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 採集層跑道 B（WKWebView / 真 WebKit）：載 fixture HTML → 注入 content.js（universal script，
// 設 globalThis.__koine__、main() 因無 browser API 不自動跑）→ driver 以「真」getComputedStyle
// 跑 collectSegments → JSON 回 Swift 比對 golden。fixture / golden / content.js 由 #filePath 相對
// 讀源檔本身（本機 dev 測試，非 CI 攜帶）。

import WebKit
import XCTest

// MARK: - golden / manifest 型別（對齊跑道 A normalize 形狀）

private struct ProtectedSpan: Decodable, Equatable {
	let start: Int
	let end: Int
	let kind: String
}

private struct NormSeg: Decodable, Equatable {
	let order: Int
	let source: String
	let state: String
	let skipReason: String?
	let protectedSpans: [ProtectedSpan]?
}

private struct Manifest: Decodable {
	struct Case: Decodable {
		let name: String
		let lane: String
		let desc: String
	}

	let cases: [Case]
}

// MARK: - 來源路徑（#filePath → repo root）

private enum Source {
	// #filePath = <repo>/Tests/KoineDOMTests/CollectWebKitTests.swift
	static let repoRoot = URL(filePath: #filePath)
		.deletingLastPathComponent() // KoineDOMTests
		.deletingLastPathComponent() // Tests
		.deletingLastPathComponent() // <repo>

	static func contentJS() throws -> String {
		try String(contentsOf: repoRoot.appending(path: "Sources/Extension/Resources/content.js"), encoding: .utf8)
	}

	static func fixtureHTML(_ name: String) throws -> String {
		try String(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/cases/\(name).html"), encoding: .utf8)
	}

	static func golden(_ name: String) throws -> [NormSeg] {
		let data = try Data(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/golden/\(name).json"))
		return try JSONDecoder().decode([NormSeg].self, from: data)
	}

	static func manifest() throws -> Manifest {
		let data = try Data(contentsOf: repoRoot.appending(path: "Tests/Fixtures/dom/manifest.json"))
		return try JSONDecoder().decode(Manifest.self, from: data)
	}
}

// driver：以真 getComputedStyle 跑採集、回 normalize 後 JSON（與跑道 A helpers.normalize 同欄位）。
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

// MARK: - WKNavigationDelegate（loadHTMLString 完成回呼）

private final class NavDelegate: NSObject, WKNavigationDelegate {
	var onFinish: (() -> Void)?

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		onFinish?()
	}
}

// MARK: - 測試

@MainActor
final class CollectWebKitTests: XCTestCase {

	private func load(_ webView: WKWebView, html: String) async {
		let delegate = NavDelegate()
		webView.navigationDelegate = delegate
		await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
			delegate.onFinish = { cont.resume() }
			webView.loadHTMLString(html, baseURL: nil)
		}
		// 保留 delegate 強參考至導航完成（navigationDelegate 為 weak）。
		withExtendedLifetime(delegate) {}
	}

	private func collect(fixture name: String) async throws -> [NormSeg] {
		let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
		await load(webView, html: try Source.fixtureHTML(name))
		_ = try await webView.evaluateJavaScript(Source.contentJS())
		let json = try await webView.evaluateJavaScript(driverJS) as? String ?? "[]"
		return try JSONDecoder().decode([NormSeg].self, from: Data(json.utf8))
	}

	// 所有 lane b / both fixture：真 WebKit 採集對齊 golden（§11.1 both case 過同一份 golden）。
	func testFixturesAgainstGolden() async throws {
		let cases = try Source.manifest().cases.filter { $0.lane == "b" || $0.lane == "both" }
		XCTAssertFalse(cases.isEmpty, "manifest 無 b/both case")
		for c in cases {
			let got = try await collect(fixture: c.name)
			let want = try Source.golden(c.name)
			XCTAssertEqual(got, want, "fixture \(c.name)（\(c.desc)）與 golden 不符")
		}
	}

	// SPEC §1 實測基準 smoke：照抄者以此為準的關鍵值，對齊真 WebKit。
	func testDisplayBaselineSmoke() async throws {
		let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
		let html = "<div style='display:flex'><span id='ib' style='display:inline-block'>x</span></div>"
			+ "<ruby>漢<rt id='rt'>k</rt></ruby>"
		await load(webView, html: html)
		let ib = try await webView.evaluateJavaScript(
			"getComputedStyle(document.getElementById('ib')).display") as? String
		let rt = try await webView.evaluateJavaScript(
			"getComputedStyle(document.getElementById('rt')).display") as? String
		XCTAssertEqual(ib, "block", "inline-block 在 flex 容器內被 blockify（SPEC §1 A1）")
		XCTAssertEqual(rt, "ruby-text", "rt → ruby-text（真 WKWebView/系統 WebKit 實證；SPEC §1 A3 的 Playwright 值 inline 在系統 WebKit 不成立）")
	}
}
