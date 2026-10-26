.pragma library
// Pure logic of predmaxim.vpn: state.json, mihomo's config, subscriptions and
// links, status from mihomo's API. No QML in here, so node runs it (test.js).

var TEST_URL = "https://www.gstatic.com/generate_204"
// A globe: on — md-web, off — md-web_off, error — md-web_cancel (also red).
var GLYPHS = { on: "\u{F059F}", off: "\u{F0A8E}", error: "\u{F1790}" }
// Sites of a country go direct: its TLDs, mihomo's geosite list, its GeoIP code.
// cidrs: its IPv4 networks, kept out of TUN by the kernel, so their traffic
// never reaches mihomo (gVisor costs CPU even for DIRECT).
var COUNTRIES = { ru: { suffixes: ["ru", "su", "xn--p1ai"], geosite: "category-ru", geoip: "RU",
  cidrs: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/ru.list" } }
// Where the writer puts the country's networks in tun.route-exclude-address:
// the list (~13k lines) is too big to pass through the environment.
var CIDRS_MARK = "@country-cidrs"
// Never through the tunnel: LAN, corporate VPNs, Tailscale, loopback, link-local.
var PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"]
// SOCKS ports of Xray on localhost: a block per xray subscription, a port per location.
// shortcut: up to XRAY_BLOCK locations a subscription; widen the block if one has more.
var XRAY_PORT = 17900
var XRAY_BLOCK = 100
// Data reaches the writer through environment variables, up to 128 KiB each:
// a file goes in parts of this many UTF-16 units (≤ 3 bytes apiece in UTF-8).
var PART = 32768
var RETRY = [5000, 15000, 60000]
var RETRY_LAST = 300000

function defaults(secret) {
  return { version: 1, secret: secret || "", port: 9097, enabled: false, active: "",
    subscriptions: [], country: "ru", blockAds: true, autoSwitch: true, proxyDomains: [], directDomains: [],
    // Bypass VPN. Ports: packets from them are kept out of TUN by the kernel.
    // Apps: DIRECT by process name in mihomo. Default — torrent clients.
    directPorts: [51413],
    directApps: ["transmission-qt", "transmission-gtk", "transmission-daemon", "qbittorrent", "qbittorrent-nox"] }
}

// state.json text -> { state, broken }. Missing fields take their defaults.
// A file that does not parse is broken: it holds the only copy of the
// subscription keys, so the widget must not write over it.
function parseState(text) {
  var parsed = null
  try { parsed = JSON.parse(text) } catch (e) {}
  var out = defaults("")
  if (!parsed || typeof parsed !== "object") return { state: out, broken: true }
  for (var key in out) if (parsed[key] !== undefined) out[key] = parsed[key]
  return { state: out, broken: false }
}

function load(text) { return parseState(text).state }

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
    // Qt.atob (QML) already decodes the UTF-8; atob (node) gives its bytes.
    if (typeof atob !== "function") return Qt.atob(value.slice(7)).trim()
    return decodeURIComponent(escape(atob(value.slice(7)))).trim()
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

// A subscription that answers with Xray JSON is kind "xray": mihomo can't use
// its servers (their REALITY lets in Xray clients only), so Xray runs its
// locations and mihomo goes through them (xrayConfig, files). location: the
// picked one's name, "" — any, the fastest that answers.
function urlSubscription(url, raw) {
  var response = splitResponse(raw)
  var hours = parseInt(field(response, "profile-update-interval"), 10)
  var sub = { id: idFor(url), name: decodeTitle(field(response, "profile-title")) || host(url), kind: "url", url: url,
    interval: hours > 0 ? hours * 3600 : 3600 }
  var locations = xrayLocations(response.body)
  if (locations) { sub.kind = "xray"; sub.locations = locations; sub.location = "" }
  return sub
}

// Xray JSON — a JSON array of whole Xray configs, one per location (remarks) —
// -> [{ name, outbounds, rule, balancers, observatory }]; null if body is not that.
// Kept: the servers and how the config picks one for the rest of the traffic —
// its last rule without conditions, with its balancer. Its other rules (sites
// that go direct) are dropped: what goes through the VPN is mihomo's to decide.
function xrayLocations(body) {
  var list = null
  try { list = JSON.parse(body) } catch (e) {}
  if (!Array.isArray(list) || !list.length || !list.every(function(p) { return p && Array.isArray(p.outbounds) })) return null
  var out = []
  list.forEach(function(profile, i) {
    var rules = (profile.routing || {}).rules || []
    var rule = rules.filter(function(r) {
      return (r.balancerTag || r.outboundTag) && Object.keys(r).every(function(k) {
        return ["type", "network", "ruleTag", "balancerTag", "outboundTag"].indexOf(k) >= 0 })
    }).pop()
    var target = rule ? (rule.balancerTag ? { balancerTag: rule.balancerTag } : { outboundTag: rule.outboundTag }) : null
    // The name is the dropdown's value: it must be unique.
    var name = String(profile.remarks || "").trim() || String(i + 1)
    if (out.some(function(l) { return l.name === name })) name += " " + (i + 1)
    out.push({ name: name, outbounds: profile.outbounds, rule: target,
      balancers: ((profile.routing || {}).balancers || []).filter(function(b) { return target && b.tag === target.balancerTag }),
      observatory: profile.burstObservatory || null })
  })
  return out
}

// Xray's config for an xray subscription: every location behind a SOCKS port
// of its own on localhost (sub.port + its index), the API secret the password.
// Tags get the location's index in front: locations reuse them ("direct", …).
// shortcut: tags that outbounds point at (proxySettings, dialerProxy) keep no
// prefix — none of the known subscriptions use them; prefix them if one does.
function xrayConfig(sub, secret) {
  var cfg = { log: { loglevel: "warning" }, inbounds: [], outbounds: [], routing: { rules: [], balancers: [] } }
  var watch = null
  sub.locations.forEach(function(loc, i) {
    function tag(t) { return i + "-" + t }
    cfg.inbounds.push({ tag: tag("in"), listen: "127.0.0.1", port: sub.port + i, protocol: "socks",
      settings: { auth: "password", accounts: [{ user: "vpn", pass: secret }], udp: true } })
    loc.outbounds.forEach(function(o, j) { cfg.outbounds.push(Object.assign({}, o, { tag: tag(o.tag || "o" + j) })) })
    // No rule of its own: Xray's way — the location's first outbound.
    var target = !loc.rule ? { outboundTag: tag(loc.outbounds[0].tag || "o0") }
      : loc.rule.balancerTag ? { balancerTag: tag(loc.rule.balancerTag) } : { outboundTag: tag(loc.rule.outboundTag) }
    cfg.routing.rules.push(Object.assign({ type: "field", inboundTag: [tag("in")] }, target))
    loc.balancers.forEach(function(b) {
      var nb = Object.assign({}, b, { tag: tag(b.tag), selector: (b.selector || []).map(tag) })
      if (b.fallbackTag) nb.fallbackTag = tag(b.fallbackTag)
      cfg.routing.balancers.push(nb)
    })
    // One observatory for all: the first location's settings, everyone's servers.
    if (loc.observatory) {
      watch = watch || Object.assign({}, loc.observatory, { subjectSelector: [] })
      watch.subjectSelector = watch.subjectSelector.concat((loc.observatory.subjectSelector || []).map(tag))
    }
  })
  if (watch) cfg.burstObservatory = watch
  return cfg
}

// Xray of each xray subscription is the user unit mihomo-xray@<id>: restart
// those whose config changed (or that are new), stop the removed ones.
function xrayChanges(prev, next) {
  var before = {}
  prev.subscriptions.forEach(function(s) { if (s.kind === "xray") before[s.id] = JSON.stringify(xrayConfig(s, prev.secret)) })
  var restart = next.subscriptions.filter(function(s) {
    return s.kind === "xray" && before[s.id] !== JSON.stringify(xrayConfig(s, next.secret)) }).map(function(s) { return s.id })
  var stop = Object.keys(before).filter(function(id) { return !next.subscriptions.some(function(s) { return s.id === id }) })
  return { restart: restart, stop: stop }
}

// The picked location of an xray subscription; null — any (or it's gone).
function locationOf(sub) {
  return (sub.locations || []).filter(function(l) { return l.name === sub.location })[0] || null
}

// name: a location's, or "" — any. The same state back when nothing changes
// (unknown subscription or location, already picked).
function setLocation(state, id, name) {
  var sub = state.subscriptions.filter(function(s) { return s.id === id })[0]
  if (!sub || !sub.locations || sub.location === name || (name && !sub.locations.some(function(l) { return l.name === name }))) return state
  var next = clone(state)
  next.subscriptions.forEach(function(s) { if (s.id === id) s.location = name })
  return next
}

// ←/→ on a subscription row: "any", then the locations, round.
function nextLocation(sub, step) {
  var names = [""].concat((sub.locations || []).map(function(l) { return l.name }))
  var i = Math.max(0, names.indexOf(sub.location))
  return names[((i + step) % names.length + names.length) % names.length]
}

// A fresh download: its servers; the picked location stays while it is there, else any.
function setLocations(state, id, locations) {
  var next = clone(state)
  next.subscriptions.forEach(function(s) {
    if (s.id !== id) return
    s.locations = locations
    s.location = (locationOf(s) || { name: "" }).name
  })
  return next
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
  sub = clone(sub)
  // Xray's first SOCKS port: the next block of XRAY_BLOCK after those taken.
  if (sub.kind === "xray") sub.port = XRAY_BLOCK + Math.max.apply(null, [XRAY_PORT - XRAY_BLOCK].concat(state.subscriptions.map(function(s) { return s.port || 0 })))
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
  // The active subscription first. autoSwitch — fallback: while it answers it's used; when
  // it doesn't, the next live one in this order, back to it once it recovers.
  var order = subs.map(function(s) { return s.id }).sort(function(a, b) {
    return (b === state.active) - (a === state.active)
  })
  var proxies = order.length ? order : ["DIRECT"]
  var country = COUNTRIES[state.country]
  var groups = [state.autoSwitch
    ? { name: "VPN", type: "fallback", proxies: proxies, url: TEST_URL, interval: 60, timeout: 5000 }
    : { name: "VPN", type: "select", proxies: proxies }]
  subs.forEach(function(s) {
    // Not lazy: tested on their interval even while unused, so the fallback
    // finds the fastest server (location) already measured.
    groups.push({ name: s.id, type: "url-test", use: [s.id], url: TEST_URL, lazy: false,
      interval: 300, tolerance: 50, timeout: 5000, "max-failed-times": 3 })
  })
  var rules = state.directApps.map(function(a) { return "PROCESS-NAME," + a + ",DIRECT" })
  // Xray's own traffic to its servers comes back through TUN: out it goes, or it loops.
  if (subs.some(function(s) { return s.kind === "xray" })) rules.unshift("PROCESS-NAME,xray,DIRECT")
  state.proxyDomains.forEach(function(d) { rules.push("DOMAIN-SUFFIX," + d + ",VPN") })
  state.directDomains.forEach(function(d) { rules.push("DOMAIN-SUFFIX," + d + ",DIRECT") })
  PRIVATE.forEach(function(c) { rules.push("IP-CIDR," + c + ",DIRECT,no-resolve") })
  if (state.blockAds) rules.push("GEOSITE,category-ads-all,REJECT")
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
      "auto-detect-interface": true, "dns-hijack": ["any:53"],
      "route-exclude-address": (country ? [CIDRS_MARK] : []).concat(PRIVATE), "exclude-src-port": state.directPorts },
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
    // mihomo sees each location as a SOCKS server named after it — all of them
    // (url-test keeps the fastest that answers) or the picked one. Provider
    // format; JSON is YAML too.
    if (s.kind === "xray") {
      out.push({ path: "xray/" + s.id + ".json", data: JSON.stringify(xrayConfig(s, state.secret), null, 2) + "\n" })
      var proxies = s.locations.map(function(l, i) {
        return { name: l.name, type: "socks5", server: "127.0.0.1", port: s.port + i, username: "vpn", password: state.secret, udp: true }
      }).filter(function(p) { return !locationOf(s) || p.name === s.location })
      out.push({ path: "links/" + s.id + ".txt", data: JSON.stringify({ proxies: proxies }) + "\n" })
    }
  })
  return out
}

// Files reach the writer through its environment, not argv: argv is readable
// by every user (/proc/<pid>/cmdline), the environment only by its owner. Each
// in PART-sized pieces: state.json with an xray subscription runs to ~80 KB.
function writerEnv(state) {
  var list = files(state)
  var env = {
    FILE_COUNT: String(list.length),
    CIDRS_URL: COUNTRIES[state.country] ? COUNTRIES[state.country].cidrs : "",
    CIDRS_FILE: "cidrs-" + state.country + ".txt",
    KEEP_SUBS: state.subscriptions.filter(function(s) { return s.kind === "url" })
      .map(function(s) { return s.id + ".txt" }).join(" ")
  }
  list.forEach(function(f, i) {
    env["FILE_" + i + "_PATH"] = f.path
    var parts = 0
    for (var at = 0; at < f.data.length || !parts; parts++) {
      var end = at + PART
      // Never between the halves of a surrogate pair (emoji): each part must be valid text.
      if (/[\uD800-\uDBFF]/.test(f.data.charAt(end - 1))) end--
      env["FILE_" + i + "_DATA_" + parts] = f.data.slice(at, end)
      at = end
    }
    env["FILE_" + i + "_PARTS"] = String(parts)
  })
  return env
}

// sh -c WRITE_SCRIPT sh <dir>: writes every file (its parts, via .tmp + mv),
// drops link files and Xray configs of removed subscriptions and caches of
// removed URL subscriptions.
// Downloads the country's networks when the copy is missing or a week old (a
// failed download keeps the old copy) and puts its IPv4 lines in place of
// CIDRS_MARK; without a copy the country still goes direct by mihomo's rules.
// Creates <dir> on a fresh machine. Writers take turns through a .lock dir
// (there is one widget per monitor); a lock left by a killed writer is broken
// after 5 s. With FIRST_RUN set it writes nothing if state.json exists:
// another widget made it first.
var WRITE_SCRIPT = [
  'umask 077',
  'mkdir -p "$1" && cd "$1" || exit 1',
  'n=0',
  'until mkdir .lock 2>/dev/null; do sleep 0.1; n=$((n + 1)); [ "$n" -lt 50 ] || { rmdir .lock 2>/dev/null; n=0; }; done',
  "trap 'rmdir .lock' EXIT",
  'trap "exit 1" INT TERM',
  '[ -n "$FIRST_RUN" ] && [ -e state.json ] && exit 0',
  'mkdir -p links subs xray || exit 1',
  'rm -f links/*.txt xray/*.json',
  'for f in subs/*.txt; do [ -e "$f" ] || continue; case " $KEEP_SUBS " in *" ${f#subs/} "*) ;; *) rm -f "$f" ;; esac; done',
  'i=0',
  'while [ "$i" -lt "$FILE_COUNT" ]; do',
  '  eval "p=\\$FILE_${i}_PATH; n=\\$FILE_${i}_PARTS"',
  '  : > "$p.tmp" || exit 1',
  '  j=0',
  '  while [ "$j" -lt "$n" ]; do eval "d=\\$FILE_${i}_DATA_${j}"; printf "%s" "$d" >> "$p.tmp" || exit 1; j=$((j + 1)); done',
  '  mv "$p.tmp" "$p" || exit 1',
  '  i=$((i + 1))',
  'done',
  'if [ -n "$CIDRS_URL" ] && [ -z "$(find "$CIDRS_FILE" -mtime -7 2>/dev/null)" ]; then',
  '  curl -fsSL --max-time 20 -o "$CIDRS_FILE.tmp" "$CIDRS_URL" && mv "$CIDRS_FILE.tmp" "$CIDRS_FILE"; rm -f "$CIDRS_FILE.tmp"',
  'fi',
  // The list has no newline at its end: the separator brings its own.
  '{ cat "$CIDRS_FILE" 2>/dev/null; printf "\\n@@end\\n"; cat config.yaml; } | awk \'',
  '  !e { if ($0 == "@@end") e = 1; else if ($0 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\\/[0-9]+$/) c = c "      \\"" $0 "\\",\\n"; next }',
  '  /"' + CIDRS_MARK + '",$/ { printf "%s", c; next } { print }\' > config.yaml.tmp && mv config.yaml.tmp config.yaml || exit 1'
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

// Between states (an orange icon): a change being applied (busy), the server
// not tested yet, or no servers / no answer while the quick retries still run.
function isConnecting(v, busy, attempt) {
  if (busy) return true
  if (v.kind === "on") return v.delay < 0
  return (v.kind === "dead" || v.kind === "nosrv") && attempt < RETRY.length
}

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
