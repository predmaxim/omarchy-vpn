.pragma library
// Interface text in other languages, keyed by the English text itself, so a
// string missing from a table shows in English. tr("Copied: %1", x) fills in
// %1, %2… after the lookup. Quickshell plugins get no .qm catalogues, so Qt's
// qsTr isn't used.
var TABLES = {
  ru: {
    "VPN service is not running": "Сервис VPN не запущен",
    "VPN: no subscriptions": "VPN: нет подписок",
    "VPN is off": "VPN выключен",
    "VPN: no servers in %1": "VPN: в %1 нет серверов",
    "VPN: no connection to %1": "VPN: нет связи с серверами %1",
    "VPN: %1 · %2 · %3 ms": "VPN: %1 · %2 · %3 мс"
  }
}

// Text follows LC_MESSAGES, overridden by LC_ALL and defaulting to LANG, as
// the system splits it. env is name -> value (Quickshell.env in QML).
function textLanguage(env) {
  var names = ["LC_ALL", "LC_MESSAGES", "LANG"]
  for (var i = 0; i < names.length; i++) {
    var v = String(env(names[i]) || "").split(".")[0].split("@")[0]
    if (v && v !== "C" && v !== "POSIX") {
      var l = v.slice(0, 2).toLowerCase()
      return TABLES[l] ? l : "en"
    }
  }
  return "en"
}

function translator(lang) {
  var table = TABLES[lang] || {}
  return function(text) {
    var out = Object.prototype.hasOwnProperty.call(table, text) ? table[text] : text
    for (var i = 1; i < arguments.length; i++) out = out.split("%" + i).join(String(arguments[i]))
    return out
  }
}
