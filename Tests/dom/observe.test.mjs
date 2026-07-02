// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A（linkedom）：進場觀察 observeSegments 測試。
// linkedom 無 IntersectionObserver，故注入 stub observer（手動觸發進場）＋可控 onEnter，
// 驗 observe/unobserve、只觀察 pending、多段共用 block、以及併發閘門 maxInFlight。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine, loadFixture, collect } from "./helpers.mjs";

/** 沖掉 microtask（onEnter 走 Promise 鏈，需跨一個 macrotask 讓其結算）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** stub IntersectionObserver：記 observe/unobserve、捕捉 callback、可手動觸發進場。 */
function makeStubObserver() {
	const state = { observed: new Set(), cb: null, options: null, obs: null };
	const factory = (cb, options) => {
		state.cb = cb;
		state.options = options;
		state.obs = {
			observe: (el) => state.observed.add(el),
			unobserve: (el) => state.observed.delete(el),
			disconnect: () => state.observed.clear(),
		};
		return state.obs;
	};
	const fire = (isIntersecting, els) => state.cb(els.map((el) => ({ isIntersecting, target: el })), state.obs);
	return {
		factory, state,
		enter: (...els) => fire(true, els),  // 進場（isIntersecting:true）
		leave: (...els) => fire(false, els), // 離場（isIntersecting:false）
	};
}

/** 造 n 個 pending 假段（block 用唯一空物件當 key，不需真 DOM）。 */
function fakeSegs(n) {
	return Array.from({ length: n }, (_, i) => ({
		id: `k9-${i.toString(36)}`, order: i, source: `s${i}`,
		state: koine.SegmentState.PENDING, anchor: { block: {}, insertMode: "after-segment", refNode: null },
	}));
}

test("observe：對每個 pending 段的 block 掛觀察，IO 參數 = rootMargin 600px / threshold 0.1 / root null", () => {
	const doc = loadFixture("01-basic-paragraphs");
	const segs = collect(doc);
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter: () => {}, makeObserver: stub.factory });
	const blocks = segs.map((s) => s.anchor.block);
	for (const b of blocks) assert.ok(stub.state.observed.has(b), "pending block 未被 observe");
	assert.equal(stub.state.observed.size, blocks.length);
	assert.equal(stub.state.options.rootMargin, "600px");
	assert.equal(stub.state.options.threshold, 0.1);
	assert.equal(stub.state.options.root, null);
});

test("進場 → 立即 unobserve + onEnter(seg)（lazy 取譯觸發）", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const segs = collect(doc);
	const entered = [];
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter: (s) => entered.push(s.id), makeObserver: stub.factory });
	const b0 = segs[0].anchor.block;
	stub.enter(b0);
	await tick();
	assert.ok(!stub.state.observed.has(b0), "進場後應 unobserve 該 block");
	assert.deepEqual(entered, [segs[0].id], "只該進場段觸發 onEnter");
	assert.ok(stub.state.observed.has(segs[1].anchor.block), "未進場的段仍被 observe");
});

test("只觀察 pending：skipped 段不掛觀察 — 07-worth-numeric-skip", () => {
	const doc = loadFixture("07-worth-numeric-skip");
	const segs = collect(doc);
	const skipped = segs.filter((s) => s.state === koine.SegmentState.SKIPPED);
	const pending = segs.filter((s) => s.state === koine.SegmentState.PENDING);
	assert.ok(skipped.length >= 1 && pending.length >= 1, "fixture 應同時含 skipped 與 pending");
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter: () => {}, makeObserver: stub.factory });
	for (const s of pending) assert.ok(stub.state.observed.has(s.anchor.block), "pending 應觀察");
	for (const s of skipped) assert.ok(!stub.state.observed.has(s.anchor.block), "skipped 不應觀察");
});

test("多段共用同一 block：進場一併觸發 onEnter — 11-block-in-inline", async () => {
	const doc = loadFixture("11-block-in-inline");
	const segs = collect(doc); // before(span) / block child(div) / after(span)
	const span = segs[0].anchor.block;
	assert.equal(segs[2].anchor.block, span, "前提：before/after 共用同一 span block");
	const stub = makeStubObserver();
	const entered = [];
	koine.observeSegments(segs, { onEnter: (s) => entered.push(s.id), makeObserver: stub.factory });
	assert.equal(stub.state.observed.size, 2, "共用 block 去重：span + div 各 observe 一次");
	stub.enter(span);
	await tick();
	assert.deepEqual(entered.sort(), [segs[0].id, segs[2].id].sort(), "span 進場 → before + after 都 onEnter");
});

test("併發閘門：maxInFlight=2，其餘排隊、結算後補位、峰值不超限", async () => {
	const segs = fakeSegs(5);
	const resolvers = [];
	let started = 0;
	let concurrent = 0;
	let peak = 0;
	const onEnter = () => {
		started++;
		concurrent++;
		peak = Math.max(peak, concurrent);
		return new Promise((res) => resolvers.push(() => { concurrent--; res(); }));
	};
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory });
	stub.enter(...segs.map((s) => s.anchor.block));
	await tick();
	assert.equal(started, 2, "起始只 2 個 in-flight");
	assert.equal(concurrent, 2, "滿載 2");
	resolvers.shift()();
	await tick();
	assert.equal(started, 3, "結算 1 個 → 補位第 3 個");
	assert.equal(concurrent, 2, "補位後仍滿載 2");
	while (resolvers.length) { resolvers.shift()(); await tick(); }
	assert.equal(started, 5, "5 段全部跑完");
	assert.ok(peak <= 2, `峰值併發 ${peak} 應 ≤ 2`);
});

test("maxInFlight 預設 6", async () => {
	const segs = fakeSegs(10);
	const resolvers = [];
	let concurrent = 0;
	let peak = 0;
	const onEnter = () => {
		concurrent++;
		peak = Math.max(peak, concurrent);
		return new Promise((res) => resolvers.push(() => { concurrent--; res(); }));
	};
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter, makeObserver: stub.factory }); // 不給 maxInFlight → 預設
	stub.enter(...segs.map((s) => s.anchor.block));
	await tick();
	assert.equal(resolvers.length, 6, "預設併發應為 6");
	while (resolvers.length) { resolvers.shift()(); await tick(); }
	assert.ok(peak <= 6, `峰值併發 ${peak} 應 ≤ 6`);
});

test("離場（isIntersecting=false）不觸發 onEnter、block 仍被 observe（§10 進場才翻守門）", async () => {
	const doc = loadFixture("01-basic-paragraphs");
	const segs = collect(doc);
	const entered = [];
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter: (s) => entered.push(s.id), makeObserver: stub.factory });
	const b0 = segs[0].anchor.block;
	stub.leave(b0);
	await tick();
	assert.deepEqual(entered, [], "離場不得觸發 onEnter");
	assert.ok(stub.state.observed.has(b0), "離場不得 unobserve（仍待進場）");
});

test("onEnter 拋錯 / reject 不卡閘門：後續段仍補位、全部 dispatch", async () => {
	const segs = fakeSegs(4);
	let started = 0;
	const ok = [];
	const onEnter = (seg) => {
		started++;
		if (seg.order === 0) throw new Error("sync boom");                  // 同步 throw
		if (seg.order === 1) return Promise.reject(new Error("async boom")); // reject
		ok.push(seg.order);
		return Promise.resolve();
	};
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory });
	stub.enter(...segs.map((s) => s.anchor.block));
	for (let i = 0; i < 8; i++) await tick(); // 讓補位串跑完
	assert.equal(started, 4, "4 段全部被 dispatch（失敗段不卡閘門、§10 D3）");
	assert.deepEqual(ok.sort(), [2, 3], "失敗段之後的段仍執行");
});

test("disconnect() 停閘門：清空未 dispatch 的排隊段、不再觸發 onEnter", async () => {
	const segs = fakeSegs(5);
	const resolvers = [];
	const entered = [];
	const onEnter = (seg) => { entered.push(seg.order); return new Promise((res) => resolvers.push(res)); };
	const stub = makeStubObserver();
	const handle = koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory });
	stub.enter(...segs.map((s) => s.anchor.block)); // 5 進場：2 in-flight、3 排隊
	await tick();
	assert.equal(entered.length, 2, "起始 2 in-flight");
	handle.disconnect();
	while (resolvers.length) { resolvers.shift()(); await tick(); }
	await tick();
	assert.equal(entered.length, 2, "disconnect 後排隊的 3 段不再 onEnter");
});

test("onEnter 必填：未提供 / 非函式即 throw TypeError", () => {
	const segs = fakeSegs(1);
	const stub = makeStubObserver();
	assert.throws(() => koine.observeSegments(segs, { makeObserver: stub.factory }), TypeError);
	assert.throws(() => koine.observeSegments(segs, { onEnter: 123, makeObserver: stub.factory }), TypeError);
});
