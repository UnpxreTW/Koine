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
