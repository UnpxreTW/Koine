// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§6.5 classifyRegion 區域分類測試。
// cascade：最近 landmark 祖先（含自身）→ ARIA role → 無 landmark 三訊號評分 → 預設 MAIN；
// 並驗「採集下行增量版（walkAndLabel stack）≡ walk-up 版（classifyRegion）」等價不變式。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, loadFixture, collect, stubGetStyle } from "./helpers.mjs";

const R = koine.Region;

/** 造 doc（body 內塞 html 片段）。 */
function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 收段並回 source → region 對照表。 */
function regionsBySource(doc) {
	const map = new Map();
	for (const s of collect(doc)) map.set(s.source, s.region);
	return map;
}

test("landmark tag：main/article → MAIN；nav/header/footer/aside → CHROME（§6.5 cascade 1）", () => {
	const doc = docOf(
		"<main><p>Main body paragraph text</p></main>"
		+ "<article><p>Article body paragraph text</p></article>"
		+ "<nav><a href='#'>Navigation link text</a></nav>"
		+ "<header><p>Header tagline text</p></header>"
		+ "<footer><p>Footer copyright text</p></footer>"
		+ "<aside><p>Aside promo text</p></aside>",
	);
	const r = regionsBySource(doc);
	assert.equal(r.get("Main body paragraph text"), R.MAIN);
	assert.equal(r.get("Article body paragraph text"), R.MAIN);
	assert.equal(r.get("Navigation link text"), R.CHROME);
	assert.equal(r.get("Header tagline text"), R.CHROME);
	assert.equal(r.get("Footer copyright text"), R.CHROME);
	assert.equal(r.get("Aside promo text"), R.CHROME);
});

test("ARIA role：role=main/article → MAIN；navigation/banner/contentinfo/complementary/search → CHROME；role 先於 tag", () => {
	const doc = docOf(
		"<div role='main'><p>Role main paragraph text</p></div>"
		+ "<div role='article'><p>Role article paragraph text</p></div>"
		+ "<div role='navigation'><a href='#'>Role navigation link</a></div>"
		+ "<div role='banner'><p>Role banner text here</p></div>"
		+ "<div role='contentinfo'><p>Role contentinfo text here</p></div>"
		+ "<div role='complementary'><p>Role complementary text</p></div>"
		+ "<div role='search'><p>Role search label text</p></div>"
		+ "<nav role='main'><p>Nav with role main text</p></nav>", // 顯式 ARIA 覆蓋隱式語意
	);
	const r = regionsBySource(doc);
	assert.equal(r.get("Role main paragraph text"), R.MAIN);
	assert.equal(r.get("Role article paragraph text"), R.MAIN);
	assert.equal(r.get("Role navigation link"), R.CHROME);
	assert.equal(r.get("Role banner text here"), R.CHROME);
	assert.equal(r.get("Role contentinfo text here"), R.CHROME);
	assert.equal(r.get("Role complementary text"), R.CHROME);
	assert.equal(r.get("Role search label text"), R.CHROME);
	assert.equal(r.get("Nav with role main text"), R.MAIN);
});

test("最近 landmark 祖先勝：<article><nav>（頁內 TOC）判 CHROME、<nav><article> 判 MAIN（與 Read Frog 的既定分歧）", () => {
	const doc = docOf(
		"<article><nav><a href='#'>Table of contents entry</a></nav><p>Article body text after toc</p></article>"
		+ "<nav><article><p>Article card inside nav</p></article></nav>",
	);
	const r = regionsBySource(doc);
	assert.equal(r.get("Table of contents entry"), R.CHROME, "article 內 TOC 應降權（最近 nav 勝）");
	assert.equal(r.get("Article body text after toc"), R.MAIN);
	assert.equal(r.get("Article card inside nav"), R.MAIN, "nav 內 article 卡片（最近 article 勝）");
});

test("無 landmark heuristic 訊號①：class/id regex（含祖先最近 hint）", () => {
	const doc = docOf(
		"<div class='sidebar'><p>Sidebar widget text here</p></div>"
		+ "<div id='content'><p>Content area body text</p></div>"
		+ "<div class='breadcrumb'><span>Breadcrumb trail text</span></div>",
	);
	const r = regionsBySource(doc);
	assert.equal(r.get("Sidebar widget text here"), R.CHROME);
	assert.equal(r.get("Content area body text"), R.MAIN);
	assert.equal(r.get("Breadcrumb trail text"), R.CHROME);
});

test("無 landmark heuristic 訊號②：link-density > 0.5 → CHROME；低密度長文 → MAIN", () => {
	const links = "<div><a href='#'>First link label</a> <a href='#'>Second link label</a> <a href='#'>Third link label</a></div>";
	const prose = "<div><p>This is a long enough paragraph of running prose text that contains "
		+ "<a href='#'>one link</a> but is dominated by plain sentence content well above the length gate.</p></div>";
	const r = regionsBySource(docOf(links + prose));
	assert.equal([...r.values()][0], R.CHROME, "純連結列 link-density 高 → CHROME");
	assert.equal([...r.values()][1], R.MAIN, "低密度長文 → MAIN");
});

test("無 landmark heuristic 訊號③＋預設：>120 字 → MAIN；<40 字 → CHROME；中段零訊號 → MAIN（非對稱預設）", () => {
	const long = `<div><p>${"long ".repeat(30).trim()}</p></div>`;             // 149 字 → MAIN
	const short = "<div><p>Tiny label</p></div>";                              // 10 字 → CHROME
	const mid = "<div><p>A medium length sentence with about seventy characters in it, yes.</p></div>"; // 40–120 → 零訊號 → MAIN
	const r = [...regionsBySource(docOf(long + short + mid)).values()];
	assert.deepEqual(r, [R.MAIN, R.CHROME, R.MAIN]);
});

test("skipped 段也帶 region（IR §9.1：region 為 v1 top-level 欄、所有段都有）", () => {
	const doc = loadFixture("07-worth-numeric-skip");
	const segs = collect(doc);
	assert.ok(segs.length > 0);
	for (const s of segs) {
		assert.ok(s.region === R.MAIN || s.region === R.CHROME, `段 ${s.id}（${s.state}）缺 region`);
	}
});

test("等價不變式：採集下行增量版 region ≡ classifyRegion(anchor.block) walk-up 版", () => {
	const fixtures = ["01-basic-paragraphs", "02-mixed-inline", "04-list-items", "11-block-in-inline"];
	for (const name of fixtures) {
		const segs = collect(loadFixture(name));
		for (const s of segs) {
			assert.equal(
				s.region, koine.classifyRegion(s.anchor.block),
				`fixture ${name} 段 ${s.id}：增量版與 walk-up 版分歧`,
			);
		}
	}
	// landmark 混排頁也驗一輪（含 TOC 巢狀）
	const doc = docOf(
		"<header><p>Site header tagline</p></header>"
		+ "<main><p>Primary content paragraph text goes here</p>"
		+ "<nav><a href='#'>Inline toc entry</a></nav></main>"
		+ "<div class='footer-widget'><p>Widget text</p></div>",
	);
	const ctx = koine.makeContext({ getStyle: stubGetStyle });
	for (const s of koine.collectSegments(doc.body, ctx, { walkId: 1 })) {
		assert.equal(s.region, koine.classifyRegion(s.anchor.block), `段 ${s.id}：增量版與 walk-up 版分歧`);
	}
});
