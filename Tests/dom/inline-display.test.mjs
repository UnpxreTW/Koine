// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：isInlineDisplay 對 display 字串的分類直接斷言。
// 採集層每顆元素都經這顆函式判 inline / block。對它的直接斷言原本只有一條
// （display-contents.test.mjs 的 contents→true）；其餘值只間接經 stubGetStyle 餵到
// "inline" 與 "block"。突變實測指出三段分支零看守：stubGetStyle 把 <ruby> 映成
// "inline"，真實瀏覽器的 "ruby" 家族與 "inline-*" 前綴家族從未進到這顆函式，空字串
// 短路分支也無直接斷言。本檔直接餵字串斷言五條分支（含 contents 與 block 側兩條既有
// 錨），期望值取自現行實作實跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

test("inline 家族：前綴比對、不是整串相等", () => {
	// startsWith("inline") ⇒ 所有 inline-* 都算 inline，不限於裸 "inline"。
	assert.equal(koine.isInlineDisplay("inline"), true);
	assert.equal(koine.isInlineDisplay("inline-block"), true);
	assert.equal(koine.isInlineDisplay("inline-flex"), true);
	assert.equal(koine.isInlineDisplay("inline-grid"), true);
	assert.equal(koine.isInlineDisplay("inline-table"), true);
});

test("ruby 家族：前綴比對算 inline", () => {
	// startsWith("ruby") ⇒ <ruby> 容器與其內層盒都不當 block 邊界。
	assert.equal(koine.isInlineDisplay("ruby"), true);
	assert.equal(koine.isInlineDisplay("ruby-base"), true);
	assert.equal(koine.isInlineDisplay("ruby-text"), true);
});

test("contents 算 inline（無盒 ⇒ 絕不當 block 邊界）", () => {
	assert.equal(koine.isInlineDisplay("contents"), true);
});

test("其餘 display 皆為 block（非 inline）", () => {
	assert.equal(koine.isInlineDisplay("block"), false);
	assert.equal(koine.isInlineDisplay("flex"), false);
	assert.equal(koine.isInlineDisplay("grid"), false);
	assert.equal(koine.isInlineDisplay("table"), false);
	assert.equal(koine.isInlineDisplay("list-item"), false);
	assert.equal(koine.isInlineDisplay("none"), false);
});

test("空與 falsy 值先短路為 false", () => {
	assert.equal(koine.isInlineDisplay(""), false);
	assert.equal(koine.isInlineDisplay(undefined), false);
	assert.equal(koine.isInlineDisplay(null), false);
});
