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
	]
)
