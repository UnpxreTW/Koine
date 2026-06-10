import ProjectDescription

let project = Project(
	name: "Koine",
	organizationName: "Unpxre",
	options: .options(
		defaultKnownRegions: ["zh-Hant"],
		developmentRegion: "zh-Hant"
	),
	packages: [
		.remote(
			url: "https://github.com/UnpxreTW/SwiftStyleKit",
			requirement: .upToNextMajor(from: "1.2.0")
		),
		.remote(
			url: "https://github.com/apple/swift-argument-parser",
			requirement: .upToNextMajor(from: "1.5.0")
		),
	],
	targets: [
		// Host App：Safari Web Extension 的容器殼（引導啟用、提示語言包），翻譯本體在 Extension。
		// PoC 1 先 macOS 起手——本機 Safari 最短路徑驗 NSExtension 內翻譯通路；iOS target 待 PoC 過後加。
		.target(
			name: "KoineApp",
			destinations: .macOS,
			product: .app,
			bundleId: "me.unpxre.koine",
			deploymentTargets: .macOS("26.0"),
			infoPlist: .extendingDefault(with: [
				"CFBundleDisplayName": "雅言",
			]),
			sources: ["Sources/App/**/*.swift"],
			entitlements: .dictionary([
				"com.apple.security.app-sandbox": true,
			]),
			dependencies: [
				.target(name: "KoineExtension"),
				.package(product: "SwiftStyleLint", type: .plugin),
			]
		),
		// Safari Web Extension：native handler 委派核心 Koine 翻譯（PoC 1 驗證標的）。
		// 核心源檔直接掛進本 target（源碼級共用）：Tuist graph linter 不支援
		// appExtension → staticFramework 依賴組合；同一份源檔、無重複，待日後評
		// dynamic framework（appex 與 app 共用 embed）或 local SPM package 再恢復 module 邊界。
		.target(
			name: "KoineExtension",
			destinations: .macOS,
			product: .appExtension,
			bundleId: "me.unpxre.koine.Extension",
			deploymentTargets: .macOS("26.0"),
			infoPlist: .extendingDefault(with: [
				"CFBundleDisplayName": "雅言",
				"NSExtension": [
					"NSExtensionPointIdentifier": "com.apple.Safari.web-extension",
					"NSExtensionPrincipalClass": "$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler",
				],
			]),
			sources: ["Sources/Extension/**/*.swift", "Sources/Koine/**/*.swift"],
			resources: ["Sources/Extension/Resources/**"],
			// App Extension 硬性要求 App Sandbox——缺它 pluginkit 直接拒收、Safari 看不到擴充。
			entitlements: .dictionary([
				"com.apple.security.app-sandbox": true,
			]),
			dependencies: [
				.package(product: "SwiftStyleLint", type: .plugin),
			]
		),
		// 核心庫：翻譯引擎與抽象層，供 CLI 與日後 app / extension 共用。
		.target(
			name: "Koine",
			destinations: .macOS,
			product: .staticFramework,
			bundleId: "me.unpxre.koine.core",
			deploymentTargets: .macOS("26.0"),
			sources: ["Sources/Koine/**/*.swift"],
			dependencies: [
				.package(product: "SwiftStyleLint", type: .plugin),
			]
		),
		// CLI 包裝：argument-parser 入口，委派核心 Koine。
		// target 名 KoineCLI——避開與核心庫 Koine 在大小寫不敏感檔案系統的建置目錄 / 模組碰撞；
		// 執行檔名以 productName 固定為 koine，命令名由 CommandConfiguration 固定為 koine。
		// PRODUCT_MODULE_NAME 須顯式設回 KoineCLI：否則從 productName 推導出 module 名 koine，
		// 其 koine.swiftmodule 落在 build products 平面目錄、incremental build 時 `import Koine`
		// 大小寫不敏感誤中而炸 "cannot load module 'koine' as 'Koine'"（clean build 看不到）。
		.target(
			name: "KoineCLI",
			destinations: .macOS,
			product: .commandLineTool,
			productName: "koine",
			bundleId: "me.unpxre.koine.cli",
			deploymentTargets: .macOS("26.0"),
			sources: ["Sources/CLI/**/*.swift"],
			dependencies: [
				.target(name: "Koine"),
				.package(product: "ArgumentParser"),
				.package(product: "SwiftStyleLint", type: .plugin),
			],
			settings: .settings(base: ["PRODUCT_MODULE_NAME": "KoineCLI"])
		),
	],
	// Tuist 自動 scheme 生成漏了 KoineApp（KoineExtension / KoineCLI 都有）——顯式宣告補上。
	schemes: [
		.scheme(
			name: "KoineApp",
			buildAction: .buildAction(targets: ["KoineApp"]),
			runAction: .runAction(executable: "KoineApp")
		),
	]
)
