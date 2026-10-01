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
  property var st: Model.status(null, null)
  property int failures: 0
  // Our own config reload makes the API vanish for a moment: failed polls
  // then don't count.
  property bool quiet: false
  readonly property bool apiUp: failures < 3
  readonly property var view: Model.view(saved, st, apiUp)

  signal polled()

  function call(method, path, body, done) {
    Api.request(root.saved.port, root.saved.secret, method, path, body, done || function() {})
  }

  function fail() { if (!root.quiet) root.failures++ }

  function poll() {
    if (!root.loaded || !root.saved.secret) return
    root.call("GET", "/configs", null, function(ok, configs) {
      if (!ok) { root.fail(); return }
      root.call("GET", "/proxies", null, function(ok2, proxies) {
        if (!ok2) { root.fail(); return }
        root.failures = 0
        root.st = Model.status(configs, proxies)
        root.polled()
      })
    })
  }

  FileView {
    path: root.dir + "/state.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: { root.saved = Model.load(text()); root.missing = false; root.loaded = true; root.poll() }
    onLoadFailed: { root.missing = true; root.loaded = true }
  }

  Timer { interval: 5000; running: true; repeat: true; onTriggered: root.poll() }
}
