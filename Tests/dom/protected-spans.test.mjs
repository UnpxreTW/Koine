// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §6.2 protectedSpans 位移基準：span 的 `[start, end)` 落在 `Segment.source`（正規化**後**）上，
// 不是 `extractText` 內部那條未正規化的字串。段身上只帶得走 `source`，位移記在另一側就指向一個
// 下游拿不到的字串。
//
// 三層：
// ①`normalizeSource` 的折疊語意——以改寫前的 regex 鏈當 oracle 對拍。實作從 regex 鏈換成單趟
//   掃描（掃描才產得出索引對照表），這層是「換實作不換行為」的釘子。
// ②索引對照表自身的不變式。
// ③段級契約：span 落在 `source` 上、`source.slice(start, end)` 取得到該 code/time 元素的內容。
//   ⚠ 邊界在元素文字以空白起訖時不對稱（塌縮出來的那個字元同時屬於相鄰文字，只能歸一邊），
//   完整說明在 `content.js` 的 `ProtectedSpan` JSDoc，本檔不重述第二套。
//
// 第③層期望值一律寫字面常數。要避開的是**以實際 span 反推 needle** 那種循環寫法
// （`source.slice(start, end)` 拿去跟自己比、或拿它當 `indexOf` 的 needle）——那種斷言恆真，
// 把 `remapSpansToSource` 改成原樣回傳也照樣全綠。
// （寫死 needle 的 `source.indexOf("useState()")` 倒是抓得到，只是字面常數更直接。）

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { koine, collect } from "./helpers.mjs";

function docFrom(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	return document;
}

/** `normalizeSource` 改寫前的 regex 鏈，逐字保留當 oracle。 */
function legacyNormalizeSource(text) {
	return text
		.replace(/[^\S\n]+/gu, " ")
		.replace(/ *\n */gu, "\n")
		.replace(/\n{2,}/gu, "\n")
		.trim();
}

const HAND_PICKED = [
	"", " ", "   ", "\n", "\n\n\n", "\t", "\r\n", " \n ", "\n \n", "\n\r",
	"a", " a ", "a  b", "a\n\nb", "a \n b", "a\r\nb", "a\tb\tc",
	"a b", "   a", "a b", "a　b", "\v\fa\v\f", "　全形空白　",
	"alpha   fn() beta", "\n\tCall useState()\n\tin React.\n", "中文 段落\n\t第二行 ",
	`${"a".repeat(50)}${"\n".repeat(5)}b`,
	// `\s` 涵蓋、但排版上看不見的幾個，一律寫碼位跳脫（寫字面值會被編輯器吃掉或正規化掉）：
	// ZWNBSP／行分隔／段落分隔／窄不斷行空格／Ogham 空格。
	"a\uFEFFb", "a\u2028b", "a\u2029b", "a\u202Fb", "a\u1680b", "a\u205Fb",
	"\uFEFF a \u2029", "a\u2028\u3000b", "\u202F\u205F", "a\u00A0\u2028b",
];

/** 決定性 PRNG（mulberry32）：語料每次跑都一樣，紅燈可重現。 */
function mulberry32(seed) {
	return function next() {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// 空白字元刻意重複，讓隨機串偏向多空白——折疊邏輯的邊界都在那裡。
const ALPHABET = [
	"a", "b", "文", "(", ")",
	" ", " ", " ", "\t", "\n", "\n", "\r", "\v", "\f",
	"\u00A0", "\u3000", "\uFEFF", "\u2028", "\u2029", "\u202F", "\u205F", "\u1680",
];

function generatedCorpus(count, maxLen) {
	const rand = mulberry32(20260805);
	const out = [];
	for (let i = 0; i < count; i++) {
		const len = Math.floor(rand() * maxLen);
		let s = "";
		for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
		out.push(s);
	}
	return out;
}

const CORPUS = [...HAND_PICKED, ...generatedCorpus(400, 24)];

const WS = /\s/u;

// ── ① 折疊語意 ──────────────────────────────────────────────────────────────

test("normalizeSource 與改寫前的 regex 鏈逐字等價", () => {
	for (const text of CORPUS) {
		assert.equal(koine.normalizeSource(text), legacyNormalizeSource(text), `輸入 ${JSON.stringify(text)}`);
	}
});

test("normalizeSource 折疊語意的絕對期望值（不從 oracle 推導）", () => {
	assert.equal(koine.normalizeSource("alpha   fn() beta"), "alpha fn() beta");
	assert.equal(koine.normalizeSource("   fn() tail"), "fn() tail");
	assert.equal(koine.normalizeSource("a \n\t b"), "a\nb", "run 內含換行 → 折成換行");
	assert.equal(koine.normalizeSource("a \t b"), "a b", "run 內無換行 → 折成空格");
	assert.equal(koine.normalizeSource("a\n\n\nb"), "a\nb", "多換行折成一個");
	assert.equal(koine.normalizeSource("   "), "", "純空白 → 空字串");
	assert.equal(koine.normalizeSource("a b"), "a b", "不斷行空格算空白、折成一般空格");
});

// ── ② 索引對照表 ────────────────────────────────────────────────────────────

test("索引對照表：兩個端點釘死（頭 → 0、哨兵格 → source.length）", () => {
	// 哨兵格是 span 的 `end` 唯一會落到的地方（code/time 收在段尾、後面沒有字時），
	// 而下面那條「值域 + 單調不減」的不變式對它太鬆：`source.length - 1` 也會過。
	for (const text of CORPUS) {
		const { source, map } = koine.normalizeSourceWithMap(text);
		const where = `輸入 ${JSON.stringify(text)}`;
		assert.equal(map[0], 0, `${where}：頭端未落在 0`);
		assert.equal(map[text.length], source.length, `${where}：哨兵格未落在 source.length`);
	}
});

test("索引對照表：與 normalizeSource 同源、長度 text.length + 1、單調不減、落在 [0, source.length]", () => {
	for (const text of CORPUS) {
		const { source, map } = koine.normalizeSourceWithMap(text);
		const where = `輸入 ${JSON.stringify(text)}`;
		// 與 oracle 比、不與 `normalizeSource` 比：後者跟本函式同一顆核心，只抓得到「填對照表把
		// 輸出寫壞」，抓不到核心自己折疊錯。
		assert.equal(source, legacyNormalizeSource(text), `${where}：帶對照表的輸出與 oracle 不符`);
		assert.equal(map.length, text.length + 1, `${where}：對照表長度不對`);
		for (let i = 0; i < map.length; i++) {
			assert.ok(Number.isInteger(map[i]), `${where}：map[${i}] 非整數`);
			assert.ok(map[i] >= 0 && map[i] <= source.length, `${where}：map[${i}]=${map[i]} 越界`);
			if (i > 0) assert.ok(map[i - 1] <= map[i], `${where}：map 在 ${i} 處回退`);
		}
	}
});

test("索引對照表：非空白字元換算後仍指向同一個字元", () => {
	// span 的兩個端點就是靠這條不變式落位——非空白字元不會被折疊也不會被 trim 掉，
	// 故原字串上的每個非空白字元在 source 上都找得到唯一對應位置。
	for (const text of CORPUS) {
		const { source, map } = koine.normalizeSourceWithMap(text);
		for (let i = 0; i < text.length; i++) {
			if (WS.test(text[i])) continue;
			assert.equal(source[map[i]], text[i], `輸入 ${JSON.stringify(text)}：原索引 ${i} 換算後指向別的字元`);
		}
	}
});

// ── ③ 段級契約 ──────────────────────────────────────────────────────────────

test("protectedSpans 落在 source 上：一般縮排寫法（絕對期望值）", () => {
	const segs = collect(docFrom("<p>\n\tCall <code>useState()</code>\n\tin React.\n</p>"));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].source, "Call useState()\nin React.");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 5, end: 15, kind: "code" }]);
});

test("protectedSpans 落在 source 上：code 收在段尾、end 落哨兵格（絕對期望值）", () => {
	// 段內最後一個節點就是 code、後面沒有任何字元 ⇒ `span.end === text.length`，會用到對照表的
	// 哨兵格；這也是最常見的真實寫法（句子講到某個 API 就結束）。
	// （`start` 也落得到哨兵格——段尾一個空的 code 就是 `start === end === text.length`。）
	const segs = collect(docFrom("<p>See <code>useState()</code></p>"));
	assert.equal(segs[0].source, "See useState()");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 4, end: 14, kind: "code" }]);
});

test("protectedSpans 落在 source 上：連續空白（絕對期望值）", () => {
	const segs = collect(docFrom("<p>alpha   <code>fn()</code> beta</p>"));
	assert.equal(segs[0].source, "alpha fn() beta");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
});

test("protectedSpans 落在 source 上：前導空白被 trim（絕對期望值）", () => {
	const segs = collect(docFrom("<p>   <code>fn()</code> tail</p>"));
	assert.equal(segs[0].source, "fn() tail");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 0, end: 4, kind: "code" }]);
});

test("protectedSpans 落在 source 上：br 換行前後的空白（絕對期望值）", () => {
	const segs = collect(docFrom("<p>alpha <br> <code>fn()</code> beta</p>"));
	assert.equal(segs[0].source, "alpha\nfn() beta");
	assert.deepEqual(segs[0].meta.protectedSpans, [{ start: 6, end: 10, kind: "code" }]);
});

test("protectedSpans 落在 source 上：同段多個 span 與 time（絕對期望值）", () => {
	const segs = collect(docFrom("<p>\n\t<code>a()</code>  and  <time>2026</time>\n</p>"));
	assert.equal(segs[0].source, "a() and 2026");
	assert.deepEqual(segs[0].meta.protectedSpans, [
		{ start: 0, end: 3, kind: "code" },
		{ start: 8, end: 12, kind: "time" },
	]);
});

test("protectedSpans 條數守恆：換算不新增也不丟棄", () => {
	// 只含空白的 code 在 source 上不留任何字元，換算成零長度區間——條數仍算一條。
	const segs = collect(docFrom("<p>alpha <code> </code> beta</p>"));
	assert.equal(segs[0].source, "alpha beta");
	assert.equal(segs[0].meta.protectedSpans.length, 1);
	const [span] = segs[0].meta.protectedSpans;
	assert.equal(span.start, span.end, "整段被折疊掉的 span → 零長度區間");
});

test("charCount 與 protectedSpans 同一個基準（都是 source）", () => {
	const segs = collect(docFrom("<p>\n\tCall <code>useState()</code>\n\tin React.\n</p>"));
	const { charCount, protectedSpans } = segs[0].meta;
	assert.equal(charCount, segs[0].source.length);
	for (const span of protectedSpans) assert.ok(span.end <= charCount, "span 不得越出 charCount");
});

test("extractText 自身仍回未正規化基準的位移（本函式的契約沒被一起改掉）", () => {
	// 換算發生在 makeSegmentFromBuffer，不在 extractText。這條釘住分工，免得日後有人以為
	// extractText 回的就是 source 基準。
	const document = docFrom("<p>alpha   <code>fn()</code> beta</p>");
	const p = document.querySelector("p");
	const { text, spans } = koine.extractText([...p.childNodes]);
	assert.equal(text, "alpha   fn() beta");
	assert.deepEqual(spans, [{ start: 8, end: 12, kind: "code" }]);
});
