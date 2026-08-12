// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 合成頁與 benchmark 計數的把關（§11.4）。
//
// benchmark 的兩類數字只有一類適合進 CI：計數是定值、跨機一致；wall-clock 不是，
// 拿它當 CI 門檻只會在 runner 忙的時候紅。所以時間留在 `npm run bench`（人工、同機比對），
// 「精確值、變動即 fail」的部分放這裡，跟著一般測試跑。
//
// **這組斷言只有單向效力**：計數變了就一定是行為變了；計數沒變**不**保證行為沒變——
// 它只覆蓋所量的那幾個面向。例如只改譯文插回位置、只改 skipReason 字串，這裡不會紅。
// 計數面因此刻意鋪寬（段數／取 style 次數／原文總字數／狀態與區域分佈／button 段數／
// protected span 數），但別把它當成採集層的完整回歸網——那是既有 fixture 測試的職責。
//
// 實測過的鑑別力（改壞 content.js 看這裡會不會紅）：`<br>` 換行處置、button 原地換字的
// 字數上限、min-length 門檻、numeric 過濾、`display:contents` 攤平、`SKIP_SUBTREE_TAGS`
// 成員、`OPAQUE_INLINE_TAGS` 成員——都會紅。區域分類只抓得到粗變動（把評分結果整個
// 翻面會動 1 段）；平手規則、link-density 門檻這類細調在這頁上不會紅，別指望。
//
// 數字本身沒有理論推導，就是現況快照。改動採集規則時它們會紅——那正是重點：
// 停下來確認變化是照預期發生的，再一併更新這裡與 Tools/bench-baseline.json。
//
// 注意這組常數同時鎖住 linkedom 的解析行為（`package.json` 的 `^0.18.12`、CI 走
// `npm ci` 吃 lock）。若哪天升版後這裡紅了，先確認是採集層變了還是解析器變了。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { generateSyntheticPage } from "../../Tools/gen-synthetic-page.mjs";
import { runOnce, countersFor, BASELINE_PATH, DEFAULTS } from "../../Tools/bench.mjs";

// 現況快照：seed 1、預設 60 節。
const EXPECTED = {
	segmentCount: 505,
	computedStyleCalls: 881,
	sourceChars: 26837,
	buttonSegments: 8,
	protectedSpans: 27,
	"state.pending": 462,
	"state.skipped": 43,
	"region.main": 480,
	"region.chrome": 25,
};

// 第二個資料點：真實頁面量級（約 200 段），確保計數變動不是只在單一頁面大小上成立。
const EXPECTED_SMALL = {
	segmentCount: 199,
	computedStyleCalls: 355,
	sourceChars: 10579,
	buttonSegments: 3,
	protectedSpans: 9,
	"state.pending": 186,
	"state.skipped": 13,
	"region.main": 174,
	"region.chrome": 25,
};

/** key 順序不入斷言（比對只看鍵值對）。 */
function sortedEntries(obj) {
	return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

test("合成頁：同種子逐字相同（基準可進版控的前提）", () => {
	const a = generateSyntheticPage({ seed: 1, sections: 12 });
	const b = generateSyntheticPage({ seed: 1, sections: 12 });
	assert.equal(a, b);
});

test("合成頁：不同種子產不同頁（種子真的有在用）", () => {
	const a = generateSyntheticPage({ seed: 1, sections: 12 });
	const b = generateSyntheticPage({ seed: 2, sections: 12 });
	assert.notEqual(a, b);
});

test("合成頁：不含尚未定案的結構（translate 屬性與簡中來源）", () => {
	const html = generateSyntheticPage({ seed: 1, sections: 60 });
	// §13 #1／#2 尚未定案：這兩軸一旦定下來段數就會變，不能讓一個還會變的答案決定基準值。
	assert.equal(/translate\s*=/.test(html), false);
	assert.equal(/\blang\s*=/.test(html), false);
});

// 這是結構清單、不是鑑別力宣稱：跑道 A 的 getStyle 是 stub，FORCE_BLOCK 系標籤
// （li／main／nav／button…）本來就會被 stub 判成 block，改動它們在此看不出差異。
// 真正有鑑別力的部分由下面的計數斷言負責。
test("合成頁結構清單：預期出現的標籤都在", () => {
	const html = generateSyntheticPage({ seed: 1, sections: 60 });
	for (const marker of [
		"<main>", "<nav>", "<aside>", "<footer>", "<li>", "<table>",
		"<button>", "<script>", "<br>", 'data-d="contents"', 'data-d="none"', "<code>",
	]) {
		assert.ok(html.includes(marker), `合成頁缺少 ${marker}`);
	}
});

test("採集計數為定值（§11.4 精確值、變動即 fail）", () => {
	assert.deepEqual(sortedEntries(countersFor({ seed: 1, sections: 60 })), sortedEntries(EXPECTED));
	assert.deepEqual(sortedEntries(countersFor({ seed: 1, sections: 24 })), sortedEntries(EXPECTED_SMALL));
});

test("採集不帶輪次相依狀態：同一份 body 連跑兩次計數相同", () => {
	const body = generateSyntheticPage({ seed: 1, sections: 24 });
	const first = runOnce(body);
	const second = runOnce(body);
	assert.deepEqual(second.counters, first.counters);
});

test("bench 基準檔的計數與現況一致（基準不會默默過期）", () => {
	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
	assert.equal(baseline.input.seed, DEFAULTS.seed);
	assert.equal(baseline.input.sections, DEFAULTS.sections);
	assert.deepEqual(sortedEntries(baseline.counters), sortedEntries(EXPECTED));
});
