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
    return bucket?.windows.first(where: { $0.minutes == 300 }) ?? bucket?.windows.first(where: { $0.key == "primary" })
}

func resetText(_ at: Double?, now: Date = Date()) -> String {
    guard let at = at, at.isFinite, at > 0 else { return "暂不可用" }
    let date = Date(timeIntervalSince1970: at)
    let formatter = DateFormatter(); formatter.dateFormat = "M月d日 HH:mm"
    let minutes = Int(ceil(date.timeIntervalSince(now) / 60))
    guard minutes > 0 else { return "\(formatter.string(from: date)) · 等待更新" }
    let days = minutes / 1440, hours = minutes % 1440 / 60, mins = minutes % 60
    let remaining = [days > 0 ? "\(days)天" : "", hours > 0 ? "\(hours)小时" : "", mins > 0 ? "\(mins)分钟" : ""].joined()
    return "\(formatter.string(from: date)) · 剩余\(remaining)"
}

final class HoverView: NSView {
    var entered: (() -> Void)?
    var exited: (() -> Void)?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { entered?() }
    override func mouseExited(with event: NSEvent) { exited?() }
}

final class SnapshotStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    var session: URLSession!
    var task: URLSessionDataTask?
    var key: String?
    var buffer = Data()
    var received: ((Snapshot) -> Void)?
    var disconnected: (() -> Void)?
    override init() {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 35; config.timeoutIntervalForResource = 86400
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }
    func connect(_ service: Service) {
        let nextKey = service.origin + service.token
        guard task == nil || key != nextKey else { return }
        stop(); key = nextKey
        var request = URLRequest(url: URL(string: service.origin + "/api/events")!)
        request.setValue("Bearer " + service.token, forHTTPHeaderField: "Authorization")
        task = session.dataTask(with: request); task?.resume()
    }
    func stop() { let old = task; task = nil; key = nil; buffer.removeAll(keepingCapacity: false); old?.cancel() }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler((response as? HTTPURLResponse)?.statusCode == 200 ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === task else { return }
        buffer.append(data)
        guard buffer.count < 1024 * 1024 else { dataTask.cancel(); return }
        let delimiter = Data([10, 10])
        while let range = buffer.range(of: delimiter) {
            let event = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if event.starts(with: Data("data: ".utf8)), let snapshot = try? JSONDecoder().decode(Snapshot.self, from: event.dropFirst(6)) { received?(snapshot) }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        self.task = nil; key = nil; buffer.removeAll(keepingCapacity: false); disconnected?()
    }
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

final class PulseApp: NSObject, NSApplicationDelegate, NSPopoverDelegate {
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
    var countdownTimer: Timer?
    var starter: Process?
    var lastStart = Date.distantPast
    let probe = Probe()
    let stream = SnapshotStream()
    let quotaLine = NSTextField(labelWithString: "正在读取额度…")
    let quotaResetLine = NSTextField(labelWithString: "5小时重置：暂不可用")
    let weekLine = NSTextField(labelWithString: "周剩余额度：暂不可用")
    let weekResetLine = NSTextField(labelWithString: "周重置：暂不可用")
    let networkLine = NSTextField(labelWithString: "正在检测网络…")
    let updatedLine = NSTextField(labelWithString: "")
    let refreshButton = NSButton(title: "刷新", target: nil, action: nil)
    let popover = NSPopover()
    var localClickMonitor: Any?
    var globalClickMonitor: Any?
    var hoverOpen: DispatchWorkItem?
    var hoverClose: DispatchWorkItem?
    var pinned = false
    var refreshing = false
    var refreshMessage: String?
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
        configurePopover()
        item.button?.target = self; item.button?.action = #selector(togglePopover)
        item.button?.addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        probe.completion = { [weak self] text, detail in self?.proxyText = text; self?.proxyDetail = detail; self?.probeAt = Date(); self?.render() }
        stream.received = { [weak self] snapshot in
            self?.snapshot = snapshot; self?.quotaFailed = false; self?.quotaAt = Date(); self?.render()
        }
        stream.disconnected = { [weak self] in
            self?.quotaFailed = true; self?.render()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.fetchQuota() }
        }
        render(); fetchQuota(); probe.check()
        // Push snapshots immediately; polling is only a reconnect/health fallback.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.fetchQuota(); self?.render() }
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            if self?.popover.isShown == true { self?.render(writeDiagnostic: false) }
        }
        networkTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.probe.check() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
    }
    func configurePopover() {
        let controller = NSViewController()
        let view = HoverView(frame: NSRect(x: 0, y: 0, width: 350, height: 290))
        view.entered = { [weak self] in self?.hoverClose?.cancel() }
        view.exited = { [weak self] in self?.scheduleClose() }
        controller.view = view
        let labels = [quotaLine, quotaResetLine, weekLine, weekResetLine, networkLine, updatedLine]
        let positions: [CGFloat] = [252, 226, 188, 162, 116, 74]
        for (label, y) in zip(labels, positions) {
            label.frame = NSRect(x: 18, y: y, width: 314, height: label === networkLine ? 38 : 22)
            label.font = .systemFont(ofSize: 12)
            label.maximumNumberOfLines = label === networkLine ? 2 : 1
            label.lineBreakMode = .byTruncatingTail
            view.addSubview(label)
        }
        for label in [quotaLine, weekLine] { label.font = .boldSystemFont(ofSize: 13) }
        for label in [quotaResetLine, weekResetLine, updatedLine] { label.textColor = .secondaryLabelColor }
        refreshButton.target = self; refreshButton.action = #selector(refresh)
        let detail = NSButton(title: "查看详情", target: self, action: #selector(openDashboard))
        let quit = NSButton(title: "退出", target: self, action: #selector(quitApp))
        for (button, x) in zip([refreshButton, detail, quit], [CGFloat(18), 115, 232]) {
            button.bezelStyle = .rounded; button.frame = NSRect(x: x, y: 28, width: 96, height: 30); view.addSubview(button)
        }
        popover.contentViewController = controller; popover.contentSize = view.frame.size
        popover.behavior = .transient; popover.delegate = self; popover.animates = false
    }
    func pointerInside(_ view: NSView?) -> Bool {
        guard let view = view, let window = view.window else { return false }
        return window.convertToScreen(view.convert(view.bounds, to: nil)).contains(NSEvent.mouseLocation)
    }
    @objc func mouseEntered(with event: NSEvent) {
        hoverClose?.cancel(); hoverOpen?.cancel()
        guard !popover.isShown else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.pointerInside(self.item.button) else { return }
            self.showPopover()
        }
        hoverOpen = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }
    @objc func mouseExited(with event: NSEvent) { hoverOpen?.cancel(); scheduleClose() }
    func scheduleClose() {
        hoverClose?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.pinned, !self.pointerInside(self.item.button), !self.pointerInside(self.popover.contentViewController?.view) else { return }
            self.popover.performClose(nil)
        }
        hoverClose = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
    }
    func showPopover() {
        guard let button = item.button, !popover.isShown else { return }
        render(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        installClickMonitors()
        if Date().timeIntervalSince1970 * 1000 - (snapshot?.quotas.updatedAt ?? 0) > 15000 { refresh() }
    }
    @objc func togglePopover() {
        hoverOpen?.cancel(); hoverClose?.cancel()
        if popover.isShown && pinned { popover.performClose(nil) }
        else { pinned = true; showPopover() }
    }
    func installClickMonitors() {
        removeClickMonitors()
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        // Local monitors cover this app; global monitors cover clicks in other apps,
        // even when hover opened the popover without activating Pulse.
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.closeForOutsideClick(); return event
        }
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in
            self?.closeForOutsideClick()
        }
    }
    func closeForOutsideClick() {
        guard popover.isShown, !pointerInside(item.button) else { return }
        if let window = popover.contentViewController?.view.window, window.frame.contains(NSEvent.mouseLocation) { return }
        hoverOpen?.cancel(); hoverClose?.cancel(); pinned = false
        popover.performClose(nil)
    }
    func removeClickMonitors() {
        if let monitor = localClickMonitor { NSEvent.removeMonitor(monitor); localClickMonitor = nil }
        if let monitor = globalClickMonitor { NSEvent.removeMonitor(monitor); globalClickMonitor = nil }
    }
    func popoverDidClose(_ notification: Notification) {
        pinned = false; hoverOpen?.cancel(); hoverClose?.cancel(); removeClickMonitors()
    }
    func applicationWillTerminate(_ notification: Notification) { removeClickMonitors(); stream.stop(); timer?.invalidate(); countdownTimer?.invalidate(); networkTimer?.invalidate() }
    func readService() -> Service? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: config.descriptor)), let s = try? JSONDecoder().decode(Service.self, from: data), s.origin == config.origin, s.token.count == 64, s.token.allSatisfy({ $0.isHexDigit }) else { return nil }
        return s
    }
    func startService() {
        guard starter == nil, Date().timeIntervalSince(lastStart) > 10 else { return }
        lastStart = Date()
        let process = Process(); starter = process
        process.executableURL = URL(fileURLWithPath: config.node)
        process.arguments = [Bundle.main.resourceURL!.appendingPathComponent("monitor/src/cli.mjs").path, "start"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.starter = nil; self?.fetchQuota() } }
        do { try process.run() } catch { starter = nil; quotaLine.stringValue = "无法启动监控服务，请检查 Node.js" }
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
                    self.stream.connect(s)
                } else { self.quotaFailed = true; self.startService() }
                self.render()
            }
        }.resume()
    }
    func render(writeDiagnostic: Bool = true) {
        let window = snapshot.flatMap { selectedWindow($0.quotas.data) }
        let stale = quotaFailed || (snapshot?.quotas.stale ?? true) || Date().timeIntervalSince1970 * 1000 - (snapshot?.quotas.updatedAt ?? 0) > 120000
        let title = shortQuota(window?.minutes == 300 ? window?.remainingPercent : nil, stale: stale)
        item.button?.title = title
        if writeDiagnostic { DispatchQueue.main.async { [weak self] in self?.writeDisplayStatus() } }
        item.button?.toolTip = nil
        let period = window?.minutes.map { "\(String(format: "%g", Double($0) / 60))小时" } ?? (window == nil ? "5小时" : "短周期")
        quotaLine.stringValue = "\(period)剩余额度：\(shortQuota(window?.remainingPercent, stale: stale))"
        quotaResetLine.stringValue = "\(period)重置：\(resetText(window?.resetsAt))"
        if let bucket = snapshot?.quotas.data.first(where: { $0.id == "codex" }) ?? snapshot?.quotas.data.first,
           let second = bucket.windows.first(where: { $0.key == "secondary" }) {
            let label = second.minutes == 10080 ? "周" : second.minutes.map { "\(String(format: "%g", Double($0) / 1440))天" } ?? "长周期"
            weekLine.stringValue = "\(label)剩余额度：\(shortQuota(second.remainingPercent, stale: stale))"
            weekResetLine.stringValue = "\(label)重置：\(resetText(second.resetsAt))"
        } else { weekLine.stringValue = "周剩余额度：暂不可用"; weekResetLine.stringValue = "周重置：暂不可用" }
        let networkStale = probeAt.map { Date().timeIntervalSince($0) > 65 } ?? true
        networkLine.stringValue = "网络：\(proxyText)\(networkStale ? " · 待更新" : "")\n\(proxyDetail)"
        networkLine.toolTip = proxyDetail + "；显式代理检测不含 VPN/TUN"
        if let at = snapshot?.quotas.updatedAt {
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
            updatedLine.stringValue = "更新于 \(formatter.string(from: Date(timeIntervalSince1970: at / 1000)))\(stale ? " · 已过期" : "")"
        } else { updatedLine.stringValue = "额度尚未获取" }
        if let message = refreshMessage { updatedLine.stringValue = message }
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
        guard !refreshing else { return }
        probe.check()
        guard let s = readService() else { fetchQuota(); return }
        refreshing = true; refreshMessage = nil; refreshButton.title = "刷新中…"; refreshButton.isEnabled = false
        var req = URLRequest(url: URL(string: s.origin + "/api/refresh")!); req.httpMethod = "POST"; req.timeoutInterval = 45
        req.setValue("Bearer " + s.token, forHTTPHeaderField: "Authorization")
        localSession.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.refreshing = false; self.refreshButton.title = "刷新"; self.refreshButton.isEnabled = true
                if let data = data, (response as? HTTPURLResponse)?.statusCode == 200,
                   let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let raw = object["snapshot"], let encoded = try? JSONSerialization.data(withJSONObject: raw),
                   let snapshot = try? JSONDecoder().decode(Snapshot.self, from: encoded) {
                    self.snapshot = snapshot; self.quotaFailed = false; self.stream.connect(s)
                    self.refreshMessage = snapshot.quotas.stale ? "额度未更新，请检查登录与网络" : nil
                } else {
                    self.refreshMessage = (response as? HTTPURLResponse)?.statusCode == 429 ? "刷新过于频繁，请稍后重试" : "刷新失败，稍后自动重试"
                }
                self.render()
            }
        }.resume()
    }
    @objc func wake() { stream.stop(); probeAt = nil; quotaFailed = true; render(); fetchQuota(); refresh() }
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
    assert(resetText(nil) == "暂不可用")
    assert(resetText(0) == "暂不可用")
    assert(resetText(7200, now: Date(timeIntervalSince1970: 0)).hasSuffix("剩余2小时"))
    assert(resetText(60, now: Date(timeIntervalSince1970: 120)).hasSuffix("等待更新"))
    print("Menu bar checks passed: quota, staleness, proxy confirmation, bucket selection")
} else {
    let app = NSApplication.shared
    let delegate = PulseApp()
    app.delegate = delegate
    app.run()
}
