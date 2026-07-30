// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §3.6 / §4.9 classifyZhVariant 單元測試：中文書寫變體分類器的契約。
// 這支分類器是 isAlreadyTargetLang 與 detectPageLangIsZh 共用的單一真相，故本檔分兩層：
// ①分類器自身的邊界；②兩個呼叫端在同一批語碼上的**絕對**期望值。
//
// 第②層的期望值一律寫成字面常數、不從分類器結果推導——推導式期望值會與實作一起漂移：
// 把 zhVariantSatisfies 改成 `return true`（＝繁中目標吃下任何中文段，正是本檔要防的缺口）
// 時，推導式斷言全綠、抓不到。各呼叫端自身的完整契約仍在 already-target-lang.test.mjs 與
// lang-detect.test.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

const el = (lang) => ({ getAttribute: (name) => (name === "lang" ? lang : null) });

test("script 子標籤：Hant → hant、Hans → hans，大小寫不敏感", () => {
	assert.equal(koine.classifyZhVariant("zh-Hant"), "hant");
	assert.equal(koine.classifyZhVariant("zh-Hans"), "hans");
	assert.equal(koine.classifyZhVariant("ZH-HANT-TW"), "hant");
	assert.equal(koine.classifyZhVariant("  zh-hans  "), "hans", "容許前後空白");
	assert.equal(koine.classifyZhVariant("zh_TW"), "hant", "底線分隔正規化（Apple locale identifier 形）");
});

test("script 優先於地區、且位置無關", () => {
	assert.equal(koine.classifyZhVariant("zh-Hans-MO"), "hans");
	assert.equal(koine.classifyZhVariant("zh-Hant-CN"), "hant");
	assert.equal(koine.classifyZhVariant("zh-cmn-Hans-CN"), "hans", "extlang 形：script 不在位置 1");
	assert.equal(koine.classifyZhVariant("zh-hk-hans"), "hans", "順序顛倒的畸形標籤仍以 script 為準");
});

test("缺 script 時看地區：TW/HK/MO → hant，CN/SG/MY → hans", () => {
	assert.equal(koine.classifyZhVariant("zh-TW"), "hant");
	assert.equal(koine.classifyZhVariant("zh-HK"), "hant");
	assert.equal(koine.classifyZhVariant("zh-MO"), "hant");
	assert.equal(koine.classifyZhVariant("zh-CN"), "hans");
	assert.equal(koine.classifyZhVariant("zh-SG"), "hans");
	assert.equal(koine.classifyZhVariant("zh-MY"), "hans");
});

test("只有裸 zh 是 'zh'（明確未指明書寫系統）", () => {
	assert.equal(koine.classifyZhVariant("zh"), "zh");
});

test("認不出書寫系統的中文標籤 → unknown，不併進 'zh'", () => {
	// 併進 'zh' 會讓「未指明 → 視為已達繁中目標」的豁免變成萬用桶，整頁不翻的缺口就換個
	// 標籤形狀復活。以下每一個在修前的 detectPageLangIsZh 都是 false，不得因本次重構翻成 true。
	assert.equal(koine.classifyZhVariant("zh-CHS"), "unknown", ".NET 遺留簡體碼、非標準 script");
	assert.equal(koine.classifyZhVariant("zh-CHT"), "unknown");
	assert.equal(koine.classifyZhVariant("zh-XX"), "unknown", "未收錄的地區不猜");
	assert.equal(koine.classifyZhVariant("zh-Latn"), "unknown", "明示非漢字 script → 地區提示失效");
	assert.equal(koine.classifyZhVariant("zh-Latn-TW"), "unknown");
	assert.equal(koine.classifyZhVariant("zh-Hani"), "unknown", "泛漢字 script 本身不分簡繁");
	assert.equal(koine.classifyZhVariant("zh-x-private"), "unknown", "private-use 不描述書寫系統");
	assert.equal(koine.classifyZhVariant("zh-hansx"), "unknown", "script 需完全相等、非前綴比對");
	assert.equal(koine.classifyZhVariant("zh-"), "unknown", "尾綴連字號");
});

test("非中文標籤 → null（不是 'zh' 這個變體、是根本不參與比對）", () => {
	assert.equal(koine.classifyZhVariant("ja"), null);
	assert.equal(koine.classifyZhVariant("en-US"), null);
	assert.equal(koine.classifyZhVariant("yue-HK"), null, "粵語 primary subtag 非 zh、目前不收");
	assert.equal(koine.classifyZhVariant("zhx"), null, "primary subtag 需完全相等、非前綴比對");
});

test("空值與無效輸入 → null", () => {
	assert.equal(koine.classifyZhVariant(null), null);
	assert.equal(koine.classifyZhVariant(undefined), null);
	assert.equal(koine.classifyZhVariant(""), null);
	assert.equal(koine.classifyZhVariant("   "), null);
});

// ── 呼叫端的絕對期望值（字面常數、不從分類器推導）────────────────────────────

/** lang 屬性 → detectPageLangIsZh 的期望值。 */
const PAGE_LANG_IS_ZH = [
	["zh-Hant", true], ["zh-TW", true], ["zh-HK", true], ["zh-MO", true], ["zh", true],
	["ZH-HANT-TW", true], ["zh_TW", true],
	["zh-CN", false], ["zh-Hans", false], ["zh-Hans-CN", false], ["zh-Hans-MO", false],
	["zh-SG", false], ["zh-cmn-Hans-CN", false],
	["zh-CHS", false], ["zh-CHT", false], ["zh-XX", false], ["zh-Latn", false], ["zh-x-private", false],
	["en", false], ["ja", false],
];

test("detectPageLangIsZh：整頁 lang 判定（絕對期望值）", () => {
	for (const [tag, expected] of PAGE_LANG_IS_ZH) {
		assert.equal(koine.detectPageLangIsZh(tag), expected, `detectPageLangIsZh("${tag}")`);
	}
});

/** 元素 lang → 繁中目標下 isAlreadyTargetLang 的期望值。 */
const ALREADY_TARGET_FOR_HANT = [
	["zh-Hant", true], ["zh-TW", true], ["zh-HK", true], ["zh-MO", true], ["zh", true],
	["zh-CN", false], ["zh-Hans", false], ["zh-Hans-MO", false], ["zh-SG", false],
	["zh-CHS", false], ["zh-Latn", false], ["zh-XX", false],
	["en", false], ["ja", false],
];

/** 所有繁中目標語碼；判定粒度＝書寫系統，故它們對同一批段必須給出同一組答案。 */
const HANT_TARGETS = ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW", "zh"];

test("isAlreadyTargetLang：所有繁中目標語共用同一組絕對期望值", () => {
	for (const [lang, expected] of ALREADY_TARGET_FOR_HANT) {
		for (const target of HANT_TARGETS) {
			assert.equal(
				koine.isAlreadyTargetLang(el(lang), target),
				expected,
				`lang=${lang} target=${target}`,
			);
		}
	}
});
