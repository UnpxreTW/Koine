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
            requirement: .upToNextMajor(from: "1.1.2")
        ),
        .remote(
            url: "https://github.com/apple/swift-argument-parser",
            requirement: .upToNextMajor(from: "1.5.0")
        ),
    ],
    targets: [
        // CLI 前端：給人類與 AI 工具（Claude Code）共用的 macOS 命令列工具。
        // macOS native executable，不碰 simulator——繞開 CoreSimulator daemon blocker，
        // 同時是驗證 TranslationSession standalone init 在 headless 環境跑通的最純 PoC。
        .target(
            name: "koine",
            destinations: .macOS,
            product: .commandLineTool,
            bundleId: "me.unpxre.koine.cli",
            deploymentTargets: .macOS("26.0"),
            sources: ["CLI/Sources/**/*.swift"],
            dependencies: [
                .package(product: "ArgumentParser"),
                .package(product: "SwiftStyleLint", type: .plugin),
            ]
        ),
    ]
)
