import AppKit
import Foundation
import CFNetwork

struct QuotaWindow: Decodable {
    let key: String
    let remainingPercent: Double?
    let minutes: Int?
    let resetsAt: Double?
}
struct QuotaBucket: Decodable { let id: String; let windows: [QuotaWindow] }
struct Quotas: Decodable { let data: [QuotaBucket]; let updatedAt: Double?; let stale: Bool }
struct Snapshot: Decodable { let quotas: Quotas }
struct Service: Decodable { let token: String; let origin: String }
struct Config: Decodable { let node: String; let descriptor: String; let origin: String }

func shortQuota(_ value: Double?, stale: Bool) -> String {
    guard let value = value, value.isFinite else { return "—%" }
    return "\(Int(max(0, min(100, value)).rounded()))%\(stale ? "*" : "")"
}
func proxyTitle(connected: Bool, viaProxy: Bool?, configured: Bool) -> String {
    if connected, let viaProxy = viaProxy { return viaProxy ? "代理✓" : "直连" }
    return configured ? "代理!" : "代理?"
}
func selectedWindow(_ data: [QuotaBucket]) -> QuotaWindow? {
    let bucket = data.first(where: { $0.id == "codex" }) ?? data.first
    return bucket?.windows.first(where: { $0.key == "primary" }) ?? bucket?.windows.first
}

final class Probe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    var session: URLSession!
    var task: URLSessionDataTask?
    var viaProxy: Bool?
    var response: HTTPURLResponse?
    var started = Date()
    var configured = false
    var completion: ((String, String) -> Void)?
    override init() {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 10
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue.main)
    }
    func check() {
        guard task == nil else { return }
        viaProxy = nil; response = nil; started = Date()
        let proxy = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] ?? [:]
        configured = ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"].contains { (proxy[$0] as? NSNumber)?.boolValue == true }
        var req = URLRequest(url: URL(string: "https://chatgpt.com/")!)
        req.httpMethod = "HEAD"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        task = session.dataTask(with: req); task?.resume()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        viaProxy = metrics.transactionMetrics.last?.isProxyConnection
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = response?.statusCode
        let connected = code != nil && code != 407 && error == nil
        let text = proxyTitle(connected: connected, viaProxy: viaProxy, configured: configured)
        let elapsed = Int(Date().timeIntervalSince(started) * 1000)
        let detail: String
        if let code = code, error == nil {
            let route = viaProxy == true ? "探测确认经过代理" : viaProxy == false ? "探测未经过显式代理" : "代理路径未确认"
            detail = "\(route) · HTTP \(code) · \(elapsed) ms"
        } else {
            detail = configured ? "已配置系统代理，但探测未成功" : "未检测到系统代理，连接状态未确认"
        }
        self.task = nil; completion?(text, detail)
    }
}

final class PulseApp: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var config: Config!
    var service: Service?
    var snapshot: Snapshot?
    var quotaAt: Date?
    var quotaFailed = true
    var fetching = false
    var proxyText = "代理?"
    var proxyDetail = "正在检测系统代理…"
    var probeAt: Date?
    var timer: Timer?
    var networkTimer: Timer?
    var starter: Process?
    var lastStart = Date.distantPast
    let probe = Probe()
    let quotaLine = NSMenuItem(title: "正在读取额度…", action: nil, keyEquivalent: "")
    let weekLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let networkLine = NSMenuItem(title: "正在检测代理…", action: nil, keyEquivalent: "")
    let updatedLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    lazy var localSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.timeoutIntervalForRequest = 4
        return URLSession(configuration: c)
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        if NSRunningApplication.runningApplications(withBundleIdentifier: "local.codex.pulse.menubar").filter({ $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }).count > 0 { NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        do {
            let url = Bundle.main.url(forResource: "config", withExtension: "json")!
            config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: url))
        } catch { NSApp.terminate(nil); return }
        // One-time local placement hint. macOS ultimately owns menu-bar layout.
        // Keep subsequent user Cmd-drag placement intact.
        if !UserDefaults.standard.bool(forKey: "pulsePlacedNearClockV1") {
            UserDefaults.standard.set(100, forKey: "NSStatusItem Preferred Position CodexPulseStatus")
            UserDefaults.standard.set(true, forKey: "pulsePlacedNearClockV1")
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "CodexPulseStatus"
        item.isVisible = true
        item.button?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        let menu = NSMenu()
        for line in [quotaLine, weekLine, networkLine, updatedLine] { line.isEnabled = false; menu.addItem(line) }
        menu.addItem(.separator())
        let note = NSMenuItem(title: "* 额度过期 · 代理检测不含 VPN/TUN", action: nil, keyEquivalent: ""); note.isEnabled = false; menu.addItem(note)
        let refreshItem = NSMenuItem(title: "刷新", action: #selector(refresh), keyEquivalent: "r"); refreshItem.target = self; menu.addItem(refreshItem)
        let dashboard = NSMenuItem(title: "详细面板", action: #selector(openDashboard), keyEquivalent: ""); dashboard.target = self; menu.addItem(dashboard)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出菜单栏", action: #selector(quitApp), keyEquivalent: "q"); quit.target = self; menu.addItem(quit)
        item.menu = menu
        probe.completion = { [weak self] text, detail in self?.proxyText = text; self?.proxyDetail = detail; self?.probeAt = Date(); self?.render() }
        render(); fetchQuota(); probe.check()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.fetchQuota(); self?.render() }
        networkTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.probe.check() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
    }
    func readService() -> Service? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: config.descriptor)), let s = try? JSONDecoder().decode(Service.self, from: data), s.origin == config.origin, s.token.count == 64, s.token.allSatisfy({ $0.isHexDigit }) else { return nil }
        return s
    }
    func startService() {
        guard starter == nil, Date().timeIntervalSince(lastStart) > 60 else { return }
        lastStart = Date()
        let process = Process(); starter = process
        process.executableURL = URL(fileURLWithPath: config.node)
        process.arguments = [Bundle.main.resourceURL!.appendingPathComponent("monitor/src/cli.mjs").path, "start"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.starter = nil; self?.fetchQuota() } }
        do { try process.run() } catch { starter = nil; quotaLine.title = "无法启动监控服务，请检查 Node.js" }
    }
    func fetchQuota() {
        guard !fetching else { return }
        guard let s = readService() else { quotaFailed = true; render(); startService(); return }
        service = s; fetching = true
        var request = URLRequest(url: URL(string: s.origin + "/api/status")!)
        request.setValue("Bearer " + s.token, forHTTPHeaderField: "Authorization")
        localSession.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }; self.fetching = false
                if let data = data, (response as? HTTPURLResponse)?.statusCode == 200, let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
                    self.snapshot = snapshot; self.quotaFailed = false; self.quotaAt = Date()
                } else { self.quotaFailed = true; self.startService() }
                self.render()
            }
        }.resume()
    }
    func render() {
        let window = snapshot.flatMap { selectedWindow($0.quotas.data) }
        let stale = quotaFailed || (snapshot?.quotas.stale ?? true) || Date().timeIntervalSince1970 * 1000 - (snapshot?.quotas.updatedAt ?? 0) > 120000
        let proxy = probeAt.map { Date().timeIntervalSince($0) > 65 ? "代理?" : proxyText } ?? "代理?"
        let title = "\(shortQuota(window?.remainingPercent, stale: stale)) · \(proxy)"
        item.button?.title = title
        DispatchQueue.main.async { [weak self] in self?.writeDisplayStatus() }
        item.button?.toolTip = "Codex 剩余额度 · \(proxyDetail)"
        let hours = window?.minutes.map { String(format: "%g", Double($0) / 60) } ?? "?"
        quotaLine.title = "\(hours) 小时额度：\(shortQuota(window?.remainingPercent, stale: stale))"
        if let bucket = snapshot?.quotas.data.first(where: { $0.id == "codex" }) ?? snapshot?.quotas.data.first,
           let second = bucket.windows.first(where: { $0.key == "secondary" }) {
            let days = second.minutes.map { String(format: "%g", Double($0) / 1440) } ?? "?"
            weekLine.title = "\(days) 天额度：\(shortQuota(second.remainingPercent, stale: stale))"; weekLine.isHidden = false
        } else { weekLine.isHidden = true }
        networkLine.title = proxyDetail
        if let at = snapshot?.quotas.updatedAt {
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
            updatedLine.title = "额度更新 \(formatter.string(from: Date(timeIntervalSince1970: at / 1000)))\(stale ? " · 已过期" : "")"
        } else { updatedLine.title = "额度尚未获取" }
    }
    func writeDisplayStatus() {
        guard let config = config, let item = item else { return }
        let window = item.button?.window
        let frame = window?.frame ?? .zero
        let diagnostic: [String: Any] = [
            "title": item.button?.title ?? "",
            "updatedAt": Date().timeIntervalSince1970,
            "itemEnabled": item.isVisible,
            "windowVisible": window?.isVisible ?? false,
            "windowOnScreen": window?.occlusionState.contains(.visible) ?? false,
            "screenWidth": window?.screen?.frame.width ?? 0,
            "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
            "proxyDetail": proxyDetail
        ]
        let destination = URL(fileURLWithPath: config.descriptor).deletingLastPathComponent().appendingPathComponent("menubar-status.json")
        if let data = try? JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys]) { try? data.write(to: destination, options: .atomic) }
    }
    @objc func refresh() {
        if let s = readService() {
            var req = URLRequest(url: URL(string: s.origin + "/api/refresh")!); req.httpMethod = "POST"; req.setValue("Bearer " + s.token, forHTTPHeaderField: "Authorization")
            localSession.dataTask(with: req) { _, _, _ in DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.fetchQuota() } }.resume()
        }
        fetchQuota(); probe.check()
    }
    @objc func wake() { probeAt = nil; quotaFailed = true; render(); refresh() }
    @objc func openDashboard() { if let s = readService(), let url = URL(string: s.origin + "/#" + s.token) { NSWorkspace.shared.open(url) } }
    @objc func quitApp() { NSApp.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    assert(shortQuota(nil, stale: false) == "—%")
    assert(shortQuota(0, stale: false) == "0%")
    assert(shortQuota(42, stale: true) == "42%*")
    assert(shortQuota(150, stale: false) == "100%")
    assert(proxyTitle(connected: true, viaProxy: true, configured: false) == "代理✓")
    assert(proxyTitle(connected: false, viaProxy: true, configured: true) == "代理!")
    assert(proxyTitle(connected: true, viaProxy: false, configured: false) == "直连")
    assert(proxyTitle(connected: false, viaProxy: nil, configured: false) == "代理?")
    let input = #"{"quotas":{"data":[{"id":"other","windows":[]},{"id":"codex","windows":[{"key":"primary","remainingPercent":42,"minutes":300,"resetsAt":null}]}],"updatedAt":null,"stale":false}}"#
    let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(input.utf8))
    assert(selectedWindow(snapshot.quotas.data)?.remainingPercent == 42)
    print("Menu bar checks passed: quota, staleness, proxy confirmation, bucket selection")
} else {
    let app = NSApplication.shared
    let delegate = PulseApp()
    app.delegate = delegate
    app.run()
}
