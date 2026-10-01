import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "@PLUGIN_DIR@" as Vpn
import "@PLUGIN_DIR@/Model.js" as Model
import "@PLUGIN_DIR@/I18n.js" as I18n

// predmaxim.vpn among the bar's indicators, always shown (it replaces
// hiddify's tray icon). Left click — the settings modal, middle — VPN on/off,
// right — the menu. The widget (Panel.qml) stays in the bar layout, hidden
// (showInBar: false), for the modal, the changes and IPC.
// keep-custom-widgets.sh copies this file into the predmaxim.indicators clone
// as indicators/Vpn.qml and fills in @PLUGIN_DIR@.
BarIndicator {
  id: root

  readonly property var tr: I18n.translator(I18n.textLanguage(function(name) { return Quickshell.env(name) }))
  readonly property color fg: root.bar ? root.bar.barForeground : Color.foreground

  active: true
  activeText: Model.glyph(vpn.view)
  activeTooltipText: Model.tooltip(vpn.view, root.tr)
  foreground: Model.isError(vpn.view) ? Model.ERROR_COLOR : (vpn.view.kind === "on" ? root.fg : Qt.darker(root.fg, 1.4))

  onPressed: function(button) {
    if (button === Qt.RightButton) menu.open = !menu.open
    else if (button === Qt.MiddleButton) Quickshell.execDetached(["omarchy-shell", "predmaxim.vpn-ctl", "power"])
    else Quickshell.execDetached(["omarchy-shell", "predmaxim.vpn", "toggle"])
  }

  Vpn.Status { id: vpn }
  Vpn.Menu { id: menu; anchorItem: root; bar: root.bar; vpnState: vpn }
}
