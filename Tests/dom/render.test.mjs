// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：並列插回 render 層（insertTranslations）測試。
// collect → 塞假 draft → insertTranslations → 比對 DOM 結構，並驗 §7.1 自吞 / 原文不變式。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine, loadFixture, collect, normalize } from "./helpers.mjs";

// 涵蓋 basic / mixed-inline / nested / list-items / inline 收尾（驗 block 落點）。
const RENDER_FIXTURES = [
	"01-basic-paragraphs",
	"02-mixed-inline",
	"03-nested-div",
	"04-list-items",
	"18-inline-tail-anchor",
];

const DRAFT = (s) => `譯文‹${s.source}›`;

/** 把 pending 段塞假 draft + 轉 drafted（模擬 B/C 填譯；render 只消費 drafted）。 */
function draftPending(segs, render = DRAFT) {
	for (const s of segs) {
		if (s.state === koine.SegmentState.PENDING) {
			s.draft = render(s);
			s.state = koine.SegmentState.DRAFTED;
		}
	}
	return segs;
}

/** 斷言單一 drafted 段的 wrapper：位置（block 緊鄰後）+ 標記 + 文字。 */
function assertWrapper(doc, seg) {
	const wrapper = doc.querySelector(`[data-koine-id="${seg.id}"]`);
	assert.ok(wrapper, `seg ${seg.id} 無 wrapper`);
	assert.equal(wrapper.tagName, "DIV", "wrapper 應為 div（M1 block 元素）");
	assert.ok(wrapper.classList.contains("koine-translated"), "wrapper 缺 koine-translated class");
	assert.equal(wrapper.getAttribute("data-koine-id"), seg.id, "data-koine-id 不符 seg.id");
	assert.equal(wrapper.textContent, seg.draft, "wrapper 文字 ≠ 假譯文");
	assert.equal(seg.anchor.block.nextSibling, wrapper, "wrapper 不在原文 block 緊鄰之後");
}

for (const name of RENDER_FIXTURES) {
	test(`render 結構 — ${name}`, () => {
		const doc = loadFixture(name);
		const segs = draftPending(collect(doc));
		const inserted = koine.insertTranslations(segs);
		const drafted = segs.filter((s) => s.state === koine.SegmentState.DRAFTED);
		assert.equal(inserted.length, drafted.length, "插入 wrapper 數 ≠ drafted 段數");
		for (const seg of drafted) assertWrapper(doc, seg);
	});
}

test("render block 落點 — inline 收尾段 anchor 落 block 容器、非 inline 父（漂移②）", () => {
	const doc = loadFixture("18-inline-tail-anchor");
	const segs = collect(doc);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].anchor.block.tagName, "P", "anchor.block 應為 p、非 inline 父 span");
	draftPending(segs);
	koine.insertTranslations(segs);
	const wrapper = doc.querySelector(`[data-koine-id="${segs[0].id}"]`);
	assert.equal(wrapper.parentNode.tagName, "BODY", "wrapper 應插在 p 同層（body），非 span 內");
	assert.equal(doc.querySelector("p").nextSibling, wrapper, "wrapper 應緊鄰 p 之後");
});

test("render 只消費 drafted：skipped 段不插（state 閘、非看 draft 有無）— 07-worth-numeric-skip", () => {
	const doc = loadFixture("07-worth-numeric-skip");
	const segs = collect(doc);
	const skipped = segs.filter((s) => s.state === koine.SegmentState.SKIPPED);
	assert.ok(skipped.length >= 1, "fixture 應含至少一個 skipped 段");
	// 對所有段（含 skipped）塞 draft，但只把 pending→drafted；skipped 維持 skipped。
	for (const s of segs) s.draft = `X‹${s.source}›`;
	draftPending(segs);
	const inserted = koine.insertTranslations(segs);
	for (const s of skipped) {
		assert.equal(
			doc.querySelector(`[data-koine-id="${s.id}"]`), null,
			`skipped 段 ${s.id} 不得有 wrapper（即使 draft 已填）`,
		);
	}
	const drafted = segs.filter((s) => s.state === koine.SegmentState.DRAFTED);
	assert.equal(inserted.length, drafted.length, "插入數應 = drafted 數");
});

test("自吞不變式：render 後再採集 → 0 新段、與原採集等價（§7.1 c）", () => {
	for (const name of RENDER_FIXTURES) {
		const doc = loadFixture(name);
		const segs = collect(doc);
		const before = normalize(segs);
		draftPending(segs);
		koine.insertTranslations(segs);
		const after = normalize(collect(doc));
		assert.deepEqual(after, before, `${name}: 再採集應與原採集等價（wrapper 全被 classifyNode [1] 擋）`);
	}
});

test("原文不變式：render 不改原文 block 節點（§7.1 b）", () => {
	for (const name of RENDER_FIXTURES) {
		const doc = loadFixture(name);
		const segs = collect(doc);
		const blocksBefore = segs.map((s) => s.anchor.block.outerHTML);
		draftPending(segs);
		koine.insertTranslations(segs);
		const blocksAfter = segs.map((s) => s.anchor.block.outerHTML);
		assert.deepEqual(blocksAfter, blocksBefore, `${name}: 原文 block outerHTML 被改動`);
	}
});
