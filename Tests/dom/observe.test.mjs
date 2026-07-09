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

/** stub IntersectionObserver：記 observe/unobserve、捕捉 callback、可手動觸發進場（P3 tiered：支援多 observer）。 */
function makeStubObserver() {
	const state = { observed: new Set(), observers: [], cb: null, options: null, obs: null };
	const factory = (cb, options) => {
		const rec = { cb, options, observed: new Set(), obs: null };
		rec.obs = {
			observe: (el) => { rec.observed.add(el); state.observed.add(el); },
			unobserve: (el) => { rec.observed.delete(el); state.observed.delete(el); },
			disconnect: () => { for (const el of rec.observed) state.observed.delete(el); rec.observed.clear(); },
		};
		state.observers.push(rec);
		state.cb = cb; state.options = options; state.obs = rec.obs; // 最後一個（單 observer 用法相容）
		return rec.obs;
	};
	const fire = (isIntersecting, els) => {
		for (const rec of state.observers) {
			const hit = els.filter((el) => rec.observed.has(el));
			if (hit.length) rec.cb(hit.map((el) => ({ isIntersecting, target: el })), rec.obs);
		}
	};
	return {
		factory, state,
		enter: (...els) => fire(true, els),  // 進場（isIntersecting:true）
		leave: (...els) => fire(false, els), // 離場（isIntersecting:false）
	};
}

/** 造 n 個 pending 假段（block 用唯一空物件當 key，不需真 DOM；region 預設 main）。 */
function fakeSegs(n, region = "main") {
	return Array.from({ length: n }, (_, i) => ({
		id: `k9-${i.toString(36)}`, order: i, region, source: `s${i}`,
		state: koine.SegmentState.PENDING, anchor: { block: {}, insertMode: "after-segment", refNode: null },
	}));
}

test("observe：對每個 pending 段的 block 掛觀察；tiered IO 參數（§10.1）threshold 0.1 / root null", () => {
	const doc = loadFixture("01-basic-paragraphs");
	const segs = collect(doc);
	const stub = makeStubObserver();
	koine.observeSegments(segs, { onEnter: () => {}, makeObserver: stub.factory, eagerBudget: 0 });
	const blocks = segs.map((s) => s.anchor.block);
	for (const b of blocks) assert.ok(stub.state.observed.has(b), "pending block 未被 observe");
	assert.equal(stub.state.observed.size, blocks.length);
	for (const rec of stub.state.observers) {
		assert.equal(rec.options.threshold, 0.1);
		assert.equal(rec.options.root, null);
	}
	// fixture 01 無 landmark、短段 → heuristic 判 chrome → 只建 chrome 層（rootMargin 400px）
	assert.ok(segs.every((s) => s.region === koine.Region.CHROME), "前提：fixture 01 全段 heuristic 判 chrome");
	assert.equal(stub.state.observers.length, 1);
	assert.equal(stub.state.observers[0].options.rootMargin, "400px");
});

test("tiered IO：main / chrome 分兩層 observer，rootMargin = 1200px / 400px（§10.1）", () => {
	const mains = fakeSegs(2, "main");
	const chromes = fakeSegs(2, "chrome");
	const stub = makeStubObserver();
	koine.observeSegments([...mains, ...chromes], { onEnter: () => {}, makeObserver: stub.factory, eagerBudget: 0 });
	assert.equal(stub.state.observers.length, 2, "main + chrome 各一層 observer");
	const margins = stub.state.observers.map((r) => r.options.rootMargin);
	assert.deepEqual(margins, ["1200px", "400px"], "main 讀前預取 1200px、chrome 近了才排 400px");
	for (const s of mains) assert.ok(stub.state.observers[0].observed.has(s.anchor.block), "main block 應在 main 層");
	for (const s of chromes) assert.ok(stub.state.observers[1].observed.has(s.anchor.block), "chrome block 應在 chrome 層");
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
	koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory, eagerBudget: 0 });
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
	koine.observeSegments(segs, { onEnter, makeObserver: stub.factory, eagerBudget: 0 }); // 不給 maxInFlight → 預設
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
	koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory, eagerBudget: 0 });
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
	const handle = koine.observeSegments(segs, { onEnter, maxInFlight: 2, makeObserver: stub.factory, eagerBudget: 0 });
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

// ============================================================================
// P3（§10.1 / §10.2）：eager 預算、priorityGate sortKey、滾動 re-bucket
// ============================================================================

/** 造單一假段（region / order / 距離可控；block 唯一物件當 key）。 */
function fakeSeg(id, region, order) {
	return {
		id, order, region, source: id,
		state: koine.SegmentState.PENDING, anchor: { block: {}, insertMode: "after-segment", refNode: null },
	};
}

test("eager（§10.1）：文件序前 N 個 MAIN 載入即發、不等 IO；chrome 永不 eager；IO 進場不重複入列", async () => {
	const mains = fakeSegs(15, "main");
	const chromes = fakeSegs(3, "chrome").map((s, i) => ({ ...s, id: `c-${i}`, order: 100 + i }));
	const entered = [];
	const stub = makeStubObserver();
	// chrome 排前面：eager 選的是「文件序前 N 個 MAIN」、與陣列序無關
	koine.observeSegments([...chromes, ...mains], { onEnter: (s) => entered.push(s.id), makeObserver: stub.factory });
	for (let i = 0; i < 6; i++) await tick(); // 未觸發任何 IO 進場
	assert.equal(entered.length, koine.EAGER_MAIN_BUDGET, "載入即發數 = eager 預算（預設 10）");
	assert.deepEqual(entered, mains.slice(0, 10).map((s) => s.id), "eager 集 = 文件序前 10 個 MAIN、依序");
	// chrome 段永不 eager、blocks 仍被觀察；eager 段的 block 免觀察（全段已入列）
	for (const c of chromes) assert.ok(stub.state.observed.has(c.anchor.block), "chrome 應留在 IO 層");
	for (const m of mains.slice(0, 10)) assert.ok(!stub.state.observed.has(m.anchor.block), "eager block 免觀察");
	for (const m of mains.slice(10)) assert.ok(stub.state.observed.has(m.anchor.block), "N 外 main 走 lazy IO");
	// IO 進場其餘段：不重複入列、全數 dispatch 一次
	stub.enter(...mains.slice(10).map((s) => s.anchor.block), ...chromes.map((s) => s.anchor.block));
	for (let i = 0; i < 6; i++) await tick();
	assert.equal(entered.length, 18, "15 main + 3 chrome 全 dispatch");
	assert.equal(new Set(entered).size, 18, "無重複 dispatch（eager 與 IO 觸發去重）");
});

test("priorityGate（§10.2）：sortKey (viewportBand, regionRank, distanceBucket@300px, order) dequeue 最小", async () => {
	const dist = new Map();
	const mk = (id, region, order, d) => { const s = fakeSeg(id, region, order); dist.set(s.anchor.block, d); return s; };
	const A = mk("A", "main", 5, 1000);   // (1,0,3,5)
	const B = mk("B", "chrome", 9, 0);    // (0,1,0,9) band0 安全閥：現場 chrome 壓過 offscreen main
	const C = mk("C", "main", 7, 0);      // (0,0,0,7) 現場 main 最先
	const D = mk("D", "main", 1, 400);    // (1,0,1,1)
	const E = mk("E", "chrome", 0, 2000); // (1,1,6,0) 遠 chrome 等到 main 譯完
	const F = mk("F", "main", 6, 1100);   // (1,0,3,6) 與 A 同桶 → order tie-break
	const entered = [];
	const releases = [];
	const onEnter = (s) => { entered.push(s.id); return new Promise((res) => releases.push(res)); };
	const stub = makeStubObserver();
	const segs = [A, B, C, D, E, F];
	koine.observeSegments(segs, {
		onEnter, maxInFlight: 1, makeObserver: stub.factory, eagerBudget: 0,
		measure: (block) => dist.get(block) ?? 0,
	});
	stub.enter(...segs.map((s) => s.anchor.block));
	await tick();
	for (let i = 0; i < 8; i++) { if (releases.length) releases.shift()(); await tick(); }
	assert.deepEqual(entered, ["C", "B", "D", "A", "F", "E"],
		"band0 壓過一切（main 先於 chrome）→ offscreen main 依 bucket/order → 遠 chrome 最後");
});

test("re-bucket（§10.2）：resort() 只重量測未 dispatch 段、dequeue 序更新", async () => {
	const dist = new Map();
	const mk = (id, region, order, d) => { const s = fakeSeg(id, region, order); dist.set(s.anchor.block, d); return s; };
	const A = mk("A", "main", 1, 900);  // 初始 bucket 3
	const B = mk("B", "main", 2, 300);  // 初始 bucket 1（先於 A）
	const C = mk("C", "main", 0, 0);    // band0 先走
	const entered = [];
	const releases = [];
	const onEnter = (s) => { entered.push(s.id); return new Promise((res) => releases.push(res)); };
	const stub = makeStubObserver();
	const handle = koine.observeSegments([A, B, C], {
		onEnter, maxInFlight: 1, makeObserver: stub.factory, eagerBudget: 0,
		measure: (block) => dist.get(block) ?? 0,
	});
	stub.enter(A.anchor.block, B.anchor.block, C.anchor.block);
	await tick();
	assert.deepEqual(entered, ["C"], "C 現場先走、A/B 排隊");
	// 滾動後視野變化：A 進視窗、B 遠離 → resort 重量測 pending
	dist.set(A.anchor.block, 0);
	dist.set(B.anchor.block, 1200);
	handle.resort();
	releases.shift()(); await tick(); // C 結算 → 補位應為 A（不 resort 會是 B）
	releases.shift()(); await tick();
	assert.deepEqual(entered, ["C", "A", "B"], "re-bucket 後 dequeue 序反映新距離");
});
