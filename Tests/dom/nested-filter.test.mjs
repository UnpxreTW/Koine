// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：§6.2 extractText 的遞迴路徑要套用 §3 的過濾結果。
//
// 段的文字由 extractText 從 buffer 取出，buffer 裡的 inline 元素再由 appendNode 遞迴展開。
// 走訪層（collect）會整棵跳過 SKIP_SUBTREE 的子樹，但那條遞迴只看 tagName——於是同一份
// markup 會因為擺在哪個位置而行為不同：直接掛在 block 容器底下就被濾掉，包進一層 inline
// 就整棵被取進 source 送出去。本檔的每條測試都把同一段 markup 擺在這兩個位置上比對。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { collect } from "./helpers.mjs";

/** 造 doc（body 內塞 html 片段）。 */
function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

/** 收段並回 source 陣列（文件序）。 */
function sourcesOf(html) {
	return collect(docOf(html)).map((s) => s.source);
}

/** 同一段 markup 的兩種擺法：①直接掛在 block 容器底下 ②多包一層 inline。 */
function bothPositions(inner) {
	return {
		flat: sourcesOf(`<p>alpha ${inner} beta</p>`),
		nested: sourcesOf(`<p><em>alpha ${inner} beta</em></p>`),
	};
}

/** 每一項都是「內容作者或使用者明示不該送出去」的東西（§3.1 / §3.5 / §3.7）。 */
const SKIPPED_MARKUP = [
	["aria-hidden", '<span aria-hidden="true">LEAKED</span>'],
	["hidden 屬性", "<span hidden>LEAKED</span>"],
	["display:none", '<span data-d="none">LEAKED</span>'],
	["視覺隱藏 class（sr-only）", '<span class="sr-only">LEAKED</span>'],
	["translate=no", '<span translate="no">LEAKED</span>'],
	["script 原始碼", "<script>var LEAKED = 1;</script>"],
	["textarea 使用者輸入", "<textarea>LEAKED</textarea>"],
	["自家插回的舊譯文", '<span class="koine-translated">LEAKED</span>'],
	["自家標記節點", "<span data-koine-id=\"k1-0\">LEAKED</span>"],
];

for (const [name, inner] of SKIPPED_MARKUP) {
	test(`位置不改變過濾結果：${name}`, () => {
		const { flat, nested } = bothPositions(inner);
		assert.deepEqual(flat, ["alpha beta"], "直接掛在 block 容器底下時本來就被走訪層濾掉");
		assert.deepEqual(nested, ["alpha beta"], "包進一層 inline 之後同樣要被濾掉");
	});
}

test("protectedSpan 位移跟著過濾走：被濾掉的文字不計入 offset", () => {
	// code 是 OPAQUE_INLINE、其 textContent 原子併入段落並記下 [start, end)。
	// 若被過濾的內容仍混進文字，這組位移就會往後推、指到錯的字。
	// （fixture 刻意不留會被空白正規化折疊的間隔，好讓位移可以直接拿 source 驗。）
	const segs = collect(docOf('<p><em>alpha <span hidden>LEAKED</span><code>fn()</code> beta</em></p>'));
	assert.equal(segs.length, 1);
	const { source, meta } = segs[0];
	assert.equal(source, "alpha fn() beta");
	assert.deepEqual(meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
	assert.equal(source.slice(6, 10), "fn()");
});

test("被濾掉的只有該子樹：同一層的其他 inline 照常取進 source", () => {
	assert.deepEqual(
		sourcesOf('<p><em>keep one <span aria-hidden="true">LEAKED</span> <b>keep two</b> keep three</em></p>'),
		["keep one keep two keep three"],
	);
});

test("巢狀多層 inline 底下的過濾子樹一樣不取", () => {
	assert.deepEqual(
		sourcesOf('<p><em>outer <b>inner <span hidden>LEAKED</span> tail</b> end</em></p>'),
		["outer inner tail end"],
	);
});

test("ruby 注音仍只取 base（原本就由 tag 特判處理、不受過濾改動影響）", () => {
	assert.deepEqual(
		sourcesOf("<p><em>before <ruby>漢<rt>kan</rt></ruby> after</em></p>"),
		["before 漢 after"],
	);
});
