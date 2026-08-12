// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：OPAQUE_INLINE（<code>／<time>）的過濾兩件事。
//
// ①**自身**命中過濾訊號時要跳掉——原本 classifyNode 把 OPAQUE 決策排在屬性隱藏／translate-no／
//   display 閘之前，於是 `<code aria-hidden>`／`<time hidden>`／`display:none` 的 code/time 自身
//   被 OPAQUE 短路、過濾訊號失效而外送（同訊號的 <span> 則正確跳掉）。判定順序改為過濾閘先跑。
// ②**子樹內**被過濾的內容不得混進不可分割原子——OPAQUE 原本整包取 el.textContent，不看子代 disp，
//   於是巢在 code/time 內的 aria-hidden／hidden 等內容仍被送出。改為對子樹也套走訪層過濾。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { collect } from "./helpers.mjs";

function docOf(html) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}
function sourcesOf(html) {
	return collect(docOf(html)).map((s) => s.source);
}

// ── ① code/time 自身命中過濾訊號 → 不採集 ──────────────────────────────────

/** 每一項都是「明示不該送出」的訊號（§3.1 / §3.5 / §3.7）；`data-d` 是跑道 A 的 display stub。 */
const SELF_FILTER = [
	["aria-hidden", 'aria-hidden="true"'],
	["hidden 屬性", "hidden"],
	["display:none", 'data-d="none"'],
	["視覺隱藏 class（sr-only）", 'class="sr-only"'],
	["translate=no", 'translate="no"'],
];

for (const [name, attr] of SELF_FILTER) {
	for (const tag of ["code", "time"]) {
		test(`OPAQUE 自身過濾：<${tag} ${name}> 不得被採集外送`, () => {
			assert.deepEqual(
				sourcesOf(`<p>alpha <${tag} ${attr}>LEAK</${tag}> beta</p>`),
				["alpha beta"],
				`<${tag}> 自身命中過濾訊號應整棵跳、不因 OPAQUE 決策搶先而外送`,
			);
			// 對照：同訊號掛在非 opaque 的 <span> 上本來就正確跳掉——證明修的是 opaque 那條短路。
			assert.deepEqual(
				sourcesOf(`<p>alpha <span ${attr}>LEAK</span> beta</p>`),
				["alpha beta"],
				`<span> 對照組`,
			);
		});
	}
}

test("OPAQUE 自身無過濾訊號時照常採集（對照、確認不是整條軸壞掉）", () => {
	assert.deepEqual(sourcesOf("<p>alpha <code>fn()</code> beta</p>"), ["alpha fn() beta"]);
	assert.deepEqual(sourcesOf("<p>alpha <time>2026</time> beta</p>"), ["alpha 2026 beta"]);
});

// ── ② code/time 子樹內被過濾的內容不外送 ──────────────────────────────────

test("OPAQUE 子樹過濾：<code> 內被濾掉的內容不外送、且位置無關（flat 與 nested）", () => {
	// 卡片 fixture：兩種擺法都要把 LEAK 濾掉、只留 fn()。
	assert.deepEqual(
		sourcesOf('<p>alpha <code>fn(<span aria-hidden="true">LEAK</span>)</code> beta</p>'),
		["alpha fn() beta"],
	);
	assert.deepEqual(
		sourcesOf('<p><em>alpha <code>fn(<span aria-hidden="true">LEAK</span>)</code> beta</em></p>'),
		["alpha fn() beta"],
	);
});

test("OPAQUE 子樹過濾：protectedSpan 涵蓋過濾後範圍、位移正確", () => {
	const segs = collect(docOf('<p>alpha <code>fn(<span hidden>LEAK</span>)</code> beta</p>'));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "alpha fn() beta");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
	assert.equal(segs[0].source.slice(6, 10), "fn()");
});

test("OPAQUE 子樹過濾：巢狀多層 inline 底下的隱藏內容一樣不取", () => {
	assert.deepEqual(
		sourcesOf('<p>x <code>a<b>b<span hidden>LEAK</span>c</b>d</code> y</p>'),
		["x abcd y"],
	);
});

test("OPAQUE 子樹全被濾光 → 不記零寬 span、不產空原子", () => {
	const segs = collect(docOf('<p>alpha <time><span hidden>LEAK</span></time> beta</p>'));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "alpha beta", "time 貢獻空字串、空白正規化後與相鄰文字併齊");
	assert.deepEqual(segs[0].meta?.protectedSpans ?? [], [], "全濾光的原子不留 protectedSpan");
});
