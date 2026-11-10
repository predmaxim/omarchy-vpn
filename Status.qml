import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Api.js" as Api

// What the icon, the menu and the modal show: `saved` (state.json) plus a poll of
// mihomo's API every 5 s, for the widget and its menu.
Item {
  id: root

  readonly property string dir: Quickshell.env("HOME") + "/.config/mihomo"
  property var saved: Model.defaults("")
  property bool loaded: false
  property bool missing: false
  // state.json exists but does not parse: shown, never written over (Panel.commit).
  property bool broken: false
  property var st: Model.status(null, null)
  property int failures: 0
  // Our own config reload makes the API vanish for a moment: failed polls
  // then don't count.
  property bool quiet: false
  readonly property bool apiUp: failures < 3
  // VPN-only programs: their kernel guard (vpn-guard@<user>) is up. A failed
  // reload may leave the unit active, so Panel keeps that failure in guardFailed.
  property bool guardActive: true
  property bool guardFailed: false
  readonly property bool guarded: guardActive && !guardFailed
  readonly property var view: Model.view(saved, st, apiUp, guarded)

  signal polled()
  signal loadedFile()

  function reread() { file.reload() }

  function call(method, path, body, done) {
    Api.request(root.saved.port, root.saved.secret, method, path, body, done || function() {})
  }

  function fail() { if (!root.quiet) root.failures++ }

  // Asked only while programs are listed: without them the guard is not needed.
  function checkGuard() {
    if (!root.saved.vpnApps.length) root.guardActive = true
    else guardCheck.running = true
  }

  function poll() {
    if (!root.loaded || !root.saved.secret) return
    root.call("GET", "/configs", null, function(ok, configs) {
      if (!ok) { root.fail(); return }
      root.call("GET", "/proxies", null, function(ok2, proxies) {
        if (!ok2) { root.fail(); return }
        root.call("GET", "/providers/proxies", null, function(ok3, providers) {
          if (!ok3) { root.fail(); return }
          root.failures = 0
          root.st = Model.status(configs, proxies, providers)
          root.polled()
        })
      })
    })
  }

  FileView {
    id: file
    path: root.dir + "/state.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var parsed = Model.parseState(text())
      root.saved = parsed.state
      root.broken = parsed.broken
      root.missing = false
      root.loaded = true
      root.loadedFile()
      root.poll()
      root.checkGuard()
    }
    onLoadFailed: { root.missing = true; root.loaded = true }
  }

  Process {
    id: guardCheck
    command: ["systemctl", "is-active", "--quiet", "vpn-guard@" + Quickshell.env("USER") + ".service"]
    onExited: function(code) { root.guardActive = code === 0 }
  }

  Timer { interval: 5000; running: true; repeat: true; onTriggered: root.poll() }
}
