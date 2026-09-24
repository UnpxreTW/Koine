// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：單段取譯失敗路徑的記帳與回覆型別守衛。
// bridge.test.mjs 已釘住成功／失敗的主幹狀態轉移，本檔補三段沒有斷言的邊界：
// 失敗記帳對既有 meta 的合併（保留其他欄位、且不就地改寫原物件）、
// 非字串 text 一律當失敗、error 欄以「有沒有值」而非真假值判定。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine, loadFixture, collect, assertSame } from "./helpers.mjs";

/** 取一個 pending 段，可先塞既有 meta。 */
function pendingSegment(meta) {
	const doc = loadFixture("01-basic-paragraphs");
	const seg = collect(doc)[0];
	assert.equal(seg.state, koine.SegmentState.PENDING, "取樣段應為 pending");
	if (meta) seg.meta = meta;
	return { doc, seg };
}

const reply = (res) => () => Promise.resolve(res);

test("失敗記帳保留既有 meta 的其他欄位（送出擲錯與回覆無 text 兩條路徑）", async () => {
	const thrown = pendingSegment({ walkId: 9, tier: "main" });
	await koine.translateSegment(thrown.seg, () => Promise.reject(new Error("boom")));
	assert.equal(thrown.seg.state, koine.SegmentState.FAILED);
	assert.deepEqual(thrown.seg.meta, { walkId: 9, tier: "main", failReason: "Error: boom" });

	const noText = pendingSegment({ walkId: 9, tier: "main" });
	await koine.translateSegment(noText.seg, reply({ id: noText.seg.id }));
	assert.equal(noText.seg.state, koine.SegmentState.FAILED);
	assert.deepEqual(noText.seg.meta, { walkId: 9, tier: "main", failReason: "no-text" });
});

test("失敗記帳不就地改寫原 meta 物件、換上新物件（兩條失敗路徑同形）", async () => {
	const noText = pendingSegment({ walkId: 9 });
	const beforeNoText = noText.seg.meta;
	await koine.translateSegment(noText.seg, reply({ id: noText.seg.id }));
	assert.notEqual(noText.seg.meta, beforeNoText, "應換上新物件");
	assert.deepEqual(beforeNoText, { walkId: 9 }, "原物件不得被寫入 failReason");
	assert.equal(noText.seg.meta.failReason, "no-text");

	const thrown = pendingSegment({ walkId: 9 });
	const beforeThrown = thrown.seg.meta;
	await koine.translateSegment(thrown.seg, () => Promise.reject(new Error("boom")));
	assert.notEqual(thrown.seg.meta, beforeThrown, "應換上新物件");
	assert.deepEqual(beforeThrown, { walkId: 9 }, "原物件不得被寫入 failReason");
	assert.equal(thrown.seg.meta.failReason, "Error: boom");
});

test("text 不是字串一律當失敗、記 no-text、不插回", async () => {
	for (const text of [123, null, true, {}, ["x"]]) {
		const { doc, seg } = pendingSegment();
		await koine.translateSegment(seg, reply({ id: seg.id, text }));
		assert.equal(seg.state, koine.SegmentState.FAILED, `text=${JSON.stringify(text)} 應失敗`);
		assert.equal(seg.meta.failReason, "no-text");
		assert.equal(seg.draft, undefined, "失敗不得留 draft");
		assertSame(doc.querySelector(`[data-koine-id="${seg.id}"]`), null, "失敗不得插回");
	}
});

test("error 欄以有沒有值判定、不看真假值：0 與空字串都算失敗", async () => {
	const zero = pendingSegment();
	await koine.translateSegment(zero.seg, reply({ id: zero.seg.id, error: 0, text: "hi" }));
	assert.equal(zero.seg.state, koine.SegmentState.FAILED, "error=0 仍是失敗");
	assert.equal(zero.seg.meta.failReason, "0", "原因碼取 error 的字串形");
	assertSame(zero.doc.querySelector(`[data-koine-id="${zero.seg.id}"]`), null, "失敗不得插回");

	const empty = pendingSegment();
	await koine.translateSegment(empty.seg, reply({ id: empty.seg.id, error: "", text: "hi" }));
	assert.equal(empty.seg.state, koine.SegmentState.FAILED, "error=空字串仍是失敗");
	assert.equal(empty.seg.meta.failReason, "", "原因碼即空字串");
});

test("error 明給 null 不算失敗：帶 text 時照常插回", async () => {
	const { doc, seg } = pendingSegment();
	await koine.translateSegment(seg, reply({ id: seg.id, error: null, text: "譯文" }));
	assert.equal(seg.state, koine.SegmentState.DRAFTED);
	assert.equal(seg.draft, "譯文");
	const wrapper = doc.querySelector(`[data-koine-id="${seg.id}"]`);
	assert.ok(wrapper, "應插回 wrapper");
	assert.equal(wrapper.textContent, "譯文");
});

test("回覆整個缺席（null／undefined）：失敗記 no-text、不擲錯", async () => {
	for (const res of [null, undefined]) {
		const { doc, seg } = pendingSegment();
		await koine.translateSegment(seg, reply(res));
		assert.equal(seg.state, koine.SegmentState.FAILED, `res=${String(res)} 應失敗`);
		assert.equal(seg.meta.failReason, "no-text");
		assertSame(doc.querySelector(`[data-koine-id="${seg.id}"]`), null, "失敗不得插回");
	}
});
