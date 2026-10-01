import QtQuick
import QtQuick.Controls as QQC
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "I18n.js" as I18n

// VPN through mihomo (TUN). This widget owns every change: it writes
// ~/.config/mihomo (state.json, config.yaml, link files) and drives mihomo's
// API. The menu only reads and sends IPC.
Panel {
  id: root
  moduleName: "predmaxim.vpn"
  ipcTarget: "predmaxim.vpn"

  readonly property var tr: I18n.translator(I18n.textLanguage(function(name) { return Quickshell.env(name) }))
  readonly property color fg: root.bar ? root.bar.barForeground : Color.foreground
  readonly property color muted: Qt.darker(root.fg, 1.4)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  property string tab: "subs"
  property string confirmId: ""
  property bool busy: false
  property var pending: null
  // Changes that arrived while another one was being written: they wait their turn.
  property var queue: []
  property int retryAttempt: 0

  // The plugin's own icon: the notification center shows -i, and "VPN" has no .desktop to look one up in.
  readonly property string notifyIcon: String(Qt.resolvedUrl("globe.svg")).replace(/^file:\/\//, "")

  function notify(summary, body) {
    Quickshell.execDetached(["notify-send", "-a", "VPN", "-i", root.notifyIcon, summary, body || ""])
  }

  // Applies change(saved) -> next: writes its files; with `reload`, mihomo
  // then re-reads its config, and a rejected config rolls back. `after` runs
  // once everything went through. A change arriving while another is written
  // waits its turn and is computed from the state at its turn, so it never
  // undoes the one before. A broken state.json is never written over: it holds
  // the only copy of the subscription keys. options: { rollback, firstRun }.
  function commit(change, reload, after, options) {
    options = options || {}
    if (vpn.broken) {
      root.notify(root.tr("VPN settings file is damaged"), root.tr("Fix or delete %1", vpn.dir + "/state.json"))
      return
    }
    if (root.busy) { root.queue = root.queue.concat([[change, reload, after, options]]); return }
    var prev = vpn.saved
    var next = change(prev)
    root.busy = true
    root.pending = { next: next, prev: prev, reload: reload, after: after || null, options: options }
    var env = Model.writerEnv(next)
    if (options.firstRun) env.FIRST_RUN = "1"
    writer.environment = env
    writer.running = true
  }

  function written(code) {
    var p = root.pending
    if (code !== 0) { root.done(); root.notify(root.tr("Could not save VPN settings"), ""); return }
    // A first run may have found another widget's state.json: read the file back.
    if (p.options.firstRun) vpn.reread(); else vpn.saved = p.next
    if (!p.reload || !vpn.apiUp) { root.done(); if (p.after) p.after(); return }
    vpn.quiet = true
    vpn.call("PUT", "/configs?force=true", { path: vpn.dir + "/config.yaml" }, function(ok, data) {
      vpn.quiet = false
      if (ok) { root.done(); if (p.after) p.after(); vpn.poll(); return }
      root.notify(root.tr("mihomo rejected the configuration"), data && data.message ? data.message : "")
      root.busy = false
      root.pending = null
      // The rollback goes before anything queued.
      if (!p.options.rollback) root.commit(function() { return p.prev }, true, null, { rollback: true })
      else root.done()
    })
  }

  function done() {
    root.busy = false
    root.pending = null
    if (!root.queue.length) return
    var next = root.queue[0]
    root.queue = root.queue.slice(1)
    Qt.callLater(function() { root.commit(next[0], next[1], next[2], next[3]) })
  }

  // fn after ms, one timer per call (several checks may be waiting at once).
  function later(ms, fn) {
    var timer = Qt.createQmlObject("import QtQuick; Timer {}", root)
    timer.interval = ms
    timer.triggered.connect(function() { timer.destroy(); fn() })
    timer.start()
  }

  // On: a config reload, not PATCH /configs — a runtime PATCH leaves
  // Hysteria2's QUIC socket unbound to the uplink, and its packets loop into
  // the tunnel. Off: PATCH — a reload leaves the "Meta" device behind, and the
  // next start then fails with "device or resource busy".
  function setEnabled(on) {
    var next = Model.setEnabled(vpn.saved, on)
    if (next.enabled === vpn.saved.enabled || root.busy) return
    if (!vpn.apiUp) { root.notify(root.tr("VPN service is not running"), ""); return }
    if (next.enabled) { root.commit(function(s) { return Model.setEnabled(s, true) }, true, root.checkStarted); return }
    vpn.call("PATCH", "/configs", { tun: { enable: false } }, function(ok) {
      if (!ok) { root.notify(root.tr("VPN service is not running"), ""); return }
      root.commit(function(s) { return Model.setEnabled(s, false) }, false, function() { vpn.poll() })
    })
  }

  // mihomo answers a reload with success even when TUN failed to start: look,
  // and if it is not up, say so and save "off" again.
  function checkStarted() {
    vpn.call("GET", "/configs", null, function(ok, configs) {
      if (ok && configs && configs.tun && configs.tun.enable) return
      root.notify(root.tr("VPN did not start"), root.tr("See: journalctl -u mihomo@%1", Quickshell.env("USER")))
      root.commit(function(s) { return Model.setEnabled(s, false) }, false, function() { vpn.poll() })
    })
  }

  function use(id) {
    var next = Model.useSubscription(vpn.saved, id)
    if (next === vpn.saved || root.busy) return
    vpn.call("PUT", "/proxies/VPN", { name: id }, function(ok) {
      if (ok) root.commit(function(s) { return Model.useSubscription(s, id) }, false, function() { vpn.poll() })
    })
  }

  function remove(id) {
    root.confirmId = ""
    root.commit(function(s) { return Model.removeSubscription(s, id) }, true, null)
  }

  // Pasted or scanned text -> a new subscription. A URL is downloaded once for
  // its name and to see it answers; links go straight in.
  function addText(text) {
    var found = Model.classify(text)
    if (!found) { root.notify(root.tr("No link or subscription found"), ""); return }
    if (found.kind === "links") { root.addSubscription(Model.linksSubscription(found.links)); return }
    fetcher.url = found.url
    fetcher.running = true
  }

  function addSubscription(sub) {
    if (Model.addSubscription(vpn.saved, sub).error) { root.notify(root.tr("Already added"), sub.name); return }
    root.commit(function(s) { return Model.addSubscription(s, sub).state }, true, function() { root.verifyAdded(sub, 0) })
  }

  // mihomo loads a provider in the background: look for its servers three
  // times, 2 s apart; none — the subscription goes again.
  function verifyAdded(sub, attempt) {
    vpn.call("GET", "/providers/proxies/" + sub.id, null, function(ok, data) {
      var count = ok && data && data.proxies ? data.proxies.length : 0
      if (count > 0) { root.notify(root.tr("Added: %1", sub.name), root.tr("Servers: %1", count)); return }
      if (attempt < 2) { root.later(2000, function() { root.verifyAdded(sub, attempt + 1) }); return }
      root.notify(root.tr("No usable servers in %1", sub.name), "")
      root.commit(function(s) { return Model.removeSubscription(s, sub.id) }, true, null)
    })
  }

  // The modal hides first, or slurp would select over it.
  function scanQr() {
    root.close()
    qrDelay.start()
  }

  function addDomain(list, text) {
    var r = Model.addDomain(vpn.saved, list, text)
    if (r.error === "invalid") { root.notify(root.tr("Not a domain: %1", text.trim()), ""); return false }
    if (!r.error) root.commit(function(s) { return Model.addDomain(s, list, text).state }, true, null)
    return true
  }

  // Retries (spec "Повторы"): a dead current server — re-test its group; an
  // empty subscription — re-download it. 5 s, 15 s, 60 s, then every 5 min.
  function checkRetry() {
    var kind = vpn.view.kind
    if (kind !== "dead" && kind !== "nosrv") { root.retryAttempt = 0; retryTimer.stop(); return }
    if (!retryTimer.running) { retryTimer.interval = Model.retryDelay(root.retryAttempt); retryTimer.start() }
  }

  function retryNow() {
    var group = vpn.st.group
    root.retryAttempt++
    if (!group) return
    if (vpn.view.kind === "nosrv") vpn.call("PUT", "/providers/proxies/" + group, null, null)
    else vpn.call("GET", "/group/" + group + "/delay?url=" + encodeURIComponent(Model.TEST_URL) + "&timeout=5000", null, null)
  }

  Status {
    id: vpn
    onPolled: root.checkRetry()
    // First run: a state with a new API secret.
    // First run: a state with a new API secret (FIRST_RUN: unless another widget made one).
    onMissingChanged: if (missing) root.commit(function() { return Model.defaults(Model.randomSecret(Math.random)) }, false, null, { firstRun: true })
    // An empty secret would leave mihomo's API open to any local process: make one.
    onLoadedFile: if (!vpn.broken && !vpn.saved.secret) root.commit(function(s) { return Model.patch(s, { secret: Model.randomSecret(Math.random) }) }, true, null)
  }

  Process {
    id: writer
    command: ["sh", "-c", Model.WRITE_SCRIPT, "sh", vpn.dir]
    onExited: function(code) { root.written(code) }
  }

  Timer { id: retryTimer; onTriggered: root.retryNow() }

  Timer { id: qrDelay; interval: 250; onTriggered: qr.running = true }

  // The URL goes through curl's --variable from the environment: argv is
  // readable by every user, and subscription URLs carry keys.
  Process {
    id: fetcher
    property string url: ""
    environment: ({ VPN_URL: fetcher.url })
    command: ["curl", "-sSL", "--max-time", "15", "--retry", "2", "--retry-delay", "3", "--retry-all-errors",
      "-D", "-", "--variable", "%VPN_URL", "--expand-url", "{{VPN_URL}}"]
    stdout: StdioCollector { id: fetched }
    stderr: StdioCollector { id: fetchErrors }
    onExited: function(code) {
      if (code !== 0) root.notify(root.tr("Could not download the subscription"), fetchErrors.text.trim())
      else root.addSubscription(Model.urlSubscription(fetcher.url, fetched.text))
    }
  }

  Process {
    id: paste
    command: ["wl-paste", "-n", "-t", "text/plain"]
    stdout: StdioCollector { id: pasted }
    onExited: function(code) { root.addText(code === 0 ? pasted.text : "") }
  }

  // Exit 2 — the selection was cancelled: nothing to say.
  Process {
    id: qr
    command: ["sh", "-c", 'g=$(slurp) || exit 2; grim -g "$g" - | zbarimg -q --raw -']
    stdout: StdioCollector { id: scanned }
    onExited: function(code) {
      root.open()
      if (code === 0 && scanned.text.trim()) root.addText(scanned.text)
      else if (code !== 2) root.notify(root.tr("No QR code found in the selected area"), "")
    }
  }

  IpcHandler {
    target: "predmaxim.vpn-ctl"
    function power(): void { root.setEnabled(!vpn.saved.enabled) }
    function use(id: string): void { root.use(id) }
    function add(text: string): void { root.addText(text) }
  }

  onOpenedChanged: if (opened) vpn.poll(); else root.confirmId = ""

  implicitWidth: icon.implicitWidth
  implicitHeight: icon.implicitHeight

  BarIconButton {
    id: icon
    bar: root.bar
    text: Model.glyph(vpn.view)
    tooltipText: Model.tooltip(vpn.view, root.tr)
    foreground: Model.isError(vpn.view) ? Model.ERROR_COLOR : (vpn.view.kind === "on" ? root.fg : root.muted)
    onPressed: function(button) {
      if (button === Qt.RightButton) menu.open = !menu.open
      else if (button === Qt.MiddleButton) root.setEnabled(!vpn.saved.enabled)
      else root.toggle()
    }
  }

  Menu { id: menu; anchorItem: icon; bar: root.bar; vpnState: vpn }

  // A modal in the middle of the screen (rules.md §9): a click on the dimmed
  // screen or Esc closes it.
  PanelWindow {
    id: modal
    screen: root.QsWindow.window ? root.QsWindow.window.screen : null
    visible: root.opened
    color: Color.menu.scrim
    exclusionMode: ExclusionMode.Ignore
    anchors { top: true; bottom: true; left: true; right: true }
    WlrLayershell.namespace: "predmaxim-vpn"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

    MouseArea { anchors.fill: parent; onClicked: root.close() }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: Math.min(Style.space(480), modal.width - Style.space(80))
      height: Math.min(column.implicitHeight + card.contentTopInset + card.contentBottomInset, modal.height * 0.85)
      color: Color.popups.background
      borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding
      radius: Style.cornerRadius
      focus: true
      Keys.onEscapePressed: root.close()

      MouseArea { anchors.fill: parent }   // clicks on the card stay on it

      Column {
        id: column
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: Style.space(14)

        PanelHero {
          title: vpn.saved.enabled ? root.tr("VPN is on") : root.tr("VPN is off")
          meta: vpn.view.kind === "on" || Model.isError(vpn.view) ? Model.tooltip(vpn.view, root.tr) : ""
          foreground: root.fg
          fontFamily: root.fontFamily
          iconComponent: Text {
            text: Model.glyph(vpn.view)
            color: Model.isError(vpn.view) ? Model.ERROR_COLOR : root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }
          trailingControl: Button {
            text: vpn.saved.enabled ? root.tr("Turn off") : root.tr("Turn on")
            bordered: true
            enabled: vpn.apiUp && !root.busy && vpn.saved.subscriptions.length > 0
            foreground: root.fg
            fontFamily: root.fontFamily
            onClicked: root.setEnabled(!vpn.saved.enabled)
          }
        }

        // Where to look when the service is down (PanelHero's detail is a badge, too narrow for it).
        Text {
          visible: vpn.view.kind === "down"
          width: parent.width
          wrapMode: Text.Wrap
          text: root.tr("Check: systemctl status mihomo@%1", Quickshell.env("USER"))
          color: root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PanelSeparator { foreground: root.fg }

        Row {
          spacing: Style.space(8)
          Button { text: root.tr("Subscriptions"); selected: root.tab === "subs"; foreground: root.fg; fontFamily: root.fontFamily; onClicked: root.tab = "subs" }
          Button { text: root.tr("Rules"); selected: root.tab === "rules"; foreground: root.fg; fontFamily: root.fontFamily; onClicked: root.tab = "rules" }
        }

        // Everything below changes mihomo: off while it is down or busy.
        Column {
          id: subsTab
          visible: root.tab === "subs"
          enabled: vpn.apiUp && !root.busy
          width: parent.width
          spacing: Style.space(10)

          ListView {
            id: subsList
            width: parent.width
            height: Math.min(contentHeight, modal.height * 0.4)
            clip: true
            spacing: Style.spacing.xs
            boundsBehavior: Flickable.StopAtBounds
            model: vpn.saved.subscriptions

            delegate: CursorSurface {
              id: row
              required property var modelData
              width: subsList.width
              readonly property bool confirming: root.confirmId === modelData.id
              readonly property var count: vpn.st.counts[modelData.id]
              implicitHeight: Math.max(Style.space(50), name.implicitHeight + Style.spacing.rowPaddingX * 2)
              foreground: root.fg
              hasCursor: rowMouse.containsMouse

              MouseArea {
                id: rowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.use(row.modelData.id)
              }

              Text {
                id: radio
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: row.modelData.id === vpn.saved.active ? "\u{F043E}" : "\u{F043D}"
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }

              Text {
                id: name
                anchors.left: radio.right
                anchors.leftMargin: Style.space(10)
                anchors.right: actions.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                elide: Text.ElideRight
                text: row.confirming ? root.tr("Delete %1?", row.modelData.name) : row.modelData.name
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: row.modelData.id === vpn.saved.active
              }

              Row {
                id: actions
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)

                Text {
                  visible: !row.confirming && row.count !== undefined
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.tr("Servers: %1", row.count)
                  color: root.muted
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
                Button {
                  visible: !row.confirming
                  iconText: "\u{F0156}"
                  iconSize: Style.font.body
                  tooltipText: root.tr("Delete")
                  foreground: root.fg
                  fontFamily: root.fontFamily
                  onClicked: root.confirmId = row.modelData.id
                }
                Button { visible: row.confirming; text: root.tr("Yes"); bordered: true; foreground: root.fg; fontFamily: root.fontFamily; onClicked: root.remove(row.modelData.id) }
                Button { visible: row.confirming; text: root.tr("No"); foreground: root.fg; fontFamily: root.fontFamily; onClicked: root.confirmId = "" }
              }
            }
          }

          Text {
            visible: !vpn.saved.subscriptions.length
            text: root.tr("No subscriptions yet: copy a link or a subscription URL and press “From clipboard”.")
            color: root.muted
            width: parent.width
            wrapMode: Text.Wrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            topPadding: Style.space(12)   // set the add section apart from the list
            text: root.tr("ADD SUBSCRIPTION")
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.2
          }

          Row {
            spacing: Style.space(8)
            Button {
              iconText: "\u{F014A}"
              text: root.tr("From clipboard")
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: paste.running = true
            }
            Button {
              iconText: "\u{F0433}"
              text: root.tr("QR from screen")
              bordered: true
              foreground: root.fg
              fontFamily: root.fontFamily
              onClicked: root.scanQr()
            }
          }
        }

        Flickable {
          id: rulesTab
          visible: root.tab === "rules"
          enabled: vpn.apiUp && !root.busy
          width: parent.width
          height: Math.min(rulesColumn.implicitHeight, modal.height * 0.55)
          contentHeight: rulesColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds

          Column {
            id: rulesColumn
            width: rulesTab.width
            spacing: Style.space(14)

            Item {
              width: parent.width
              height: country.implicitHeight
              Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: root.tr("Direct: country")
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              Dropdown {
                id: country
                anchors.right: parent.right
                width: Style.spacing.dropdownWidth
                showLabel: false
                options: [{ value: "ru", label: root.tr("Russia") }, { value: "none", label: root.tr("Don't use") }]
                value: vpn.saved.country || "none"
                foreground: root.fg
                fontFamily: root.fontFamily
                onChanged: function(value) {
                  var next = value === "none" ? "" : value
                  if (next !== vpn.saved.country) root.commit(function(s) { return Model.patch(s, { country: next }) }, true, null)
                }
              }
            }

            Item {
              width: parent.width
              height: ads.implicitHeight
              Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: root.tr("Block ads")
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              ToggleSwitch {
                id: ads
                anchors.right: parent.right
                checked: vpn.saved.blockAds
                foreground: root.fg
                onToggled: root.commit(function(s) { return Model.patch(s, { blockAds: !s.blockAds }) }, true, null)
              }
            }

            PanelSeparator { foreground: root.fg }

            // Two rule lists: caption, a borderless field (Enter adds), domains with ✕.
            Repeater {
              model: [{ list: "proxyDomains", title: root.tr("ALWAYS THROUGH VPN") },
                      { list: "directDomains", title: root.tr("ALWAYS DIRECT") }]
              delegate: Column {
                id: domains
                required property var modelData
                width: rulesColumn.width
                spacing: Style.spacing.xs

                Text {
                  text: domains.modelData.title
                  color: root.muted
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  font.letterSpacing: 1.2
                }

                TextField {
                  width: domains.width
                  height: Math.max(Style.space(34), Style.font.title + Style.spacing.controlPaddingY * 2)
                  leftPadding: 0; rightPadding: 0; topPadding: 0; bottomPadding: 0
                  background: null
                  placeholderText: root.tr("Domain…")
                  placeholderTextColor: Util.alpha(root.fg, 0.58)
                  foreground: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  onAccepted: if (root.addDomain(domains.modelData.list, text)) text = ""
                }

                // A list of its own scroll height, so new domains don't stretch the modal.
                ListView {
                  id: domainList
                  width: domains.width
                  height: Math.min(contentHeight, Style.space(140))
                  clip: true
                  boundsBehavior: Flickable.StopAtBounds
                  model: vpn.saved[domains.modelData.list]
                  QQC.ScrollBar.vertical: QQC.ScrollBar { policy: domainList.contentHeight > domainList.height ? QQC.ScrollBar.AlwaysOn : QQC.ScrollBar.AlwaysOff }
                  delegate: Item {
                    id: domainRow
                    required property string modelData
                    width: domainList.width
                    height: Math.max(Style.space(32), domainText.implicitHeight + Style.spacing.xs * 2)
                    Text {
                      id: domainText
                      anchors.left: parent.left
                      anchors.verticalCenter: parent.verticalCenter
                      text: domainRow.modelData
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                    Button {
                      anchors.right: parent.right
                      anchors.rightMargin: Style.space(12)
                      anchors.verticalCenter: parent.verticalCenter
                      iconText: "\u{F0156}"
                      iconSize: Style.font.body
                      tooltipText: root.tr("Delete")
                      foreground: root.fg
                      fontFamily: root.fontFamily
                      onClicked: root.commit(function(s) { return Model.removeDomain(s, domains.modelData.list, domainRow.modelData) }, true, null)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
