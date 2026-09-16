// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §9.2 碎片軸的呼叫端手搭退路：insertTranslations 的 arriveFragment 在 `seg.anchor.fragmentGroup`
// 缺席時（呼叫端自己組出來的 segment、沒有經過採集期）改以一份「只活在本次呼叫內」的計畫接手，
// 以 block 為鍵存在 callScopedPlans、`total` 記 null、`blockSnapshot` 也記 null。
//
// 這條退路決定三件外顯行為：同一次呼叫內同顆 block 的碎片共用一份計畫（一起成立才寫、只推一次
// block）、計畫不跨呼叫（下一次呼叫從頭來過）、以及 block 級快照缺席時退回逐碎片檢查（block 內
// 非碎片文字被換掉不會連坐）。
//
// 既有測試的碎片一律來自 collectSegments，`anchor.fragmentGroup` 恆在 ⇒ 整段退路零執行
// （2026-09-16 coverage 一手：content.js:1918-1925 零命中）。2026-09-16 突變實測（基線 341 綠）：
// 拿掉整條退路、不共用同一份計畫、blockSnapshot 改記整顆 textContent，三種退化無本檔時皆 0 fail。
//
// 期望值一律由實跑取得，非從規則推導。**不動插回規則本身**（那是 production 改動、另一道閘）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, assertSame } from "./helpers.mjs";

function docFrom(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 呼叫端手搭一顆碎片段：帶 replace-text 錨點與逐字快照，但沒有採集期建立的 fragmentGroup。 */
function handBuiltFragment(id, block, textNode, draft) {
	return {
		id,
		order: 0,
		state: koine.SegmentState.DRAFTED,
		draft,
		source: textNode.nodeValue.trim(),
		anchor: { insertMode: "replace-text", block, textNode },
		meta: { replaceSnapshot: textNode.nodeValue },
	};
}

const SENTENCE = `<p id="p">简体<em>强调</em>段落。</p>`;

test("手搭碎片沒有兄弟數可等，到達即結算：原地換字並補上原文備份與防自吞標記", () => {
	const doc = docFrom(SENTENCE);
	const p = doc.getElementById("p");
	const inserted = koine.insertTranslations([handBuiltFragment("a", p, p.childNodes[0], "譯甲")]);

	assert.equal(p.textContent, "譯甲强调段落。");
	assert.equal(p.getAttribute("data-koine-original"), "简体强调段落。", "原文備份＝寫入前的完整原文");
	assert.equal(p.getAttribute("data-koine-translated"), "譯甲强调段落。", "防自吞標記＝寫入後的整顆 textContent");
	assert.equal(inserted.length, 1);
	assertSame(inserted[0], p, "回傳的是被換字的 block 自己、不是新建的 wrapper");
});

test("同一次呼叫、同顆 block 的兩顆手搭碎片共用一份計畫：一起寫、block 只推一次", () => {
	const doc = docFrom(SENTENCE);
	const p = doc.getElementById("p");
	const inserted = koine.insertTranslations([
		handBuiltFragment("a", p, p.childNodes[0], "譯甲"),
		handBuiltFragment("b", p, p.childNodes[2], "譯乙"),
	]);

	assert.equal(p.textContent, "譯甲强调譯乙");
	assert.equal(p.getAttribute("data-koine-translated"), "譯甲强调譯乙");
	assert.equal(inserted.length, 1, "兩顆碎片同屬一顆 block、結算一次");
});

test("計畫只活在本次呼叫內：分兩次送的碎片各自結算，原文備份仍是第一次寫入前的原文", () => {
	const doc = docFrom(SENTENCE);
	const p = doc.getElementById("p");

	koine.insertTranslations([handBuiltFragment("a", p, p.childNodes[0], "譯甲")]);
	assert.equal(p.textContent, "譯甲强调段落。", "第一次呼叫不等第二顆、直接寫");
	assert.equal(p.getAttribute("data-koine-original"), "简体强调段落。");

	koine.insertTranslations([handBuiltFragment("b", p, p.childNodes[2], "譯乙")]);
	assert.equal(p.textContent, "譯甲强调譯乙");
	assert.equal(p.getAttribute("data-koine-original"), "简体强调段落。", "已有備份不被半譯的中間態覆寫");
	assert.equal(p.getAttribute("data-koine-translated"), "譯甲强调譯乙", "標記跟著最後一次寫入刷新");
});

test("全有或全無照樣成立：同顆 block 一顆碎片 drift → 整顆一個字都不寫，另一顆 block 不受牽連", () => {
	const doc = docFrom(`<p id="p1">简体<em>强调</em>段落。</p><p id="p2">另一段。</p>`);
	const p1 = doc.getElementById("p1");
	const p2 = doc.getElementById("p2");
	const segs = [
		handBuiltFragment("a", p1, p1.childNodes[0], "譯甲"),
		handBuiltFragment("b", p1, p1.childNodes[2], "譯乙"),
		handBuiltFragment("c", p2, p2.childNodes[0], "譯丙"),
	];
	p1.childNodes[2].nodeValue = "站台換過的尾巴";

	const inserted = koine.insertTranslations(segs);

	assert.equal(p1.textContent, "简体强调站台換過的尾巴", "整顆放棄：沒 drift 的那顆也不寫");
	assert.ok(!p1.hasAttribute("data-koine-translated"), "放棄的 block 不留防自吞標記");
	assert.equal(p2.textContent, "譯丙", "另一顆 block 各自結算");
	assert.equal(inserted.length, 1);
});

test("缺 block 級快照 → 退回逐碎片檢查：非碎片文字被換掉不連坐，標記取寫入當下的現值", () => {
	const doc = docFrom(SENTENCE);
	const p = doc.getElementById("p");
	const seg = handBuiltFragment("a", p, p.childNodes[0], "譯甲");
	p.childNodes[1].textContent = "換過的強調";

	const inserted = koine.insertTranslations([seg]);

	assert.equal(p.textContent, "譯甲換過的強調段落。", "碎片自身的快照仍對得上 ⇒ 照寫");
	assert.equal(p.getAttribute("data-koine-translated"), "譯甲換過的強調段落。");
	assert.equal(inserted.length, 1);
});
