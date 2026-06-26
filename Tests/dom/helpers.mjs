// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 跑道 A 測試輔助：載入 content.js（universal script → globalThis.__koine__）、
// linkedom 建 DOM、stub getStyle（display 由 data-d 屬性或 tag 預設、不靠真 computed style）。

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CONTENT = join(REPO, "Sources", "Extension", "Resources", "content.js");
export const FIXTURES = join(REPO, "Tests", "Fixtures", "dom");

await import(pathToFileURL(CONTENT).href);
/** @type {any} */
export const koine = globalThis.__koine__;

// 跑道 A：display 不靠真 computed style。fixture 用 data-d 指定，否則 tag 預設。
// FORCE_BLOCK_TAGS（如 LI/UL/LABEL）由 content.js 覆蓋、不受此預設影響。
const INLINE_TAGS = new Set([
	"SPAN", "A", "EM", "STRONG", "B", "I", "U", "S", "SMALL", "SUP", "SUB",
	"MARK", "ABBR", "Q", "CITE", "DFN", "VAR", "SAMP", "KBD", "BDI", "BDO",
	"WBR", "RUBY", "FONT", "TT", "INS", "DEL",
]);
function defaultDisplay(tag) {
	return INLINE_TAGS.has(tag) ? "inline" : "block";
}

export function stubGetStyle(el) {
	return {
		display: el.getAttribute("data-d") || defaultDisplay(el.tagName),
		visibility: el.getAttribute("data-vis") || "visible",
		contentVisibility: el.getAttribute("data-cv") || "visible",
	};
}

export function loadFixture(name) {
	const html = readFileSync(join(FIXTURES, "cases", `${name}.html`), "utf8");
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}
export function loadGolden(name) {
	return JSON.parse(readFileSync(join(FIXTURES, "golden", `${name}.json`), "utf8"));
}
export function loadManifest() {
	return JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));
}

export function collect(document, opts = {}) {
	const ctx = koine.makeContext({
		getStyle: stubGetStyle,
		pageLangIsZh: opts.pageLangIsZh ?? false,
	});
	return koine.collectSegments(document.body, ctx, { walkId: opts.walkId ?? 1 });
}

/** golden 比對用：留 order/source/state（+ skipReason/protectedSpans），丟 anchor 與 id。 */
export function normalize(segments) {
	return segments.map((s) => {
		/** @type {any} */
		const o = { order: s.order, source: s.source, state: s.state };
		if (s.meta?.skipReason) o.skipReason = s.meta.skipReason;
		if (s.meta?.protectedSpans) o.protectedSpans = s.meta.protectedSpans;
		return o;
	});
}
