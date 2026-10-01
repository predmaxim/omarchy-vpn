.pragma library
// Pure logic of predmaxim.vpn: state.json, mihomo's config, subscriptions and
// links, status from mihomo's API. No QML in here, so node runs it (test.js).

function defaults(secret) {
  return { version: 1, secret: secret || "", port: 9097, enabled: false, active: "",
    subscriptions: [], country: "ru", blockAds: true, proxyDomains: [], directDomains: [] }
}

// state.json text -> state. Missing fields take their defaults; a broken file
// gives the defaults (with no secret, so the caller makes a new one).
function load(text) {
  var parsed = {}
  try { parsed = JSON.parse(text) || {} } catch (e) {}
  var out = defaults("")
  for (var key in out) if (parsed[key] !== undefined) out[key] = parsed[key]
  return out
}

// API secret: 32 hex digits from random() in [0, 1).
function randomSecret(random) {
  var s = ""
  for (var i = 0; i < 32; i++) s += Math.floor(random() * 16).toString(16)
  return s
}

function clone(state) { return JSON.parse(JSON.stringify(state)) }

function patch(state, fields) {
  var next = clone(state)
  for (var key in fields) next[key] = fields[key]
  return next
}

// Same source, same id, so adding a subscription twice is caught by its id.
// Ids also name mihomo's provider and group: display names may clash with
// server names inside a subscription.
function idFor(source) {
  var h = 5381
  for (var i = 0; i < source.length; i++) h = ((h * 33) ^ source.charCodeAt(i)) >>> 0
  return "s" + h.toString(36)
}

// Pasted or scanned text: a single http(s) URL is a subscription; lines of
// proxy links (hy2://, vless://, …) are links; anything else is null. Blank
// lines and #-comments are skipped.
function classify(text) {
  var lines = String(text || "").split(/\r?\n/).map(function(l) { return l.trim() })
    .filter(function(l) { return l && l.charAt(0) !== "#" })
  if (!lines.length) return null
  if (lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0])) return { kind: "url", url: lines[0] }
  var links = lines.filter(function(l) { return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(l) && !/^https?:/i.test(l) })
  return links.length === lines.length ? { kind: "links", links: links.join("\n") } : null
}

function host(url) {
  return String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[\/?#]/)[0].split("@").pop().replace(/:\d+$/, "")
}

// profile-title values: "base64:<UTF-8 in base64>" or plain text.
function decodeTitle(value) {
  value = String(value || "").trim()
  if (value.indexOf("base64:") !== 0) return value
  try {
    var raw = typeof atob === "function" ? atob(value.slice(7)) : Qt.atob(value.slice(7))
    return decodeURIComponent(escape(raw)).trim()
  } catch (e) {
    return ""
  }
}

// `curl -D -` output: one header block per response (redirects too), then the body.
function splitResponse(raw) {
  var text = String(raw || "").replace(/\r\n/g, "\n")
  var headers = ""
  while (/^HTTP\/[\d.]+ \d+/.test(text)) {
    var end = text.indexOf("\n\n")
    if (end < 0) { headers += text; text = ""; break }
    headers += text.slice(0, end + 1)
    text = text.slice(end + 2)
  }
  return { headers: headers, body: text }
}

// A subscription field: the response header, else a "#name: value" body line.
function field(response, name) {
  var m = response.headers.match(new RegExp("^" + name + ":[ \\t]*(.+)$", "im")) ||
    response.body.match(new RegExp("^#" + name + ":[ \\t]*(.+)$", "im"))
  return m ? m[1].trim() : ""
}

function urlSubscription(url, raw) {
  var response = splitResponse(raw)
  var hours = parseInt(field(response, "profile-update-interval"), 10)
  return { id: idFor(url), name: decodeTitle(field(response, "profile-title")) || host(url), kind: "url", url: url,
    interval: hours > 0 ? hours * 3600 : 3600 }
}

function linksSubscription(links) {
  var first = links.split("\n")[0]
  var hash = first.indexOf("#")
  var name = ""
  if (hash >= 0) {
    try { name = decodeURIComponent(first.slice(hash + 1)).trim() } catch (e) { name = first.slice(hash + 1).trim() }
  }
  return { id: idFor(links), name: name || host(first), kind: "links", links: links }
}
