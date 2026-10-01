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
    "VPN: %1 · %2 · %3 ms": "VPN: %1 · %2 · %3 мс", "VPN: %1 · %2 ms": "VPN: %1 · %2 мс",
    "Turn VPN off": "Выключить VPN", "Turn VPN on": "Включить VPN", "Settings…": "Настройки…",
    "Could not save VPN settings": "Не удалось сохранить настройки VPN",
    "mihomo rejected the configuration": "mihomo отверг конфигурацию",
    "VPN is on": "VPN включён", "Check: systemctl status mihomo@%1": "Проверьте: systemctl status mihomo@%1",
    "Turn off": "Выключить", "Turn on": "Включить", "Subscriptions": "Подписки", "Rules": "Правила",
    "Delete %1?": "Удалить %1?", "Servers: %1": "Серверов: %1", "Delete": "Удалить", "Yes": "Да", "No": "Нет",
    "No subscriptions yet: copy a link or a subscription URL and press “From clipboard”.":
      "Подписок пока нет: скопируйте ссылку или адрес подписки и нажмите «Из буфера».",
    "No link or subscription found": "Ссылка или подписка не найдена", "Already added": "Уже добавлена",
    "Added: %1": "Добавлена: %1", "No usable servers in %1": "В %1 нет подходящих серверов",
    "Could not download the subscription": "Не удалось скачать подписку",
    "No QR code found in the selected area": "В выделенной области нет QR-кода",
    "From clipboard": "Из буфера", "QR from screen": "QR с экрана",
    "Not a domain: %1": "Не домен: %1", "Domain…": "Домен…", "Direct: country": "Напрямую: страна",
    "Russia": "Россия", "Don't use": "Не использовать", "Block ads": "Блокировать рекламу",
    "ALWAYS THROUGH VPN": "ВСЕГДА ЧЕРЕЗ VPN", "ALWAYS DIRECT": "ВСЕГДА НАПРЯМУЮ",
    "ADD SUBSCRIPTION": "ДОБАВИТЬ ПОДПИСКУ",
    "VPN did not start": "VPN не запустился", "See: journalctl -u mihomo@%1": "Смотрите: journalctl -u mihomo@%1"
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
