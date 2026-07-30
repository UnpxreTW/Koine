// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// Collect-layer benchmark, wired to `npm run bench`.
//
// What gets timed is `collectSegments` and nothing else. The DOM is rebuilt for every
// round outside the timed window, so parser cost never lands in the number.
//
// 兩類數字性質不同，分開看：
//
//   - 計數（`counters`）：同一份輸入必得同一組值，任何變動都是行為改變。反過來不成立
//     ——計數沒動不保證行為沒動，只保證這幾個面向沒動。所以計數面刻意鋪寬：段數、
//     取 style 的次數、原文總字數、狀態與區域分佈、button 段數、protected span 數。
//     其中 `sourceChars` 抓的是「段沒變但字變了」（`<br>` 處置、opaque 併入等），
//     `computedStyleCalls` 抓的是 §5 短路破功——那會先於任何輸出變化顯形。
//     這組值另有 Tests/dom/synthetic-page.test.mjs 跟著一般測試跑，不必等有人想到
//     要跑 benchmark 才發現。
//
//   - 時間（`collectMs`）：同機同 node 主版才可比。基準檔記了錄製環境；環境不同時
//     `--check` 只比計數、時間僅列參考值，因為跨機拿 ms 當門檻只會製造假紅。
//
// 用法：
//   node Tools/bench.mjs                 量測並印報告
//   node Tools/bench.mjs --record        把本次結果寫成基準（Tools/bench-baseline.json）
//   node Tools/bench.mjs --check         對基準比對，超標則 exit 1
//   node Tools/bench.mjs --json          機器可讀輸出（報告走 stdout、比對結論走 stderr）
//
// 離開碼：0 通過／1 超出門檻或計數不符／2 量測不穩（CV > 15%）需重跑。
// 計數比對排在 CV 閘門之前：計數與環境無關，不該被時間噪音擋住。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseHTML } from "linkedom";

import { koine, stubGetStyle } from "../Tests/dom/helpers.mjs";
import { generateSyntheticPage } from "./gen-synthetic-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(HERE, "bench-baseline.json");

// §11.4：暖機丟前 3 輪、正式取 30 輪。
// sections 預設 60（約 460 段）而非真實頁面量級的 24（約 180 段）：24 的單輪只有 1.9ms，
// 量到的多半是計時器與排程噪音（實測 CV 20%）；60 的單輪約 4ms、CV 穩定在 5% 上下，
// 門檻才有鑑別力。段數比真實頁面多不影響用途——這是回歸偵測基準，不是體感估計。
export const DEFAULTS = { seed: 1, sections: 60, n: 30, warmup: 3 };
const CV_LIMIT = 0.15;
const P50_GATE = 1.3;
const P95_GATE = 1.5;

/**
 * 從一次採集結果算出全部計數欄位。扁平 key 方便逐項比對與讀 diff。
 * @param {any[]} segments
 * @param {number} computedStyleCalls
 */
function countersOf(segments, computedStyleCalls) {
	/** @type {Record<string, number>} */
	const out = {
		segmentCount: segments.length,
		computedStyleCalls,
		sourceChars: 0,
		buttonSegments: 0,
		protectedSpans: 0,
	};
	for (const s of segments) {
		out.sourceChars += s.source.length;
		if (s.kind === "button") out.buttonSegments++;
		out.protectedSpans += s.meta?.protectedSpans?.length ?? 0;
		const stateKey = `state.${s.state}`;
		const regionKey = `region.${s.region}`;
		out[stateKey] = (out[stateKey] ?? 0) + 1;
		out[regionKey] = (out[regionKey] ?? 0) + 1;
	}
	return out;
}

/**
 * 跑一輪：DOM 在計時區外重建，確保每輪都是全新頁面（無前一輪留下的標記）。
 * @param {string} bodyHtml
 * @returns {{ collectMs: number, counters: Record<string, number> }}
 */
export function runOnce(bodyHtml) {
	const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
	let computedStyleCalls = 0;
	// 上一輪的整棵 DOM 在這裡才變垃圾。不主動回收的話，回收會落在某幾輪的計時區內，
	// 量出來的分佈就是「大多數 4ms、偶爾 10ms」——p95 與 CV 全被 GC 決定而非採集層。
	// 需要 --expose-gc；沒有時仍可跑，只是 CV 會高（見 main() 的提示）。
	globalThis.gc?.();
	const ctx = koine.makeContext({
		getStyle: (/** @type {any} */ el) => {
			computedStyleCalls++;
			return stubGetStyle(el);
		},
		pageLangIsZh: false,
	});

	const t0 = performance.now();
	const segments = koine.collectSegments(document.body, ctx, { walkId: 1 });
	const collectMs = performance.now() - t0;

	return { collectMs, counters: countersOf(segments, computedStyleCalls) };
}

/** 計數欄位——同一份輸入必為定值，可直接當回歸探針。 */
export function countersFor(opts = {}) {
	const body = generateSyntheticPage({
		seed: opts.seed ?? DEFAULTS.seed,
		sections: opts.sections ?? DEFAULTS.sections,
	});
	return runOnce(body).counters;
}

function quantile(sorted, q) {
	// nearest-rank：小樣本下不插值，避免報出一個沒真的量到的數。
	const rank = Math.max(1, Math.ceil(q * sorted.length));
	return sorted[rank - 1];
}

function summarize(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
	const stddev = Math.sqrt(variance);
	return {
		min: sorted[0],
		p50: quantile(sorted, 0.5),
		p95: quantile(sorted, 0.95),
		mean,
		cv: mean === 0 ? 0 : stddev / mean,
	};
}

function environment() {
	const cpu = cpus();
	return {
		platform: process.platform,
		arch: process.arch,
		// 只留主版：`.config/mise.toml` 釘的是 `node = "24"`，patch 版會隨 mise install 漂移。
		// 若比到 patch，一次例行升版就會讓時間門檻永久靜默略過。
		nodeMajor: Number(process.versions.node.split(".")[0]),
		cpu: cpu.length ? cpu[0].model : "unknown",
	};
}

function sameEnvironment(a, b) {
	if (!a || !b) return false;
	return a.platform === b.platform && a.arch === b.arch && a.cpu === b.cpu && a.nodeMajor === b.nodeMajor;
}

export function bench(opts = {}) {
	const seed = opts.seed ?? DEFAULTS.seed;
	const sections = opts.sections ?? DEFAULTS.sections;
	const n = opts.n ?? DEFAULTS.n;
	const warmup = opts.warmup ?? DEFAULTS.warmup;

	const body = generateSyntheticPage({ seed, sections });

	for (let i = 0; i < warmup; i++) runOnce(body);

	const times = [];
	const shapes = new Set();
	let peakRssBytes = 0;
	let last = null;
	for (let i = 0; i < n; i++) {
		const r = runOnce(body);
		times.push(r.collectMs);
		shapes.add(JSON.stringify(r.counters));
		last = r;
		const rss = process.memoryUsage.rss();
		if (rss > peakRssBytes) peakRssBytes = rss;
	}

	return {
		input: { seed, sections, bodyBytes: Buffer.byteLength(body, "utf8") },
		config: { n, warmup, gc: typeof globalThis.gc === "function" },
		counters: last.counters,
		// 同一份輸入跑 n 輪應只出現一組計數；出現多組代表採集層帶了輪次相依的狀態。
		counterVariants: shapes.size,
		collectMs: summarize(times),
		peakRssMB: Math.round((peakRssBytes / 1024 ** 2) * 10) / 10,
		env: environment(),
	};
}

function fmt(ms) {
	return `${ms.toFixed(3)} ms`;
}

function report(result) {
	const lines = [];
	lines.push(`合成頁  seed=${result.input.seed} sections=${result.input.sections} (${result.input.bodyBytes} bytes)`);
	lines.push(`取樣    warmup ${result.config.warmup} 丟棄 + 正式 ${result.config.n} 輪${result.config.gc ? "" : "（未帶 --expose-gc）"}`);
	lines.push("");
	for (const [key, value] of Object.entries(result.counters)) {
		lines.push(`${key.padEnd(20)}${value}`);
	}
	lines.push(`${"counterVariants".padEnd(20)}${result.counterVariants}${result.counterVariants === 1 ? "" : "  ← 應為 1"}`);
	lines.push("");
	lines.push(`collectMs  min ${fmt(result.collectMs.min)}  p50 ${fmt(result.collectMs.p50)}  p95 ${fmt(result.collectMs.p95)}`);
	lines.push(`           mean ${fmt(result.collectMs.mean)}  CV ${(result.collectMs.cv * 100).toFixed(1)}%`);
	lines.push(`peakRSS    ${result.peakRssMB} MB（行程級，含 linkedom 與 node 本身）`);
	lines.push("");
	lines.push(`環境       ${result.env.platform}/${result.env.arch} node ${result.env.nodeMajor}.x — ${result.env.cpu}`);
	return lines.join("\n");
}

function loadBaseline() {
	let raw;
	try {
		raw = readFileSync(BASELINE_PATH, "utf8");
	} catch {
		return { error: `找不到基準檔 ${BASELINE_PATH}——先跑 --record。` };
	}
	let baseline;
	try {
		baseline = JSON.parse(raw);
	} catch (e) {
		return { error: `基準檔不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
	}
	for (const field of ["input", "counters", "collectMs", "env"]) {
		if (!baseline[field] || typeof baseline[field] !== "object") {
			return { error: `基準檔缺少 ${field} 欄位（格式已變或被改壞）——請重跑 --record。` };
		}
	}
	return { baseline };
}

/** 計數比對：與環境無關，永遠執行。 */
function checkCounters(baseline, result) {
	const lines = [];
	let failed = false;

	const baseKeys = Object.keys(baseline.counters).sort();
	const nowKeys = Object.keys(result.counters).sort();
	if (baseKeys.join(",") !== nowKeys.join(",")) {
		failed = true;
		lines.push(`✗ 計數欄位集合改變：${baseKeys.join(" ")} → ${nowKeys.join(" ")}`);
	}

	for (const key of nowKeys) {
		const now = result.counters[key];
		const was = baseline.counters[key];
		if (now !== was) {
			failed = true;
			lines.push(`✗ ${key} ${was} → ${now}（計數為定值，變動即行為改變）`);
		} else {
			lines.push(`✓ ${key} ${now}`);
		}
	}

	if (result.counterVariants !== 1) {
		failed = true;
		lines.push(`✗ counterVariants ${result.counterVariants}——同一份輸入跑出多組計數`);
	}

	return { failed, lines };
}

/** 時間比對：只在同環境且本次量測夠穩時才判定。 */
function checkTiming(baseline, result) {
	const lines = [""];
	if (!sameEnvironment(baseline.env, result.env)) {
		lines.push("⚠ 錄製環境與本機不同，時間門檻未判定（跨機 wall-clock 不可比）：");
		lines.push(`  基準 ${baseline.env.platform}/${baseline.env.arch} node ${baseline.env.nodeMajor}.x — ${baseline.env.cpu}`);
		lines.push(`  本機 ${result.env.platform}/${result.env.arch} node ${result.env.nodeMajor}.x — ${result.env.cpu}`);
		lines.push(`  參考值：p50 ${fmt(baseline.collectMs.p50)} → ${fmt(result.collectMs.p50)}`);
		return { failed: false, judged: false, lines };
	}
	if (result.collectMs.cv > CV_LIMIT) {
		lines.push(`⚠ 本次 CV ${(result.collectMs.cv * 100).toFixed(1)}% 超過 ${CV_LIMIT * 100}%，時間門檻未判定。`);
		lines.push(`  參考值：p50 ${fmt(baseline.collectMs.p50)} → ${fmt(result.collectMs.p50)}`);
		return { failed: false, judged: false, lines };
	}

	const p50Ratio = result.collectMs.p50 / baseline.collectMs.p50;
	const p95Ratio = result.collectMs.p95 / baseline.collectMs.p95;
	const p50Ok = p50Ratio <= P50_GATE;
	const p95Ok = p95Ratio <= P95_GATE;
	lines.push(`${p50Ok ? "✓" : "✗"} p50 ${fmt(baseline.collectMs.p50)} → ${fmt(result.collectMs.p50)}  ×${p50Ratio.toFixed(2)}（上限 ×${P50_GATE}）`);
	lines.push(`${p95Ok ? "✓" : "✗"} p95 ${fmt(baseline.collectMs.p95)} → ${fmt(result.collectMs.p95)}  ×${p95Ratio.toFixed(2)}（上限 ×${P95_GATE}）`);
	return { failed: !p50Ok || !p95Ok, judged: true, lines };
}

function parseArgs(argv) {
	/** @type {Record<string, any>} */
	const out = { ...DEFAULTS, json: false, record: false, check: false };
	/** @type {Record<string, string>} */
	const numeric = { "--seed": "seed", "--sections": "sections", "--n": "n", "--warmup": "warmup" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a in numeric) {
			const v = Number(argv[++i]);
			if (!Number.isFinite(v) || v < 0) return { error: `${a} 需要一個非負數字，收到 ${JSON.stringify(argv[i])}` };
			out[numeric[a]] = v;
		} else if (a === "--json") out.json = true;
		else if (a === "--record") out.record = true;
		else if (a === "--check") out.check = true;
		else return { error: `未知參數 ${a}` };
	}
	if (out.n < 1) return { error: "--n 至少要 1" };
	if (out.sections < 1) return { error: "--sections 至少要 1" };
	// 併用會讓 record 靜默勝出、把退步值寫成新基準，等於自己蓋掉自己的門檻。
	if (out.record && out.check) return { error: "--record 與 --check 不可併用（會把當下的值直接寫成基準）" };
	return { args: out };
}

function main(argv) {
	const parsed = parseArgs(argv);
	if (parsed.error) {
		process.stderr.write(`${parsed.error}\n`);
		return 1;
	}
	const args = parsed.args;
	const result = bench(args);
	// --json 時比對結論走 stderr，讓 stdout 保持是一份可直接餵給 jq 的 JSON。
	const verdictOut = args.json ? process.stderr : process.stdout;

	process.stdout.write(args.json ? `${JSON.stringify(result, null, "\t")}\n` : `${report(result)}\n`);

	const noisy = result.collectMs.cv > CV_LIMIT;
	const noiseHint = result.config.gc
		? "請在機器閒置時重跑。"
		: "本次未帶 --expose-gc（GC 落在計時區內會直接吃掉 p95），改用 `npm run bench`。";

	if (args.record) {
		// 不穩的樣本不該變成別人日後比對的真相。
		if (noisy) {
			process.stderr.write(`\n未寫入基準：CV ${(result.collectMs.cv * 100).toFixed(1)}% 超過 ${CV_LIMIT * 100}%，${noiseHint}\n`);
			return 2;
		}
		writeFileSync(BASELINE_PATH, `${JSON.stringify(result, null, "\t")}\n`);
		verdictOut.write(`\n已寫入基準 ${BASELINE_PATH}\n`);
		return 0;
	}

	if (args.check) {
		const loaded = loadBaseline();
		if (loaded.error) {
			process.stderr.write(`\n${loaded.error}\n`);
			return 1;
		}
		const baseline = loaded.baseline;
		if (baseline.input.seed !== result.input.seed || baseline.input.sections !== result.input.sections) {
			process.stderr.write(
				`\n輸入與基準不同（基準 seed=${baseline.input.seed} sections=${baseline.input.sections}），無從比較。\n`,
			);
			return 1;
		}

		// 計數先判：與環境無關的定值，不該被時間噪音擋在門外。
		const counters = checkCounters(baseline, result);
		const timing = checkTiming(baseline, result);
		verdictOut.write(`\n${[...counters.lines, ...timing.lines].join("\n")}\n`);
		if (counters.failed || timing.failed) return 1;
		if (!timing.judged && noisy) {
			process.stderr.write(`\n計數通過，但時間未判定：CV ${(result.collectMs.cv * 100).toFixed(1)}% 超過 ${CV_LIMIT * 100}%，${noiseHint}\n`);
			return 2;
		}
		return 0;
	}

	if (noisy) {
		process.stderr.write(`\n量測作廢：CV ${(result.collectMs.cv * 100).toFixed(1)}% 超過 ${CV_LIMIT * 100}%，${noiseHint}\n`);
		return 2;
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main(process.argv.slice(2));
}
