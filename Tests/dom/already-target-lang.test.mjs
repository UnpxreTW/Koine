// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §3.6 isAlreadyTargetLang 單元測試：驗函式真的依傳入的 targetLang 判斷（非硬編 zh）。
// 迴歸鎖定：呼叫端 classifyNode 傳兩參 isAlreadyTargetLang(el, ctx.targetLang)，
// 若定義端第二參被丟棄，非 zh 目標語時「元素自身 lang 已達標」會判斷錯誤。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

function el(lang) {
	return { getAttribute: (name) => (name === "lang" ? lang : null) };
}

test("zh-Hant 目標：el lang=zh-Hant/zh/zh-TW → true", () => {
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hant"), "zh-Hant"), true);
	assert.equal(koine.isAlreadyTargetLang(el("zh"), "zh-Hant"), true);
	assert.equal(koine.isAlreadyTargetLang(el("zh-TW"), "zh-Hant"), true);
});

test("zh-Hant 目標：el lang=zh-CN/zh-Hans → false（簡中不視為已達繁中目標）", () => {
	assert.equal(koine.isAlreadyTargetLang(el("zh-CN"), "zh-Hant"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hans"), "zh-Hant"), false);
});

test("zh-HK/zh-MO 目標（迴歸案例）：el lang=zh-CN/zh-Hans → false", () => {
	// 修前這兩個目標語沒被列舉分支收到、掉進 primary subtag 比對，於是任何 zh-* 段都判成
	// 已達標而整棵跳過——整頁不翻，含最該翻的簡中段。
	assert.equal(koine.isAlreadyTargetLang(el("zh-CN"), "zh-HK"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hans"), "zh-HK"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-CN"), "zh-MO"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hans"), "zh-MO"), false);
	assert.equal(koine.isAlreadyTargetLang(el("en"), "zh-HK"), false, "非中文段對中文目標不算已達標");
});

test("zh-HK/zh-MO 目標：el lang 為任一繁中變體或裸 zh → true（判定粒度＝書寫系統）", () => {
	assert.equal(koine.isAlreadyTargetLang(el("zh-HK"), "zh-HK"), true);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hant"), "zh-HK"), true);
	assert.equal(koine.isAlreadyTargetLang(el("zh-TW"), "zh-HK"), true, "不分地區、用詞差異不在本 gate");
	assert.equal(koine.isAlreadyTargetLang(el("zh"), "zh-MO"), true);
});

test("zh-Hans 目標：裸 zh 不算已達標（既有非對稱行為、本次沿用）", () => {
	assert.equal(koine.isAlreadyTargetLang(el("zh"), "zh-Hans"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-CN"), "zh-Hans"), true);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hant"), "zh-CN"), false);
});

test("認不出書寫系統的中文語碼不算已達標（往「不翻」誤判的代價不可逆）", () => {
	// zh-CHS 是 .NET 遺留的簡體碼。若分類器把這類認不出的標籤併進「未指明書寫系統」，
	// 它會沿用裸 zh 對繁中目標的豁免而整棵跳過——最該翻的簡中段反而不翻。
	assert.equal(koine.isAlreadyTargetLang(el("zh-CHS"), "zh-Hant"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-XX"), "zh-Hant"), false);
	// 目標語自己認不出書寫系統時同樣不算已達標，不掉回 primary subtag 比對。
	assert.equal(koine.isAlreadyTargetLang(el("zh-CN"), "zh-CHS"), false);
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hant"), "zh-CHS"), false);
});

test("非 zh 目標語（迴歸案例）：ja 目標、el lang=ja → true（修前恆 false，第二參被丟棄）", () => {
	assert.equal(koine.isAlreadyTargetLang(el("ja"), "ja"), true);
	assert.equal(koine.isAlreadyTargetLang(el("ja-JP"), "ja"), true);
});

test("非 zh 目標語：el lang 與 targetLang 不同 primary subtag → false", () => {
	assert.equal(koine.isAlreadyTargetLang(el("zh-Hant"), "ja"), false);
	assert.equal(koine.isAlreadyTargetLang(el("en"), "ja"), false);
});

test("缺 lang 屬性或缺 targetLang → false", () => {
	assert.equal(koine.isAlreadyTargetLang(el(null), "ja"), false);
	assert.equal(koine.isAlreadyTargetLang(el("ja"), undefined), false);
});
