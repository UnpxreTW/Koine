// SPDX-FileCopyrightText: 2026 Unpxre (GitHub: UnpxreTW)
// SPDX-License-Identifier: Apache-2.0
//
// 雅言 Koine — M1 DOM 採集層（content script，注入每個頁面）。
//
// 設計來源：SPEC-collect-layer（採集核心＝兩遍 walk + inline buffer flush、
// 採集產物＝Segment IR、block/inline 判斷＝computed display + FORCE_BLOCK 白名單）。
//
// 通用腳本（universal script）：
//   - Safari 載入為 classic content script（無 import/export 語法）。
//   - node --test 以 ESM 副作用載入，純函式經 globalThis.__koine__ 取用。
//   - 自動執行的 main() 用 typeof document/browser 守門，node 載入時不觸發。
//   - getComputedStyle 一律走 ctx.getStyle 注入，跑道 A（linkedom）可餵 stub。

"use strict";

// ============================================================================
// §2.3 / §3.1 / §3.2 三張集合（照抄 Read Frog 原始值、不偷加）
// ============================================================================

/** §2.3 FORCE_BLOCK_TAGS — 白名單一律當 block（Read Frog 原始 25 個）。 */
const FORCE_BLOCK_TAGS = new Set([
	"BODY", "H1", "H2", "H3", "H4", "H5", "H6", "BR",
	"FORM", "SELECT", "BUTTON", "LABEL", "UL", "OL", "LI",
	"BLOCKQUOTE", "PRE", "ARTICLE", "SECTION", "FIGURE", "FIGCAPTION",
	"HEADER", "FOOTER", "MAIN", "NAV",
]);

/** §3.1 SKIP_SUBTREE_TAGS — 整棵跳過、不採集不翻。 */
const SKIP_SUBTREE_TAGS = new Set([
	"SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE",
	"TEXTAREA", "INPUT", "OPTION", "OPTGROUP",
	"SVG", "CANVAS", "AUDIO", "VIDEO", "IMG", "SOURCE", "TRACK",
	"IFRAME", "OBJECT", "EMBED",
	"HEAD", "TITLE", "META", "LINK", "BASE",
	"HR", "RT", "RP",
]);

/** §3.2 OPAQUE_INLINE_TAGS — 不展開、textContent 併入父段（不可分割原子）。 */
const OPAQUE_INLINE_TAGS = new Set(["CODE", "TIME"]);

/** §3.5 BULK_TRANSLATE_NO_TAGS — translate="no" 在大容器視為框架誤標、降級不尊重。 */
const BULK_TRANSLATE_NO_TAGS = new Set(["BODY", "MAIN", "ARTICLE", "SECTION"]);

/** §3.4 role 強制黑名單。 */
const SKIP_ROLES = new Set([
	"presentation", "none", "math", "progressbar", "slider",
	"spinbutton", "scrollbar", "separator",
]);

// 三態節點處置（§0.1）。
/** @typedef {'SKIP_SUBTREE'|'OPAQUE_INLINE'|'WALK'} NodeDisposition */

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_PI = 7;
const NODE_COMMENT = 8;

// ============================================================================
// §2.1 block/inline 判斷收斂核心
// ============================================================================

/**
 * 所有 display 最終歸三條：startsWith('inline') ∨ === 'contents' ∨ startsWith('ruby')，否則 block。
 * @param {string} display
 * @returns {boolean}
 */
function isInlineDisplay(display) {
	if (!display) return false;
	if (display.startsWith("inline")) return true; // inline / inline-block / inline-flex|grid|table
	if (display === "contents") return true;        // §2.4 fallback 當 inline（透明穿透待升）
	if (display.startsWith("ruby")) return true;    // 實際只 cover <ruby> 容器
	return false;
}

/** @param {Element} el */
function hasText(el) {
	return el.textContent != null && el.textContent.trim().length > 0;
}

// ============================================================================
// §4 worthTranslating 內容過濾（inline 合併後 source 送翻前的純函式 gate）
// ============================================================================

const RE_WHITESPACE_ONLY = /^\p{White_Space}*$/u;
const RE_EMOJI_SHELL = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/u;
const RE_EMOJI_BODY = /^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍\p{White_Space}\p{P}\p{S}]*$/u;
const RE_PUNCT_ONLY = /^[\p{P}\p{S}\p{White_Space}]+$/u;
const RE_HAS_ALNUM = /[\p{L}\p{N}]/u;
// §4.2 numeric-only（補 \p{No}\p{Nl} 進字符類與守門）。
const RE_NUMERIC = /^[\p{Nd}\p{No}\p{Nl}\p{Sc}.,%+\-–—−:/()\p{White_Space}]+$/u;
const RE_HAS_NUM = /[\p{Nd}\p{No}\p{Nl}]/u;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// §4.3 URL（每 branch 各自 \S+；bare-domain branch 末段 TLD 守門＝≥2 ASCII 字母，擋 v1.2.3 / U.S.A / e.g）。
const RE_URL = /^(?:(?:https?:\/\/|ftp:\/\/|www\.)\S+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?)$/iu;
const RE_PATH = /^(?:\/|\.{1,2}\/|~\/|[a-z]:\\)\S*$/iu;
const RE_HAS_LETTER = /\p{L}/u;
const RE_HAS_HAN = /\p{Script=Han}/u;
const RE_HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const RE_HAS_HANGUL = /\p{Script=Hangul}/u;

/** §4.8 filename 白名單副檔名。 */
const KNOWN_EXT = new Set([
	"js", "ts", "jsx", "tsx", "mjs", "cjs", "json", "html", "htm", "css",
	"md", "txt", "csv", "xml", "yml", "yaml", "toml",
	"png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf",
	"zip", "tar", "gz", "rar", "7z",
	"mp3", "mp4", "mov", "wav", "avi", "mkv",
	"swift", "py", "rb", "go", "rs", "c", "h", "cpp", "java", "sh",
]);

/**
 * @typedef {object} WorthResult
 * @property {boolean} worth
 * @property {string=} reason
 */

/**
 * @param {string} raw
 * @param {{ pageLangIsZh?: boolean }} [opts]
 * @returns {WorthResult}
 */
function worthTranslating(raw, opts = {}) {
	// R0 NFC + trim（僅供判斷、不改 source）；顯式去 ZWSP / soft-hyphen。
	const t = raw.normalize("NFC").replace(/[​­]/gu, "").trim();

	if (t === "" || RE_WHITESPACE_ONLY.test(t)) return { worth: false, reason: "whitespace" };
	if (!RE_HAS_LETTER.test(t) && RE_EMOJI_SHELL.test(t) && RE_EMOJI_BODY.test(t)) {
		return { worth: false, reason: "emoji" };
	}
	if (RE_PUNCT_ONLY.test(t) && !RE_HAS_ALNUM.test(t)) return { worth: false, reason: "punct" };
	if (RE_NUMERIC.test(t) && RE_HAS_NUM.test(t) && !RE_HAS_LETTER.test(t)) {
		return { worth: false, reason: "numeric" };
	}
	if (RE_EMAIL.test(t)) return { worth: false, reason: "email" };
	if (RE_URL.test(t)) return { worth: false, reason: "url" };
	if (RE_PATH.test(t)) return { worth: false, reason: "path" };
	if (isFilenameOnly(t)) return { worth: false, reason: "filename" };

	// R9 already-target：整頁語言 gate（非逐段 Han-ratio）；kana / hangul 強制送翻。
	if (opts.pageLangIsZh && RE_HAS_HAN.test(t) && !RE_HAS_KANA.test(t) && !RE_HAS_HANGUL.test(t)) {
		return { worth: false, reason: "already-target" };
	}

	// R11 min-length：非漢字段，任何 \p{L} 字母數 < 2 才跳（非僅拉丁）。
	if (!RE_HAS_HAN.test(t)) {
		let letters = 0;
		for (const c of t) if (RE_HAS_LETTER.test(c)) letters++;
		if (letters < 2) return { worth: false, reason: "min-length" };
	}

	return { worth: true };
}

/** §4.8 單 token + 已知副檔名。 */
function isFilenameOnly(t) {
	if (/\s/u.test(t)) return false;
	const dot = t.lastIndexOf(".");
	if (dot <= 0 || dot === t.length - 1) return false;
	return KNOWN_EXT.has(t.slice(dot + 1).toLowerCase());
}

/**
 * §4.9 pageLangIsZh 偵測（P2）：main() 一次呼叫、餵給 makeContext，供 R9 already-target gate 用。
 * 純函式：優先讀 documentElement 的 lang（zh-Hant/zh-TW/zh-HK/裸 zh → true；zh-CN/zh-Hans → false，
 * 簡中頁仍需譯成目標 zh-Hant；明確非 zh 語碼 → false）；缺 lang 屬性才退回取樣文字 heuristic
 * （純漢字、無假名/諺文 → 視為中文頁，同 R9 逐段判斷邏輯）。
 * @param {string | null | undefined} htmlLang document.documentElement 的 lang 屬性
 * @param {string} [sample] 缺 lang 屬性時的取樣文字（如 document.body.textContent 片段；呼叫端截斷）
 * @returns {boolean}
 */
function detectPageLangIsZh(htmlLang, sample = "") {
	const lang = htmlLang?.toLowerCase().trim();
	if (lang) {
		if (lang === "zh-cn" || lang.startsWith("zh-hans")) return false;
		return lang === "zh" || lang.startsWith("zh-hant") || lang.startsWith("zh-tw") || lang.startsWith("zh-hk");
	}
	return RE_HAS_HAN.test(sample) && !RE_HAS_KANA.test(sample) && !RE_HAS_HANGUL.test(sample);
}

// ============================================================================
// ctx：採集情境（getStyle 注入、targetLang、站台覆寫、display 快取）
// ============================================================================

/**
 * @typedef {object} StyleInfo
 * @property {string} display
 * @property {string} visibility
 * @property {string} contentVisibility
 */

/**
 * @typedef {object} CollectContext
 * @property {string} targetLang
 * @property {boolean} pageLangIsZh
 * @property {(el: Element) => StyleInfo} getStyle
 * @property {WeakMap<Element, StyleInfo>} _styleCache
 */

/**
 * 瀏覽器預設 getStyle：getComputedStyle 一次、WeakMap 快取（§8）。
 * @param {Element} el
 * @param {WeakMap<Element, StyleInfo>} cache
 * @returns {StyleInfo}
 */
function browserGetStyle(el, cache) {
	let s = cache.get(el);
	if (s) return s;
	const cs = getComputedStyle(el);
	s = {
		display: cs.display,
		visibility: cs.visibility,
		contentVisibility: cs.getPropertyValue("content-visibility"),
	};
	cache.set(el, s);
	return s;
}

/**
 * @param {Partial<CollectContext>} [opts]
 * @returns {CollectContext}
 */
function makeContext(opts = {}) {
	const cache = opts._styleCache || new WeakMap();
	return {
		targetLang: opts.targetLang || "zh-Hant",
		pageLangIsZh: opts.pageLangIsZh ?? false,
		getStyle: opts.getStyle || ((el) => browserGetStyle(el, cache)),
		_styleCache: cache,
	};
}

// ============================================================================
// §5 classifyNode 判斷順序（短路最佳化、每元素一次 getStyle）
// ============================================================================

/**
 * @param {Node} node
 * @param {CollectContext} ctx
 * @returns {{ disp: NodeDisposition, cs: StyleInfo | null }}
 */
function classifyNode(node, ctx) {
	// [0] node type 閘
	if (node.nodeType === NODE_TEXT) return { disp: "WALK", cs: null };
	if (node.nodeType === NODE_COMMENT || node.nodeType === NODE_PI) {
		return { disp: "SKIP_SUBTREE", cs: null };
	}
	if (node.nodeType !== NODE_ELEMENT) return { disp: "SKIP_SUBTREE", cs: null };

	const el = /** @type {Element} */ (node);
	const tag = el.tagName;

	// [1] 自家標記（二次 walk 高命中、最便宜）
	if (el.hasAttribute("data-koine-id") || el.classList.contains("koine-translated")) {
		return { disp: "SKIP_SUBTREE", cs: null };
	}

	// [2] 硬標籤黑名單（Set.has O(1)、整棵剪枝）；MathML 命中根即整棵跳
	if (SKIP_SUBTREE_TAGS.has(tag) || tag === "MATH") return { disp: "SKIP_SUBTREE", cs: null };

	// [3] PRE → SKIP；CODE（祖先無 PRE）→ OPAQUE
	if (tag === "PRE") return { disp: "SKIP_SUBTREE", cs: null };
	if (tag === "CODE") {
		const inPre = typeof el.closest === "function" && el.closest("pre");
		return inPre ? { disp: "SKIP_SUBTREE", cs: null } : { disp: "OPAQUE_INLINE", cs: null };
	}

	// [4] OPAQUE_INLINE_TAGS（trim 非空才併）
	if (OPAQUE_INLINE_TAGS.has(tag)) {
		return hasText(el) ? { disp: "OPAQUE_INLINE", cs: null } : { disp: "SKIP_SUBTREE", cs: null };
	}

	// [5] 屬性隱藏 / 語意（純屬性讀取、無 reflow）
	if (el.getAttribute("aria-hidden") === "true") return { disp: "SKIP_SUBTREE", cs: null };
	if (el.hidden === true || el.hasAttribute("hidden")) return { disp: "SKIP_SUBTREE", cs: null };
	if (isContentEditable(el)) return { disp: "SKIP_SUBTREE", cs: null };
	const role = el.getAttribute("role");
	if (role && SKIP_ROLES.has(role.toLowerCase().trim())) return { disp: "SKIP_SUBTREE", cs: null };
	if (hasSkipClass(el)) return { disp: "SKIP_SUBTREE", cs: null };

	// [6] translate-no（容器白名單護欄）
	if (respectsTranslateNo(el)) {
		// block 級 → SKIP_SUBTREE；行內留待 §6 buffer 當 OPAQUE 併（此處先整棵跳，行內 case 由覆寫表處理）
		return { disp: "SKIP_SUBTREE", cs: null };
	}

	// [7] 站台覆寫（hostname → selector，v1 空表）— 預留

	// [8] lang 自身為目標語（不繼承）
	if (isAlreadyTargetLang(el, ctx.targetLang)) return { disp: "SKIP_SUBTREE", cs: null };

	// [9] getStyle（唯一一次）：display:none / visibility / content-visibility
	const cs = ctx.getStyle(el);
	if (cs.display === "none" || cs.display === "") return { disp: "SKIP_SUBTREE", cs };
	if (cs.contentVisibility === "hidden") return { disp: "SKIP_SUBTREE", cs };
	// visibility:hidden 不整棵跳（§3.7 B5）：自身不產段、續 walk 子孫 → 交給採集核心，此處放行
	return { disp: "WALK", cs };
}

/** contenteditable 繼承（§3.4 安全紅線）。 */
function isContentEditable(el) {
	if (typeof el.isContentEditable === "boolean") return el.isContentEditable;
	const v = el.getAttribute("contenteditable");
	return v === "" || v === "true";
}

/** §3.4 sr-only / visually-hidden class 比對。 */
function hasSkipClass(el) {
	return el.classList.contains("sr-only") || el.classList.contains("visually-hidden");
}

/** §3.5 translate="no" / .notranslate，大容器降級不尊重。 */
function respectsTranslateNo(el) {
	// 只看元素自身明示訊號（attribute / class）；不用 el.translate IDL——該屬性會繼承
	// 祖先 translate="no"，使大容器降級放行後、內層非大容器子代仍被當 no 而整棵跳
	// （真 WebKit 實證：跑道 B fixture 13 產空段；linkedom 不實作此 IDL 故跑道 A 抓不到）。
	// 與 §3.6 lang「只看自身不繼承」一致；元素自帶 explicit translate=no 仍由 getAttribute 命中。
	const no = el.getAttribute("translate") === "no"
		|| el.classList.contains("notranslate");
	if (!no) return false;
	return !BULK_TRANSLATE_NO_TAGS.has(el.tagName);
}

/** §3.6 lang 自身為目標語（只看自身、不繼承祖先）。依傳入 targetLang 判斷，非硬編 zh。 */
function isAlreadyTargetLang(el, targetLang) {
	const lang = el.getAttribute("lang")?.toLowerCase().trim();
	if (!lang || !targetLang) return false;
	const target = targetLang.toLowerCase().trim();
	// zh 目標：script 變體需嚴格區分，簡中（zh-CN/zh-Hans）不視為已達繁中目標（待 Apple 支援度實測）。
	if (target === "zh" || target.startsWith("zh-hant") || target.startsWith("zh-tw")) {
		if (lang === "zh-cn" || lang.startsWith("zh-hans")) return false;
		return lang === "zh" || lang.startsWith("zh-hant") || lang.startsWith("zh-tw");
	}
	if (target === "zh-cn" || target.startsWith("zh-hans")) {
		return lang === "zh-cn" || lang.startsWith("zh-hans");
	}
	// 非 zh 目標：比對 BCP-47 primary language subtag（忽略地區／script 子標籤）。
	return lang.split("-")[0] === target.split("-")[0];
}

// ============================================================================
// §6.5 classifyRegion 區域分類（P3）：Segment 標 main / chrome，供 §10 排程消費
// ============================================================================

/** @typedef {'main'|'chrome'} RegionValue */

/** Region enum（UNKNOWN 折進 MAIN）。順序非範圍：chrome 降權後仍翻、不跳過。 */
const Region = Object.freeze({ MAIN: "main", CHROME: "chrome" });

/** §6.5 landmark tag 對照（最近祖先勝：`<article><nav>` 內 TOC 判 CHROME）。 */
const REGION_MAIN_TAGS = new Set(["MAIN", "ARTICLE"]);
const REGION_CHROME_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
/** §6.5 landmark ARIA role 對照（banner=header、contentinfo=footer、complementary=aside）。 */
const REGION_MAIN_ROLES = new Set(["main", "article"]);
const REGION_CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

// §6.5 訊號① class/id regex（Readability unlikelyCandidates 式）。
// MAIN 先查＝both-match 偏 MAIN（非對稱預設的低害側，同 Readability okMaybeItsACandidate 救回）。
const RE_REGION_MAIN_HINT = /article|content|post|main|story|body|entry/i;
const RE_REGION_CHROME_HINT = /nav|menu|sidebar|footer|header|breadcrumb|widget|banner|promo|social|comment/i;

/**
 * 元素自身的 landmark region；非 landmark 回 null。role 先於 tag（顯式 ARIA 覆蓋隱式語意）。
 * @param {Element} el
 * @returns {RegionValue|null}
 */
function landmarkRegionOf(el) {
	if (typeof el.getAttribute === "function") {
		const role = el.getAttribute("role");
		if (role) {
			const r = role.toLowerCase().trim();
			if (REGION_MAIN_ROLES.has(r)) return Region.MAIN;
			if (REGION_CHROME_ROLES.has(r)) return Region.CHROME;
		}
	}
	const tag = el.tagName;
	if (REGION_MAIN_TAGS.has(tag)) return Region.MAIN;
	if (REGION_CHROME_TAGS.has(tag)) return Region.CHROME;
	return null;
}

/**
 * 元素自身的 class/id hint（§6.5 訊號①）；無訊號回 null。
 * @param {Element} el
 * @returns {RegionValue|null}
 */
function regionHintOf(el) {
	const cls = typeof el.className === "string" ? el.className : "";
	const id = el.id || "";
	if (!cls && !id) return null;
	const s = cls + " " + id;
	if (RE_REGION_MAIN_HINT.test(s)) return Region.MAIN;
	if (RE_REGION_CHROME_HINT.test(s)) return Region.CHROME;
	return null;
}

/**
 * §6.5 cascade 第 2/3 步：無 landmark 祖先時的三訊號 layout-free 評分（不讀 rect）。
 * ① 最近 class/id hint ±2；② link-density > 0.5 → CHROME +2；③ 文字長 >120 → MAIN +2、<40 → CHROME +1。
 * 同分/零訊號 → MAIN（非對稱預設：main 誤判 chrome 餓死正文＝高害、反向只是早譯＝低害）。
 * @param {Element} block
 * @param {RegionValue|null} hint  最近 class/id hint（含自身；由 walk stack 或 walk-up 提供）
 * @returns {RegionValue}
 */
function heuristicRegion(block, hint) {
	let main = 0;
	let chrome = 0;
	if (hint === Region.MAIN) main += 2;
	else if (hint === Region.CHROME) chrome += 2;
	const text = (block.textContent || "").trim();
	const len = text.length;
	if (len > 0 && typeof block.querySelectorAll === "function") {
		let linkLen = 0;
		for (const a of block.querySelectorAll("a")) linkLen += (a.textContent || "").trim().length;
		if (linkLen / len > 0.5) chrome += 2;
	}
	if (len > 120) main += 2;
	else if (len < 40) chrome += 1;
	return chrome > main ? Region.CHROME : Region.MAIN;
}

/**
 * §6.5 完整 cascade（walk-up 形；採集熱路徑用 walkAndLabel 下行 stack 增量等價版、O(1)/段）：
 * 1 最近 landmark 祖先（含自身）首個命中即定 → 2 無 landmark 時三訊號評分 → 3 不確定 MAIN。
 * @param {Element} el  段的 anchor.block
 * @returns {RegionValue}
 */
function classifyRegion(el) {
	for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		const r = landmarkRegionOf(n);
		if (r) return r;
	}
	/** @type {RegionValue|null} */
	let hint = null;
	for (let n = el; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		hint = regionHintOf(n);
		if (hint) break;
	}
	return heuristicRegion(el, hint);
}

// ============================================================================
// §9 Segment IR
// ============================================================================

const SegmentState = Object.freeze({
	PENDING: "pending", DRAFTING: "drafting", DRAFTED: "drafted",
	REFINING: "refining", REFINED: "refined", FAILED: "failed",
	SKIPPED: "skipped", STALE: "stale",
});

/**
 * @typedef {object} ProtectedSpan
 * @property {number} start
 * @property {number} end
 * @property {string} kind   // 'code' | 'time'
 */

/**
 * @typedef {object} Segment
 * @property {string} id
 * @property {number} order
 * @property {RegionValue} region   // §6.5 / §9.1：採集期算、留 JS 端不過 bridge
 * @property {string} source
 * @property {object} anchor
 * @property {string} state
 * @property {{ protectedSpans?: ProtectedSpan[], skipReason?: string, charCount?: number }} [meta]
 */

// ============================================================================
// §6 採集演算法（兩遍 walk + buffer flush）
// ============================================================================

/** 子節點走訪：open shadow root 穿透（§5 C1）。 */
function* childNodes(node) {
	for (const c of node.childNodes) yield c;
}

/**
 * @typedef {object} NodeLabel
 * @property {NodeDisposition} disp
 * @property {StyleInfo|null} cs
 * @property {boolean} isBlock         // shallow block ∨ 含 block 子（forceBlock 上傳）
 * @property {RegionValue|null} region     // §6.5 最近 landmark 祖先（含自身）；無 landmark 為 null
 * @property {RegionValue|null} regionHint // §6.5 最近 class/id hint（含自身）；無訊號為 null
 */

/**
 * 第一遍：標籤 + forceBlock 上傳 + 算 hasBlockDescendant + region landmark/hint 下行增量（§6.5）。
 * @param {Node} root
 * @param {CollectContext} ctx
 * @returns {WeakMap<Node, NodeLabel>}
 */
function walkAndLabel(root, ctx) {
	/** @type {WeakMap<Node, NodeLabel>} */
	const labels = new WeakMap();

	// §6.5 region 初始 context：root 祖先鏈的最近 landmark / hint（root 自身由 visit 首層算）。
	/** @type {RegionValue|null} */
	let rootLandmark = null;
	/** @type {RegionValue|null} */
	let rootHint = null;
	const rootEl = /** @type {Element} */ (root);
	for (let n = rootEl.parentElement; n && n.nodeType === NODE_ELEMENT; n = n.parentElement) {
		if (!rootLandmark) rootLandmark = landmarkRegionOf(n);
		if (!rootHint) rootHint = regionHintOf(n);
		if (rootLandmark && rootHint) break;
	}

	/**
	 * @param {Node} node
	 * @param {RegionValue|null} landmark  繼承的最近 landmark region
	 * @param {RegionValue|null} hint      繼承的最近 class/id hint
	 * @returns {boolean} hasBlockDescendant（含自身為 block）
	 */
	function visit(node, landmark, hint) {
		const { disp, cs } = classifyNode(node, ctx);
		if (disp === "SKIP_SUBTREE") {
			labels.set(node, { disp, cs, isBlock: false, region: landmark, regionHint: hint });
			return false;
		}
		if (disp === "OPAQUE_INLINE") {
			labels.set(node, { disp, cs, isBlock: false, region: landmark, regionHint: hint });
			return false; // 不展開、不可分割、視為 inline
		}
		// WALK
		if (node.nodeType === NODE_TEXT) {
			labels.set(node, { disp, cs, isBlock: false, region: landmark, regionHint: hint });
			return false;
		}

		const el = /** @type {Element} */ (node);
		// §6.5 下行增量：最近者勝（更近 landmark / hint 覆蓋繼承值）、O(1)/段。
		const region = landmarkRegionOf(el) || landmark;
		const nearHint = regionHintOf(el) || hint;
		let hasBlockChild = false;
		for (const child of childNodes(el)) {
			if (visit(child, region, nearHint)) hasBlockChild = true;
		}
		if (el.shadowRoot) {
			for (const child of childNodes(el.shadowRoot)) {
				if (visit(child, region, nearHint)) hasBlockChild = true;
			}
		}

		const shallowBlock = isShallowBlock(el, cs);
		// forceBlock 上傳：自身 block，或含 block 子（混排）→ 走 block flush 分支。
		const isBlock = shallowBlock || hasBlockChild;
		labels.set(node, { disp, cs, isBlock, region, regionHint: nearHint });
		return isBlock;
	}

	visit(root, rootLandmark, rootHint);
	return labels;
}

/** §2.2 shallow block 判斷（白名單先、computed 後）。 */
function isShallowBlock(el, cs) {
	if (FORCE_BLOCK_TAGS.has(el.tagName)) return true;
	const d = cs ? cs.display : "";
	if (d === "none" || d === "") return false;
	return !isInlineDisplay(d);
}

/**
 * 第二遍：用 labels 組翻譯單位（consecutiveInline 累積、block 邊界 flush）。
 * @param {Node} root
 * @param {CollectContext} ctx
 * @param {{ walkId?: number }} [opts]
 * @returns {Segment[]}
 */
function collectSegments(root, ctx, opts = {}) {
	const labels = walkAndLabel(root, ctx);
	const walkId = opts.walkId ?? 0;
	/** @type {Segment[]} */
	const segments = [];
	let order = 0;

	function labelOf(node) {
		return labels.get(node) || classifyLabel(node, ctx);
	}
	function classifyLabel(node, c) {
		const { disp, cs } = classifyNode(node, c);
		const isBlock = node.nodeType === NODE_ELEMENT && disp === "WALK"
			&& isShallowBlock(/** @type {Element} */ (node), cs);
		return { disp, cs, isBlock, region: null, regionHint: null };
	}
	/**
	 * §6.5 段 region：landmark 由第一遍 walk stack 增量取得；無 landmark 時 flush 點三訊號評分。
	 * @param {Node} blockNode
	 * @returns {RegionValue}
	 */
	function regionOfBlock(blockNode) {
		if (!blockNode || blockNode.nodeType !== NODE_ELEMENT) return Region.MAIN;
		const el = /** @type {Element} */ (blockNode);
		const label = labels.get(blockNode);
		if (label && label.region) return label.region;
		if (label) return heuristicRegion(el, label.regionHint);
		return classifyRegion(el); // 不在 labels（防禦路徑）→ 完整 walk-up cascade
	}

	function collect(node) {
		/** @type {Node[]} */
		let buffer = [];
		const flushHere = () => {
			if (buffer.length) makeSegmentFromBuffer(buffer, node);
			buffer = [];
		};
		for (const child of childNodes(node)) {
			if (child.nodeType === NODE_COMMENT || child.nodeType === NODE_PI) continue; // G5
			const { disp, isBlock } = labelOf(child);
			if (disp === "SKIP_SUBTREE") continue; // 不切段：跳過不可見/無關子樹，buffer 續接
			if (child.nodeType === NODE_ELEMENT && child.tagName === "BR") {
				buffer.push(child); // §6.2 BR→\n（extractText 處理）
				continue;
			}
			if (disp === "OPAQUE_INLINE") { buffer.push(child); continue; }
			if (!isBlock) { buffer.push(child); continue; } // inline / text → 累積
			// block → 先 flush 既有 buffer，再遞迴
			flushHere();
			collect(child);
		}
		flushHere();
	}

	function makeSegmentFromBuffer(buf, blockNode) {
		const { text, spans } = extractText(buf);
		const source = normalizeSource(text);
		if (source === "") return; // §6 / C2：純空白間隔不產段（連 skipped 都不建）
		const wt = worthTranslating(source, { pageLangIsZh: ctx.pageLangIsZh });
		const id = makeId(walkId, order);
		const region = regionOfBlock(blockNode);
		if (!wt.worth) {
			segments.push({
				id, order, region, source, anchor: makeAnchor(buf, blockNode),
				state: SegmentState.SKIPPED, meta: { skipReason: wt.reason, charCount: source.length },
			});
			order++;
			return;
		}
		/** @type {Segment} */
		const seg = {
			id, order, region, source, anchor: makeAnchor(buf, blockNode), state: SegmentState.PENDING,
		};
		if (spans.length) seg.meta = { protectedSpans: spans, charCount: source.length };
		segments.push(seg);
		order++;
	}

	collect(root);
	return segments;
}

/** §8.1 id = "k" + base36(walkId) + "-" + base36(order)。 */
function makeId(walkId, order) {
	return "k" + (walkId >>> 0).toString(36) + "-" + (order >>> 0).toString(36);
}

/**
 * §6.4 / §9.2 anchor 載體：block = 正在收的 block 容器（collect frame 透傳，
 * 比事後 closestBlock(段末節點) 準——巢狀 inline 的段末是 inline 父，會落錯位）；
 * refNode 指段末節點（re-query / v2 替換用）。
 */
function makeAnchor(buf, blockNode) {
	return { block: blockNode || null, insertMode: "after-segment", refNode: buf[buf.length - 1] };
}

// ============================================================================
// §6.2 extractText 三特判（br / ruby / contents）+ 記 code/time protectedSpans
// ============================================================================

/**
 * @param {Node[]} buf
 * @returns {{ text: string, spans: ProtectedSpan[] }}
 */
function extractText(buf) {
	let text = "";
	/** @type {ProtectedSpan[]} */
	const spans = [];
	for (const node of buf) {
		text = appendNode(node, text, spans);
	}
	return { text, spans };
}

function appendNode(node, text, spans) {
	if (node.nodeType === NODE_TEXT) return text + (node.nodeValue || "");
	if (node.nodeType !== NODE_ELEMENT) return text;
	const el = /** @type {Element} */ (node);
	const tag = el.tagName;
	if (tag === "BR") return text + "\n";                 // §6.2-1
	if (tag === "RT" || tag === "RP") return text;        // §6.2-2 ruby 只取 base
	if (OPAQUE_INLINE_TAGS.has(tag)) {                    // code/time 原子 + 記 protectedSpan
		const piece = el.textContent || "";
		const start = text.length;
		text += piece;
		spans.push({ start, end: text.length, kind: tag.toLowerCase() });
		return text;
	}
	// 其餘 inline 元素：遞迴子節點（ruby base、巢狀 inline、contents 容器）
	for (const child of childNodes(el)) {
		text = appendNode(child, text, spans);
	}
	return text;
}

/** 空白正規化但保 \n（§11.3）：折疊空白為單一空格、保留換行、trim 兩端。 */
function normalizeSource(text) {
	return text
		.replace(/[^\S\n]+/gu, " ")  // 非換行空白折疊成單空格
		.replace(/ *\n */gu, "\n")    // 換行兩側空白吃掉
		.replace(/\n{2,}/gu, "\n")    // 多換行折疊
		.trim();
}

// ============================================================================
// §7.1 並列插回 render 層（採集之後的獨立 pass；§8 讀寫分離：採集期不寫 DOM）
// ============================================================================

/**
 * 把帶譯文的 segment 並列插回 DOM：對每個 `drafted` 且有譯文的 segment，
 * 在其 `anchor.block` 之後（`block.after`）插一個雙語譯文 wrapper（§7.1）。
 *
 * wrapper 帶 `data-koine-id` + `koine-translated` class——再次採集時 classifyNode [1]
 * 先擋自家標記、整棵跳過，故插回不會被自己重採（§7.1 (c) 自吞防護）。
 * 只新增 sibling、不動原文節點（§7.1 (b)）。
 *
 * @param {Segment[]} segments
 * @param {{ tag?: string }} [opts]   tag 預設 `div`（M1 固定 block；tag-mirror 留後續）
 * @returns {Element[]} 已插入的 wrapper 元素（依插入序）
 */
function insertTranslations(segments, opts = {}) {
	const tag = opts.tag || "div";
	/** @type {Element[]} */
	const inserted = [];
	for (const seg of segments) {
		if (seg.state !== SegmentState.DRAFTED) continue; // 只消費 drafted（pending / skipped 跳過）
		const text = seg.refined ?? seg.draft;            // §9.1 並列取值 refined ?? draft
		if (text == null || text === "") continue;        // 無譯文 / 譯文=空 不插
		const block = seg.anchor && seg.anchor.block;
		if (!block || typeof block.after !== "function") continue;
		const doc = block.ownerDocument;
		if (!doc) continue;
		const wrapper = doc.createElement(tag);
		wrapper.setAttribute("data-koine-id", seg.id);
		wrapper.className = "koine-translated";
		wrapper.textContent = text;
		block.after(wrapper);
		inserted.push(wrapper);
	}
	return inserted;
}

// ============================================================================
// §10 進場排程（P3 tiered dispatch + priorityGate；lazy 進場才觸發取譯）
// ============================================================================

/** §10.1 eager 預算：文件序前 N 個 MAIN pending 段載入即發（chrome 永不 eager）。 */
const EAGER_MAIN_BUDGET = 10;
/** §10.1 tiered IO rootMargin：main 讀前預取、chrome 近了才排。 */
const MAIN_ROOT_MARGIN = "1200px";
const CHROME_ROOT_MARGIN = "400px";
/** §10.2 distanceBucket 桶寬（px）：微滾動不重洗牌。 */
const DISTANCE_BUCKET_PX = 300;
/** §10.2 滾動 re-sort throttle（ms）：≈ dispatch cadence（daemon ~3 段/秒、更快是白工）。 */
const RESORT_THROTTLE_MS = 200;

/**
 * 瀏覽器預設 observer 工廠：包 `IntersectionObserver`。
 * 跑道 A（linkedom）無此 API，故 body 內才 new——測試一律由 opts 注入 stub、不會走到這。
 * @param {IntersectionObserverCallback} cb
 * @param {IntersectionObserverInit} options
 * @returns {IntersectionObserver}
 */
function defaultMakeObserver(cb, options) {
	return new IntersectionObserver(cb, options);
}

/**
 * 瀏覽器預設段距視窗量測：block 距視窗邊緣的 px（0 = 相交）。
 * 只在 priorityGate 的 throttled re-bucket 批次讀呼叫、不進採集/分類路徑（§8 讀寫分離不破）。
 * 跑道 A（linkedom）由 opts.measure 注入 stub。
 * @param {Element} block
 * @returns {number}
 */
function defaultMeasure(block) {
	if (!block || typeof block.getBoundingClientRect !== "function") return 0;
	const rect = block.getBoundingClientRect();
	const vh = typeof innerHeight === "number" ? innerHeight : 0;
	if (rect.bottom < 0) return -rect.bottom;  // 已滾過（視窗上方）
	if (rect.top > vh) return rect.top - vh;    // 未到（視窗下方）
	return 0;                                   // 相交
}

/**
 * §10 排程：對 `pending` segment 做 tiered dispatch + priorityGate（P3）。
 *
 * tiered dispatch（§10.1）——所有觸發餵進同一個 priorityGate：
 * - main eager：文件序前 `eagerBudget`（預設 EAGER_MAIN_BUDGET=10）個 MAIN 段**載入即發**、不等 IO。
 * - main lazy：IO rootMargin 1200px（讀前預取）；chrome lazy：IO rootMargin 400px（近了才排）。
 * - 進場即 unobserve（一次性）；已入列段不重複入列；全段已 eager 的 block 免觀察。
 *
 * priorityGate（§10.2）——FIFO → min-first 優先佇列：
 * - sortKey = (viewportBand, regionRank, distanceBucket@300px, order)，lexicographic、dequeue 最小。
 * - 滾動 re-sort：scroll → throttle ~200ms trailing → rAF → 只 re-bucket 未 dispatch 段。
 * - 併發閘門 maxInFlight（預設 6）不變（§10 D3，on-device 硬約束；真閘門是 daemon ~3 段/秒）。
 *
 * 只做「排程 + 閘門 + 呼鉤子」、不碰 bridge——`onEnter` 由呼叫端注入（C 接 native bridge、
 * 測試塞 fake）。只排 `pending` 段（skipped / drafted / 無 block 跳過）；每個 block 只
 * observe 一次（多段共用同一 block 時進場一併入列）。
 *
 * @param {Segment[]} segments
 * @param {{
 *   onEnter: (seg: Segment) => (void | Promise<void>),
 *   maxInFlight?: number,
 *   makeObserver?: (cb: Function, options: object) => { observe: Function, unobserve: Function, disconnect?: Function },
 *   measure?: (block: Element) => number,
 *   eagerBudget?: number,
 *   rootMargin?: string,        // 覆寫兩層（相容舊單層呼叫）
 *   mainRootMargin?: string,
 *   chromeRootMargin?: string,
 *   threshold?: number,
 * }} opts
 * @returns {{ observer: object|null, observers: object[], resort: () => void, disconnect: () => void }}
 *   disconnect() 停 observer + 清未 dispatch 的排隊段；resort() 手動觸發 re-bucket（測試 / throttle 目標）
 */
function observeSegments(segments, opts) {
	const onEnter = opts.onEnter;
	if (typeof onEnter !== "function") {
		throw new TypeError("observeSegments: opts.onEnter 必須為 function（取譯觸發鉤子、必填）");
	}
	const maxInFlight = opts.maxInFlight ?? 6;
	const makeObserver = opts.makeObserver || defaultMakeObserver;
	const measure = opts.measure || defaultMeasure;
	const eagerBudget = opts.eagerBudget ?? EAGER_MAIN_BUDGET;

	// block → 該 block 綁的 pending 段（多段共用同一 block 時進場一併入列）。
	/** @type {Map<Element, Segment[]>} */
	const blockToSegs = new Map();
	/** @type {Segment[]} */
	const pendings = [];
	for (const seg of segments) {
		if (seg.state !== SegmentState.PENDING) continue; // 只排待譯段
		const block = seg.anchor && seg.anchor.block;
		if (!block) continue;
		pendings.push(seg);
		let arr = blockToSegs.get(block);
		if (!arr) { arr = []; blockToSegs.set(block, arr); }
		arr.push(seg);
	}

	// ---- priorityGate（§10.2）----------------------------------------------
	/** @type {Segment[]} */
	const queued = [];                 // 已觸發、未 dispatch 的段（min-first）
	const enqueuedSet = new WeakSet(); // 防重複入列（eager 與 IO 觸發可能重疊）
	/** @type {Map<Segment, number[]>} */
	const keys = new Map();            // seg → sortKey tuple（re-bucket 時全量 re-key）
	let dirty = false;                 // 佇列需重排（入列 / re-key 後 lazy sort）
	let inFlight = 0;
	let disconnected = false;

	/** sortKey = (viewportBand, regionRank, distanceBucket, order)（§10.2、dequeue 最小）。 */
	function keyOf(seg) {
		const d = Number(measure(seg.anchor && seg.anchor.block)) || 0;
		const band = d <= 0 ? 0 : 1;                                  // 0 = 與視窗相交、壓過一切
		const rank = seg.region === Region.CHROME ? 1 : 0;            // offscreen 時 region 壓過 distance
		const bucket = d <= 0 ? 0 : Math.floor(d / DISTANCE_BUCKET_PX);
		return [band, rank, bucket, seg.order || 0];
	}
	function compareSegs(a, b) {
		const ka = keys.get(a);
		const kb = keys.get(b);
		for (let i = 0; i < 4; i++) {
			if (ka[i] !== kb[i]) return ka[i] - kb[i];
		}
		return 0;
	}
	function enqueue(seg) {
		if (enqueuedSet.has(seg)) return;
		enqueuedSet.add(seg);
		keys.set(seg, keyOf(seg));
		queued.push(seg);
		dirty = true;
	}
	function dequeueMin() {
		if (dirty) {
			queued.sort(compareSegs); // 集合小（pending 遞縮）、sorted-array 與 heap 等效（§10.2）
			dirty = false;
		}
		return queued.shift();
	}
	/** re-bucket：只 re-key 未 dispatch 段（量測批次讀、throttled）。 */
	function resort() {
		if (disconnected || queued.length === 0) return;
		for (const seg of queued) keys.set(seg, keyOf(seg));
		dirty = true;
	}
	function pump() {
		while (!disconnected && inFlight < maxInFlight && queued.length > 0) {
			const seg = dequeueMin();
			inFlight++;
			// 包進 promise 鏈：吸收 onEnter 的同步 throw / 回傳 Promise，settle 後補位。
			Promise.resolve().then(() => onEnter(seg)).then(settle, settle);
		}
	}
	function settle() {
		inFlight--;
		pump();
	}

	// ---- 滾動 re-sort throttle（§10.2：scroll → ~200ms trailing → rAF → resort）----
	/** @type {any} */
	let resortTimer = null;
	const raf = typeof requestAnimationFrame === "function"
		? requestAnimationFrame
		: /** @param {() => void} fn */ (fn) => { fn(); return 0; };
	function scheduleResort() {
		if (disconnected || resortTimer != null) return; // throttle：窗內合併、窗尾（trailing）必觸發
		resortTimer = setTimeout(() => {
			resortTimer = null;
			raf(() => resort());
		}, RESORT_THROTTLE_MS);
	}
	const scrollTarget = typeof window !== "undefined" ? window : null;
	const onScroll = scrollTarget ? () => scheduleResort() : null;
	if (scrollTarget && onScroll) scrollTarget.addEventListener("scroll", onScroll, { passive: true });

	// ---- tiered dispatch（§10.1）--------------------------------------------
	// main eager：文件序前 N 個 MAIN pending 段、載入即發（不等 IO callback）。
	if (eagerBudget > 0) {
		const mains = pendings
			.filter((s) => s.region !== Region.CHROME) // region 缺省折進 MAIN（§6.5 非對稱預設）
			.sort((a, b) => (a.order || 0) - (b.order || 0));
		const n = Math.min(eagerBudget, mains.length);
		for (let i = 0; i < n; i++) enqueue(mains[i]);
	}

	// lazy：兩層 IO（main / chrome 各一、rootMargin 不同），全段已 eager 的 block 免觀察。
	const threshold = opts.threshold ?? 0.1;
	const tierMargins = {
		main: opts.rootMargin || opts.mainRootMargin || MAIN_ROOT_MARGIN,
		chrome: opts.rootMargin || opts.chromeRootMargin || CHROME_ROOT_MARGIN,
	};
	/** @type {{ main: Element[], chrome: Element[] }} */
	const tierBlocks = { main: [], chrome: [] };
	for (const [block, segs] of blockToSegs) {
		if (segs.every((s) => enqueuedSet.has(s))) continue; // 全 eager → 免觀察
		tierBlocks[segs[0].region === Region.CHROME ? "chrome" : "main"].push(block);
	}
	const ioCallback = (entries, obs) => {
		if (disconnected) return;
		let added = false;
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			obs.unobserve(entry.target); // 進場即 unobserve：一次性、不重複觸發
			const segs = blockToSegs.get(entry.target);
			if (!segs) continue;
			for (const seg of segs) {
				if (enqueuedSet.has(seg)) continue;
				enqueue(seg);
				added = true;
			}
		}
		if (added) pump();
	};
	/** @type {object[]} */
	const observers = [];
	for (const tier of /** @type {const} */ (["main", "chrome"])) {
		if (!tierBlocks[tier].length) continue;
		const obs = makeObserver(ioCallback, { root: null, rootMargin: tierMargins[tier], threshold });
		observers.push(obs);
		for (const block of tierBlocks[tier]) obs.observe(block);
	}

	pump(); // eager 段即刻 dispatch（載入即發）

	return {
		observer: observers[0] || null,
		observers,
		resort, // 手動 re-bucket（測試用；throttle 路徑的目標函式）
		// disconnect：停 observer + 清空尚未 dispatch 的排隊段（已 in-flight 的 onEnter 無法取消）。
		disconnect() {
			disconnected = true;
			queued.length = 0;
			keys.clear();
			if (resortTimer != null) { clearTimeout(resortTimer); resortTimer = null; }
			if (scrollTarget && onScroll) scrollTarget.removeEventListener("scroll", onScroll);
			for (const obs of observers) {
				if (typeof obs.disconnect === "function") obs.disconnect();
			}
		},
	};
}

// ============================================================================
// §9.4 bridge 串接：onEnter 取譯 → 狀態機 pending→drafting→drafted/failed → 插回
// ============================================================================

/**
 * 單段取譯：送 { id, source, from, to } 過 bridge → 回 { id, text } / { id, error } →
 * 落狀態機並在成功時插回。進場觀察的 onEnter 掛此函式（B 的鉤子由此接真 send）。
 * `send` 由呼叫端注入（瀏覽器走 background sendMessage、測試塞 fake）、回 Promise。
 * M1 不 retry（failed 即終態、記 meta.failReason）。
 *
 * @param {Segment} seg
 * @param {(req: { id: string, source: string, from?: string, to?: string }) => Promise<any>} send
 * @param {{ from?: string, to?: string, insertOpts?: object }} [opts]
 * @returns {Promise<void>}
 */
async function translateSegment(seg, send, opts = {}) {
	if (seg.state !== SegmentState.PENDING) return; // 只譯 pending
	seg.state = SegmentState.DRAFTING;
	let res;
	try {
		res = await send({ id: seg.id, source: seg.source, from: opts.from, to: opts.to });
	} catch (e) {
		seg.state = SegmentState.FAILED;
		seg.meta = Object.assign({}, seg.meta, { failReason: String(e) });
		return;
	}
	if (!res || res.error != null || typeof res.text !== "string") {
		seg.state = SegmentState.FAILED;
		seg.meta = Object.assign({}, seg.meta, {
			failReason: (res && res.error != null) ? String(res.error) : "no-text",
		});
		return;
	}
	// §9.1：res.text === "" = 譯文＝原文、不顯示（有效終態、非失敗）；insertTranslations 自會跳過。
	seg.draft = res.text;
	seg.state = SegmentState.DRAFTED;
	// render 獨立 pass：insert 例外不回溯污染已定案的 drafted（§7.1 讀寫分離、關注點分離）。
	insertTranslations([seg], opts.insertOpts);
}

/**
 * 組 native bridge 訊息（background 轉 sendNativeMessage）。抽成具名純函式供測試斷言線上形狀。
 * @param {{ id: string, source: string, from?: string, to?: string }} req
 * @returns {{ type: string, id: string, source: string, from?: string, to?: string }}
 */
function buildBridgeMessage(req) {
	return { type: "translate", id: req.id, source: req.source, from: req.from, to: req.to };
}

// ============================================================================
// 瀏覽器自動執行：採集 → 進場觀察 → 取譯 → 插回（M1 完整管線）
// ============================================================================

function main() {
	console.log("[雅言] content script loaded");
	const htmlLang = document.documentElement.getAttribute("lang");
	// 無 lang 屬性才取樣（避免無謂 textContent 讀取）；純讀不觸發 reflow。
	const sample = htmlLang ? "" : (document.body?.textContent || "").slice(0, 500);
	const ctx = makeContext({ pageLangIsZh: detectPageLangIsZh(htmlLang, sample) });
	const segments = collectSegments(document.body, ctx, { walkId: 1 });
	if (!segments.length) return;
	const from = htmlLang || undefined;
	const send = (req) => browser.runtime.sendMessage(buildBridgeMessage(req));
	observeSegments(segments, {
		onEnter: (seg) => translateSegment(seg, send, { from, to: ctx.targetLang }),
	});
}

if (typeof document !== "undefined" && typeof browser !== "undefined") {
	main();
}

// ============================================================================
// 測試取用尾巴（browser classic script：module 不存在、globalThis 沙盒安全）
// ============================================================================

const __koineExports = {
	FORCE_BLOCK_TAGS, SKIP_SUBTREE_TAGS, OPAQUE_INLINE_TAGS, SegmentState,
	Region, EAGER_MAIN_BUDGET,
	isInlineDisplay, hasText, worthTranslating, isFilenameOnly, detectPageLangIsZh,
	isAlreadyTargetLang,
	makeContext, classifyNode, isShallowBlock, classifyRegion, heuristicRegion,
	walkAndLabel, collectSegments, extractText, normalizeSource, makeId,
	insertTranslations, observeSegments, translateSegment, buildBridgeMessage,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = __koineExports;
}
if (typeof globalThis !== "undefined") {
	globalThis.__koine__ = __koineExports;
}
