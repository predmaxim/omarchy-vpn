import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "I18n.js" as I18n

// Right-click menu of the VPN icon: pick the subscription, turn VPN on/off,
// open the settings modal. Actions go to the widget over IPC, which owns all
// changes (Panel.qml).
PopupCard {
  id: root

  required property var vpnState
  readonly property var tr: I18n.translator(I18n.textLanguage(function(name) { return Quickshell.env(name) }))
  readonly property color fg: root.bar ? root.bar.barForeground : Color.foreground
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  contentWidth: Style.space(260)
  contentHeight: root.fittedContentHeight(column.implicitHeight)

  function run(args) {
    Quickshell.execDetached(["omarchy-shell"].concat(args))
    root.open = false
  }

  Column {
    id: column
    width: root.contentWidth - root.padding * 2
    spacing: Style.spacing.xs

    Repeater {
      model: root.vpnState.saved.subscriptions
      delegate: Button {
        required property var modelData
        width: column.width
        leftAlign: true
        iconText: modelData.id === root.vpnState.saved.active ? "\u{F043E}" : "\u{F043D}"
        text: modelData.name
        foreground: root.fg
        fontFamily: root.fontFamily
        onClicked: root.run(["predmaxim.vpn-ctl", "use", modelData.id])
      }
    }

    PanelSeparator { visible: root.vpnState.saved.subscriptions.length > 0; foreground: root.fg }

    Button {
      width: column.width
      leftAlign: true
      visible: root.vpnState.saved.subscriptions.length > 0
      iconText: "\u{F0425}"
      text: root.vpnState.saved.enabled ? root.tr("Turn VPN off") : root.tr("Turn VPN on")
      foreground: root.fg
      fontFamily: root.fontFamily
      onClicked: root.run(["predmaxim.vpn-ctl", "power"])
    }

    Button {
      width: column.width
      leftAlign: true
      iconText: "\u{F0493}"
      text: root.tr("Settings…")
      foreground: root.fg
      fontFamily: root.fontFamily
      onClicked: root.run(["predmaxim.vpn", "open"])
    }
  }
}
