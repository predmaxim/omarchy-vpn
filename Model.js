.pragma library
// Pure logic of predmaxim.vpn: state.json, mihomo's config, subscriptions and
// links, status from mihomo's API. No QML in here, so node runs it (test.js).

var TEST_URL = "https://www.gstatic.com/generate_204"
var ERROR_COLOR = "#e5534b"
var GLYPHS = { on: "\u{F0565}", off: "\u{F099E}", error: "\u{F0ECC}" }
// Sites of a country go direct: its TLDs, mihomo's geosite list, its GeoIP code.
var COUNTRIES = { ru: { suffixes: ["ru", "su", "xn--p1ai"], geosite: "category-ru", geoip: "RU" } }
// Never through the tunnel: LAN, corporate VPNs, Tailscale, loopback.
var PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]
var RETRY = [5000, 15000, 60000]
var RETRY_LAST = 300000

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

function addSubscription(state, sub) {
  for (var i = 0; i < state.subscriptions.length; i++)
    if (state.subscriptions[i].id === sub.id) return { state: state, error: "exists" }
  var next = clone(state)
  next.subscriptions.push(sub)
  if (!next.active) next.active = sub.id
  return { state: next, error: "" }
}

// The active one gone: the first left takes over; none left: VPN goes off.
function removeSubscription(state, id) {
  var next = clone(state)
  next.subscriptions = next.subscriptions.filter(function(s) { return s.id !== id })
  if (next.active === id) next.active = next.subscriptions.length ? next.subscriptions[0].id : ""
  if (!next.subscriptions.length) next.enabled = false
  return next
}

function useSubscription(state, id) {
  var known = state.subscriptions.some(function(s) { return s.id === id })
  return known ? patch(state, { active: id }) : state
}

function setEnabled(state, on) {
  return patch(state, { enabled: !!on && state.subscriptions.length > 0 })
}

// "https://Sub.Example.COM:443/x", "*.example.com" -> "example.com"; "" if not
// a domain. ASCII only: hostnames reach mihomo in punycode.
function normalizeDomain(text) {
  var d = String(text || "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  d = d.split(/[\/?#]/)[0].replace(/:\d+$/, "").replace(/^\*?\./, "")
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : ""
}

// list: "proxyDomains" or "directDomains". A domain lives in one list only.
function addDomain(state, list, text) {
  var domain = normalizeDomain(text)
  if (!domain) return { state: state, error: "invalid" }
  if (state[list].indexOf(domain) >= 0) return { state: state, error: "exists" }
  var other = list === "proxyDomains" ? "directDomains" : "proxyDomains"
  var next = clone(state)
  next[list].push(domain)
  next[other] = next[other].filter(function(x) { return x !== domain })
  return { state: next, error: "" }
}

function removeDomain(state, list, domain) {
  var next = clone(state)
  next[list] = next[list].filter(function(x) { return x !== domain })
  return next
}

function buildConfig(state) {
  var subs = state.subscriptions
  var providers = {}
  subs.forEach(function(s) {
    providers[s.id] = s.kind === "url"
      ? { type: "http", url: s.url, path: "./subs/" + s.id + ".txt", interval: s.interval || 3600 }
      : { type: "file", path: "./links/" + s.id + ".txt" }
  })
  // The active subscription first: mihomo falls back to the first one when it lost its saved choice.
  var order = subs.map(function(s) { return s.id }).sort(function(a, b) {
    return (b === state.active) - (a === state.active)
  })
  var groups = [{ name: "VPN", type: "select", proxies: order.length ? order : ["DIRECT"] }]
  subs.forEach(function(s) {
    groups.push({ name: s.id, type: "url-test", use: [s.id], url: TEST_URL,
      interval: 300, tolerance: 50, timeout: 5000, "max-failed-times": 3 })
  })
  var rules = []
  state.proxyDomains.forEach(function(d) { rules.push("DOMAIN-SUFFIX," + d + ",VPN") })
  state.directDomains.forEach(function(d) { rules.push("DOMAIN-SUFFIX," + d + ",DIRECT") })
  PRIVATE.forEach(function(c) { rules.push("IP-CIDR," + c + ",DIRECT,no-resolve") })
  if (state.blockAds) rules.push("GEOSITE,category-ads-all,REJECT")
  var country = COUNTRIES[state.country]
  if (country) {
    country.suffixes.forEach(function(t) { rules.push("DOMAIN-SUFFIX," + t + ",DIRECT") })
    rules.push("GEOSITE," + country.geosite + ",DIRECT", "GEOIP," + country.geoip + ",DIRECT")
  }
  rules.push("MATCH,VPN")
  return {
    "mode": "rule",
    "log-level": "warning",
    "ipv6": false,
    "external-controller": "127.0.0.1:" + state.port,
    "secret": state.secret,
    "profile": { "store-selected": true },
    "dns": { "enable": true, "nameserver": ["system"] },
    "tun": { "enable": !!state.enabled && subs.length > 0, "stack": "gvisor", "auto-route": true,
      "auto-detect-interface": true, "dns-hijack": ["any:53"] },
    "proxy-providers": providers,
    "proxy-groups": groups,
    "rules": rules
  }
}

// What goes into ~/.config/mihomo (paths relative to it). config.yaml is
// JSON, which is YAML too.
function files(state) {
  var out = [
    { path: "state.json", data: JSON.stringify(state, null, 2) + "\n" },
    { path: "config.yaml", data: JSON.stringify(buildConfig(state), null, 2) + "\n" }
  ]
  state.subscriptions.forEach(function(s) {
    if (s.kind === "links") out.push({ path: "links/" + s.id + ".txt", data: s.links + "\n" })
  })
  return out
}

// Files reach the writer through its environment, not argv: argv is readable
// by every user (/proc/<pid>/cmdline), the environment only by its owner.
function writerEnv(state) {
  var list = files(state)
  var env = {
    FILE_COUNT: String(list.length),
    KEEP_SUBS: state.subscriptions.filter(function(s) { return s.kind === "url" })
      .map(function(s) { return s.id + ".txt" }).join(" ")
  }
  list.forEach(function(f, i) { env["FILE_" + i + "_PATH"] = f.path; env["FILE_" + i + "_DATA"] = f.data })
  return env
}

// sh -c WRITE_SCRIPT sh <dir>: writes every file (via .tmp + mv), drops link
// files of removed subscriptions and caches of removed URL subscriptions.
var WRITE_SCRIPT = [
  'cd "$1" || exit 1',
  'umask 077',
  'mkdir -p links subs || exit 1',
  'rm -f links/*.txt',
  'for f in subs/*.txt; do [ -e "$f" ] || continue; case " $KEEP_SUBS " in *" ${f#subs/} "*) ;; *) rm -f "$f" ;; esac; done',
  'i=0',
  'while [ "$i" -lt "$FILE_COUNT" ]; do',
  '  eval "p=\\$FILE_${i}_PATH; d=\\$FILE_${i}_DATA"',
  '  printf "%s" "$d" > "$p.tmp" && mv "$p.tmp" "$p" || exit 1',
  '  i=$((i + 1))',
  'done'
].join("\n")

// GET /configs, /proxies and /providers/proxies -> what the icon needs.
// Groups live in /proxies; servers of a subscription only in its provider, so
// their test history comes from there. delay: last test of the current server,
// 0 — it failed, -1 — not tested yet.
function status(configs, proxies, providers) {
  var all = proxies && proxies.proxies ? proxies.proxies : {}
  var vpn = all.VPN || {}
  var group = all[vpn.now] || {}
  var provider = providers && providers.providers && providers.providers[vpn.now] || {}
  var server = (provider.proxies || []).filter(function(p) { return p.name === group.now })[0] || {}
  var history = server.history || []
  var counts = {}
  for (var name in all) if (all[name].type === "URLTest") counts[name] = (all[name].all || []).length
  return { tun: !!(configs && configs.tun && configs.tun.enable), group: vpn.now || "", server: group.now || "",
    delay: history.length ? history[history.length - 1].delay : -1, counts: counts }
}

function view(state, st, apiUp) {
  var id = st.group || state.active
  var sub = state.subscriptions.filter(function(s) { return s.id === id })[0]
  var v = { kind: "on", name: sub ? sub.name : "", server: st.server, delay: st.delay }
  if (!apiUp) v.kind = "down"
  else if (!state.subscriptions.length) v.kind = "empty"
  else if (!st.tun) v.kind = "off"
  else if (!st.counts[st.group]) v.kind = "nosrv"
  else if (st.delay === 0) v.kind = "dead"
  return v
}

function isError(v) { return v.kind === "down" || v.kind === "nosrv" || v.kind === "dead" }

function glyph(v) { return isError(v) ? GLYPHS.error : (v.kind === "on" ? GLYPHS.on : GLYPHS.off) }

function tooltip(v, tr) {
  if (v.kind === "down") return tr("VPN service is not running")
  if (v.kind === "empty") return tr("VPN: no subscriptions")
  if (v.kind === "off") return tr("VPN is off")
  if (v.kind === "nosrv") return tr("VPN: no servers in %1", v.name)
  if (v.kind === "dead") return tr("VPN: no connection to %1", v.name)
  var delay = v.delay > 0 ? v.delay : "…"
  // A one-link subscription is named like its server: say it once.
  if (v.server === v.name) return tr("VPN: %1 · %2 ms", v.name, delay)
  return tr("VPN: %1 · %2 · %3 ms", v.name, v.server, delay)
}

function retryDelay(attempt) { return attempt < RETRY.length ? RETRY[attempt] : RETRY_LAST }
