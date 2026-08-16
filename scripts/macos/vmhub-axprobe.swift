// vmhub-axprobe — minimal TCC-verification + screenshot probe for the macOS
// golden factory. Runs on the guest, is signed with identifier
// "com.vmhub.agent" and a stable designated requirement, so the TCC
// pre-grants baked by vmhub-regrant-tcc.sh apply to it.
//
//   vmhub-axprobe ax            # read the Accessibility tree (needs
//                               #   kTCCServiceAccessibility) — prints
//                               #   AX_OK / AX_ERR <code>
//   vmhub-axprobe screencap P   # write a PNG of the main display to P
//                               #   (needs kTCCServiceScreenCapture) — prints
//                               #   SCREEN_OK <bytes> / SCREEN_ERR <reason>
//
// Build on the guest (Xcode toolchain):
//   xcrun swiftc -O -o vmhub-axprobe vmhub-axprobe.swift \
//     -framework ApplicationServices -framework ScreenCaptureKit
//   codesign -f -s - -i com.vmhub.agent \
//     -r '=designated => identifier "com.vmhub.agent"' vmhub-axprobe

import ApplicationServices
import Foundation
import ImageIO
import ScreenCaptureKit

func axProbe() -> Int32 {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(
        system, kAXFocusedApplicationAttribute as CFString, &focused)
    if err == .success, let app = focused {
        var windows: CFTypeRef?
        let werr = AXUIElementCopyAttributeValue(
            app as! AXUIElement, kAXWindowsAttribute as CFString, &windows)
        let count = (werr == .success && windows != nil)
            ? (windows as? [AXUIElement])?.count ?? -1 : -1
        print("AX_OK focused_app_present windows=\(count)")
        return 0
    }
    print("AX_ERR \(err.rawValue)")
    return 1
}

func screenCapture(_ path: String) async -> Int32 {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            print("SCREEN_ERR no_displays")
            return 1
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = Int(display.width)
        config.height = Int(display.height)
        guard let image = try? await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: config) else {
            print("SCREEN_ERR capture_failed")
            return 1
        }
        let url = URL(fileURLWithPath: path) as CFURL
        guard let dest = CGImageDestinationCreateWithURL(
            url, "public.png" as CFString, 1, nil) else {
            print("SCREEN_ERR no_dest")
            return 1
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            print("SCREEN_ERR finalize_failed")
            return 1
        }
        let size = (try? FileManager.default.attributesOfItem(
            atPath: path)[.size] as? Int) ?? 0
        print("SCREEN_OK \(size)")
        return 0
    } catch {
        print("SCREEN_ERR \(error)")
        return 1
    }
}

// Async main (SCScreenshotManager is async).
let semaphore = DispatchSemaphore(value: 0)

func runMain() {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        print("usage: vmhub-axprobe ax | screencap <out.png>")
        exit(2)
    }
    switch args[1] {
    case "ax":
        exit(axProbe())
    case "screencap":
        guard args.count >= 3 else { print("SCREEN_ERR missing_path"); exit(1) }
        Task {
            let code = await screenCapture(args[2])
            exit(code)
        }
    default:
        print("unknown subcommand \(args[1])")
        exit(2)
    }
    // keep the process alive for the Task above
    semaphore.wait()
}

runMain()
