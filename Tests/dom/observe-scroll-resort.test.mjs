// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// §10.2 滾動 re-sort 的節流鏈：scroll → ~200ms 窗尾 → requestAnimationFrame → resort。
// observeSegments 在 window 存在時掛一個 passive scroll 監聽，窗內多次 scroll 合併成一次重排，
// 重排本身包進 rAF（量測批次讀、避開 layout thrash），disconnect 則同時清掉排程中的重排與監聽。
//
// 既有 observe.test.mjs 只直接呼叫 handle.resort()（手動 re-bucket），整條節流鏈從未被驅動：
// 測試跑在 node，globalThis.window 不存在 ⇒ scrollTarget 落 null、監聽根本沒掛上。
// 2026-09-16 突變實測（基線 287 綠）：拿掉 passive、拿掉節流守衛、窗寬 200→0、disconnect 不清
// timer、disconnect 不移除監聽、不走 rAF 直接 resort、窗尾不把 timer 歸零、scheduleResort 不看
// disconnected，八種退化各自 0 fail。本檔以 window 替身驅動整條鏈、對各段釘直接錨。
//
// 期望值一律由實跑取得，非從節流規則推導。**不動節流規則本身**（那是 production 改動、另一道閘）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { koine } from "./helpers.mjs";

/** 等過節流窗（RESORT_THROTTLE_MS = 200）。 */
const pastWindow = () => new Promise((r) => setTimeout(r, 250));

/** 造單一 pending 假段（block 用唯一空物件當 key，不需真 DOM）。 */
function fakeSeg(id, order) {
	return {
		id, order, region: "main", source: id,
		state: koine.SegmentState.PENDING,
		anchor: { block: {}, insertMode: "after-segment", refNode: null },
	};
}

/** stub IntersectionObserver：本檔只驅動滾動鏈、不觸發進場。 */
const stubFactory = () => ({ observe() {}, unobserve() {}, disconnect() {} });

/**
 * 架好 window／requestAnimationFrame 替身後開觀察：maxInFlight=0 讓 eager 段只入列不 dispatch，
 * 佇列非空 resort 才有事做；measure 呼叫次數即「重排發生了幾次」的觀測點。
 * @param {{ withRaf?: boolean }} [opts]
 */
function setup(opts = {}) {
	const withRaf = opts.withRaf ?? true;
	const calls = [];
	const rafQueue = [];
	globalThis.window = {
		addEventListener: (type, fn, options) => calls.push({ kind: "add", type, fn, options }),
		removeEventListener: (type, fn) => calls.push({ kind: "remove", type, fn }),
	};
	if (withRaf) globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return 7; };
	const counter = { measures: 0 };
	const segs = [fakeSeg("k9-0", 0), fakeSeg("k9-1", 1)];
	const handle = koine.observeSegments(segs, {
		onEnter: () => {},
		maxInFlight: 0,
		makeObserver: stubFactory,
		measure: () => { counter.measures++; return 100; },
	});
	counter.measures = 0; // 入列時的首次量測不計入
	return { handle, calls, rafQueue, counter, onScroll: calls[0] && calls[0].fn };
}

function teardown() {
	delete globalThis.window;
	delete globalThis.requestAnimationFrame;
}

test("掛載與卸載：scroll 監聽帶 { passive: true }，disconnect 以同一個函式參照移除", () => {
	const { handle, calls } = setup();
	try {
		assert.equal(calls.length, 1, "開觀察時只掛一個監聽");
		assert.equal(calls[0].kind, "add");
		assert.equal(calls[0].type, "scroll");
		assert.deepEqual(calls[0].options, { passive: true }, "passive 明給、不是留空");
		handle.disconnect();
		const removed = calls.filter((c) => c.kind === "remove");
		assert.equal(removed.length, 1, "disconnect 移除一個監聽");
		assert.equal(removed[0].type, "scroll");
		assert.ok(removed[0].fn === calls[0].fn, "移除的是掛上去的同一個函式參照");
	} finally {
		teardown();
	}
});

test("節流：窗內三次 scroll 合併成一次重排，且 scroll 當下不重量測", async () => {
	const { handle, rafQueue, counter, onScroll } = setup();
	try {
		onScroll(); onScroll(); onScroll();
		assert.equal(counter.measures, 0, "scroll 當下不重量測（trailing、非 leading）");
		assert.equal(rafQueue.length, 0, "窗尾未到、rAF 還沒排");
		await pastWindow();
		assert.equal(rafQueue.length, 1, "三次 scroll 合併成一次 rAF");
		assert.equal(counter.measures, 0, "rAF 未跑前仍未重量測");
		rafQueue.shift()();
		assert.equal(counter.measures, 2, "重排逐段 re-key：兩段各量測一次");
		handle.disconnect();
	} finally {
		teardown();
	}
});

test("窗尾歸零：第一輪結算後，下一次 scroll 仍能再排一次重排", async () => {
	const { handle, rafQueue, counter, onScroll } = setup();
	try {
		onScroll();
		await pastWindow();
		rafQueue.shift()();
		assert.equal(counter.measures, 2, "第一輪重排");
		counter.measures = 0;
		onScroll();
		await pastWindow();
		assert.equal(rafQueue.length, 1, "第二輪另排一次 rAF（節流不是一次性）");
		rafQueue.shift()();
		assert.equal(counter.measures, 2, "第二輪重排");
		handle.disconnect();
	} finally {
		teardown();
	}
});

test("無 requestAnimationFrame：窗尾直接同步重排（fallback 不吞掉重排）", async () => {
	const { handle, counter, onScroll } = setup({ withRaf: false });
	try {
		assert.equal(typeof globalThis.requestAnimationFrame, "undefined", "本例刻意不給 rAF");
		onScroll();
		assert.equal(counter.measures, 0, "scroll 當下仍不重量測");
		await pastWindow();
		assert.equal(counter.measures, 2, "窗尾直接重排、不需要 rAF 推一把");
		handle.disconnect();
	} finally {
		teardown();
	}
});

test("disconnect：清掉排程中的重排，之後的 scroll 也不再排程", async () => {
	const { handle, rafQueue, counter, onScroll } = setup();
	try {
		onScroll();
		handle.disconnect();
		await pastWindow();
		assert.equal(rafQueue.length, 0, "排程中的重排被 disconnect 清掉、rAF 從未排上");
		assert.equal(counter.measures, 0, "沒有任何重排發生");
		onScroll(); // 監聽已移除，此處直接呼叫等同「漏網的一次事件」
		await pastWindow();
		assert.equal(rafQueue.length, 0, "disconnect 之後的 scroll 不再排程");
		assert.equal(counter.measures, 0, "仍無重排");
	} finally {
		teardown();
	}
});
