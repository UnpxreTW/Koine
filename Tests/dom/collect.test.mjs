// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：採集層結構規則 golden 測試 + order 連號 / id 穩定不變式。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, loadGolden, loadManifest, collect, normalize } from "./helpers.mjs";

const manifest = loadManifest();
const laneA = manifest.cases.filter((c) => c.lane === "a" || c.lane === "both");

for (const c of laneA) {
	test(`fixture ${c.name} — ${c.desc}`, () => {
		const segs = collect(loadFixture(c.name), c.opts || {});
		assert.deepEqual(normalize(segs), loadGolden(c.name));
	});
}

test("order 連號升序（所有 lane A fixture）", () => {
	for (const c of laneA) {
		const segs = collect(loadFixture(c.name), c.opts || {});
		const orders = segs.map((s) => s.order);
		const expected = orders.map((_, i) => i);
		assert.deepEqual(orders, expected, `${c.name} order 非連號: ${orders}`);
	}
});

test("id 穩定：同輸入跑兩次全等（§11.3）", () => {
	for (const c of laneA) {
		const a = collect(loadFixture(c.name), c.opts || {}).map((s) => s.id);
		const b = collect(loadFixture(c.name), c.opts || {}).map((s) => s.id);
		assert.deepEqual(a, b, `${c.name} id 不穩定`);
	}
});

test("id 格式 = k<walkId>-<order>（base36）", () => {
	const segs = collect(loadFixture("01-basic-paragraphs"));
	assert.equal(segs[0].id, "k1-0");
	assert.equal(segs[1].id, "k1-1");
});
