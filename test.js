// node test.js
const fs = require("fs")
const assert = require("assert")
const src = fs.readFileSync(__dirname + "/Model.js", "utf8").replace(".pragma library", "")
const M = new Function(src + `; return { defaults, load, randomSecret, clone, patch, idFor, classify, host,
  decodeTitle, splitResponse, urlSubscription, linksSubscription, addSubscription, removeSubscription, useSubscription,
  setEnabled, normalizeDomain, addDomain, removeDomain, buildConfig, files, writerEnv, WRITE_SCRIPT, status, view, isError,
  glyph, tooltip, retryDelay, TEST_URL }`)()

// state.json: broken or partial files fall back to defaults field by field
assert.deepStrictEqual(M.load("{broken"), M.defaults(""))
assert.strictEqual(M.load('{"secret":"x","enabled":true}').secret, "x")
assert.strictEqual(M.load('{"secret":"x","enabled":true}').country, "ru")
assert.strictEqual(M.randomSecret(() => 0.5).length, 32)
assert.ok(/^[0-9a-f]{32}$/.test(M.randomSecret(Math.random)))
const s0 = M.defaults("k")
assert.notStrictEqual(M.patch(s0, { country: "" }), s0)
assert.strictEqual(M.patch(s0, { country: "" }).country, "")
assert.strictEqual(s0.country, "ru")

// ids: same source — same id
assert.strictEqual(M.idFor("abc"), M.idFor("abc"))
assert.notStrictEqual(M.idFor("abc"), M.idFor("abd"))
assert.ok(/^s[0-9a-z]+$/.test(M.idFor("https://x")))

// classify: subscriptions, links, rubbish
assert.deepStrictEqual(M.classify("  https://sub.example.com/x?y=1 \r\n"), { kind: "url", url: "https://sub.example.com/x?y=1" })
assert.deepStrictEqual(M.classify("# my links\n\nhy2://p@1.2.3.4:443?sni=a#A\r\nvless://u@h:443?security=reality#B\n"),
  { kind: "links", links: "hy2://p@1.2.3.4:443?sni=a#A\nvless://u@h:443?security=reality#B" })
assert.strictEqual(M.classify("hello world"), null)
assert.strictEqual(M.classify(""), null)
assert.strictEqual(M.classify("hy2://p@h:1#A\nnot a link"), null)
assert.strictEqual(M.classify("https://a.com\nhttps://b.com"), null)

assert.strictEqual(M.host("vless://uuid@srv.example.com:443?x=1#n"), "srv.example.com")
assert.strictEqual(M.host("https://app.example.com/bv/abc"), "app.example.com")

// titles: base64 (UTF-8) and plain
assert.strictEqual(M.decodeTitle("base64:8J+Hq/Cfh7cgZXhhbXBsZS5jb20="), "🇫🇷 example.com")
assert.strictEqual(M.decodeTitle(" Plain "), "Plain")
assert.strictEqual(M.decodeTitle("base64:%%%"), "")

// curl -D - output: header blocks (redirects too), then the body
const raw = "HTTP/1.1 302 Found\r\nLocation: x\r\n\r\nHTTP/2 200\r\nprofile-update-interval: 2\r\n\r\n#profile-title: base64:8J+Hq/Cfh7cgZXhhbXBsZS5jb20=\nvless://a@b:1#c\n"
const r = M.splitResponse(raw)
assert.ok(r.headers.includes("profile-update-interval: 2"))
assert.strictEqual(r.body, "#profile-title: base64:8J+Hq/Cfh7cgZXhhbXBsZS5jb20=\nvless://a@b:1#c\n")
const sub = M.urlSubscription("https://app.example.com/bv/abc", raw)
assert.deepStrictEqual(sub, { id: M.idFor("https://app.example.com/bv/abc"), name: "🇫🇷 example.com", kind: "url",
  url: "https://app.example.com/bv/abc", interval: 7200 })
// a title header beats the body; no title — the host; no interval — 1 h
assert.strictEqual(M.urlSubscription("https://h.com/s", "HTTP/1.1 200 OK\nprofile-title: Head\n\n#profile-title: Body\n").name, "Head")
assert.deepStrictEqual(M.urlSubscription("https://h.com/s", "HTTP/1.1 200 OK\n\nvless://a@b:1\n").name, "h.com")
assert.strictEqual(M.urlSubscription("https://h.com/s", "").interval, 3600)

// links: the first link's #fragment, else its host
assert.strictEqual(M.linksSubscription("hy2://p@1.2.3.4:443?sni=a#Main%20Hy2\nvless://x@y:1#B").name, "Main Hy2")
assert.strictEqual(M.linksSubscription("vless://x@srv.io:443").name, "srv.io")
assert.strictEqual(M.linksSubscription("vless://x@srv.io:443").kind, "links")

// subscriptions: the first added becomes active; the same source twice is refused
const a = { id: "sa", name: "A", kind: "links", links: "hy2://x@a:1#A" }
const b = { id: "sb", name: "B", kind: "url", url: "https://b", interval: 3600 }
let st = M.addSubscription(M.defaults("k"), a).state
assert.strictEqual(st.active, "sa")
st = M.addSubscription(st, b).state
assert.strictEqual(st.active, "sa")
assert.strictEqual(st.subscriptions.length, 2)
assert.strictEqual(M.addSubscription(st, a).error, "exists")
assert.strictEqual(M.useSubscription(st, "sb").active, "sb")
assert.strictEqual(M.useSubscription(st, "nope").active, "sa")
// removing the active one activates the first left; removing the last one turns VPN off
st = M.setEnabled(st, true)
assert.strictEqual(st.enabled, true)
st = M.removeSubscription(st, "sa")
assert.strictEqual(st.active, "sb")
assert.strictEqual(st.enabled, true)
st = M.removeSubscription(st, "sb")
assert.strictEqual(st.active, "")
assert.strictEqual(st.enabled, false)
// no subscriptions — VPN cannot be on
assert.strictEqual(M.setEnabled(M.defaults("k"), true).enabled, false)

// domains: normalised, ASCII only, one list at a time
assert.strictEqual(M.normalizeDomain("https://Example.COM/path?q=1"), "example.com")
assert.strictEqual(M.normalizeDomain("*.example.com"), "example.com")
assert.strictEqual(M.normalizeDomain(".example.com"), "example.com")
assert.strictEqual(M.normalizeDomain("example.com:443"), "example.com")
assert.strictEqual(M.normalizeDomain("localhost"), "")
assert.strictEqual(M.normalizeDomain("кто.рф"), "")
assert.strictEqual(M.normalizeDomain("a b.com"), "")
let d = M.addDomain(M.defaults("k"), "proxyDomains", "Kinopoisk.ru")
assert.deepStrictEqual(d.state.proxyDomains, ["kinopoisk.ru"])
assert.strictEqual(M.addDomain(d.state, "proxyDomains", "kinopoisk.ru").error, "exists")
assert.strictEqual(M.addDomain(d.state, "proxyDomains", "not a domain").error, "invalid")
d = M.addDomain(d.state, "directDomains", "kinopoisk.ru")
assert.deepStrictEqual(d.state.proxyDomains, [])
assert.deepStrictEqual(d.state.directDomains, ["kinopoisk.ru"])
assert.deepStrictEqual(M.removeDomain(d.state, "directDomains", "kinopoisk.ru").directDomains, [])

// config
let cs = M.addSubscription(M.defaults("sec"), { id: "s1", name: "Hy2-Main", kind: "links", links: "hy2://p@h:443#Hy2-Main" }).state
cs = M.addSubscription(cs, { id: "s2", name: "example", kind: "url", url: "https://sub/x", interval: 7200 }).state
cs = M.useSubscription(cs, "s2")
cs = M.setEnabled(cs, true)
cs = M.addDomain(cs, "proxyDomains", "kinopoisk.ru").state
cs = M.addDomain(cs, "directDomains", "github.com").state
let cfg = M.buildConfig(cs)
assert.strictEqual(cfg["external-controller"], "127.0.0.1:9097")
assert.strictEqual(cfg.secret, "sec")
assert.deepStrictEqual(cfg.tun, { enable: true, stack: "gvisor", "auto-route": true, "auto-detect-interface": true, "dns-hijack": ["any:53"] })
assert.deepStrictEqual(cfg.dns, { enable: true, nameserver: ["system"] })
assert.deepStrictEqual(cfg["proxy-providers"].s1, { type: "file", path: "./links/s1.txt" })
assert.deepStrictEqual(cfg["proxy-providers"].s2, { type: "http", url: "https://sub/x", path: "./subs/s2.txt", interval: 7200 })
// groups are named by id (a subscription named like its server must not clash); active first
assert.deepStrictEqual(cfg["proxy-groups"][0], { name: "VPN", type: "select", proxies: ["s2", "s1"] })
assert.deepStrictEqual(cfg["proxy-groups"][1], { name: "s1", type: "url-test", use: ["s1"], url: M.TEST_URL,
  interval: 300, tolerance: 50, timeout: 5000, "max-failed-times": 3 })
assert.deepStrictEqual(cfg.rules, [
  "DOMAIN-SUFFIX,kinopoisk.ru,VPN", "DOMAIN-SUFFIX,github.com,DIRECT",
  "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve", "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
  "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve", "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve",
  "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
  "GEOSITE,category-ads-all,REJECT",
  "DOMAIN-SUFFIX,ru,DIRECT", "DOMAIN-SUFFIX,su,DIRECT", "DOMAIN-SUFFIX,xn--p1ai,DIRECT",
  "GEOSITE,category-ru,DIRECT", "GEOIP,RU,DIRECT",
  "MATCH,VPN"])
cfg = M.buildConfig(M.patch(cs, { country: "", blockAds: false }))
assert.ok(!cfg.rules.some(r => /GEOSITE|GEOIP|DOMAIN-SUFFIX,ru,/.test(r)))
// nothing added: VPN group still valid, tun off
cfg = M.buildConfig(M.patch(M.defaults("k"), { enabled: true }))
assert.deepStrictEqual(cfg["proxy-groups"], [{ name: "VPN", type: "select", proxies: ["DIRECT"] }])
assert.strictEqual(cfg.tun.enable, false)

// files and the writer (runs the real sh script in a temp dir)
const fl = M.files(cs)
assert.deepStrictEqual(fl.map(f => f.path), ["state.json", "config.yaml", "links/s1.txt"])
assert.deepStrictEqual(JSON.parse(fl[0].data), cs)
assert.strictEqual(fl[2].data, "hy2://p@h:443#Hy2-Main\n")
const os = require("os"), path = require("path"), cp = require("child_process")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-"))
fs.mkdirSync(dir + "/links"); fs.writeFileSync(dir + "/links/old.txt", "x")
fs.mkdirSync(dir + "/subs"); fs.writeFileSync(dir + "/subs/s2.txt", "cache"); fs.writeFileSync(dir + "/subs/gone.txt", "secret")
cp.execFileSync("sh", ["-c", M.WRITE_SCRIPT, "sh", dir], { env: Object.assign({}, process.env, M.writerEnv(cs)) })
assert.strictEqual(fs.readFileSync(dir + "/links/s1.txt", "utf8"), fl[2].data)
assert.ok(!fs.existsSync(dir + "/links/old.txt"))
assert.ok(fs.existsSync(dir + "/subs/s2.txt"))
assert.ok(!fs.existsSync(dir + "/subs/gone.txt"))
assert.deepStrictEqual(JSON.parse(fs.readFileSync(dir + "/config.yaml", "utf8")), M.buildConfig(cs))
assert.strictEqual(fs.statSync(dir + "/state.json").mode & 0o777, 0o600)
fs.rmSync(dir, { recursive: true })

// status from GET /configs and GET /proxies
// Servers of a provider are not in /proxies: their test history comes from /providers/proxies.
const proxies = { proxies: {
  VPN: { type: "Selector", now: "s2", all: ["s2", "s1"] },
  s2: { type: "URLTest", now: "LTE_3", all: ["LTE_1", "LTE_3"], history: [] },
  s1: { type: "URLTest", now: "Main", all: ["Main"], history: [] } } }
const providers = { providers: {
  s2: { proxies: [{ name: "LTE_1", history: [{ delay: 300 }] }, { name: "LTE_3", history: [{ delay: 80 }, { delay: 45 }] }] },
  s1: { proxies: [{ name: "Main", history: [] }] },
  default: { proxies: [] } } }
const stt = M.status({ tun: { enable: true } }, proxies, providers)
assert.deepStrictEqual(stt, { tun: true, group: "s2", server: "LTE_3", delay: 45, counts: { s2: 2, s1: 1 } })
assert.deepStrictEqual(M.status(null, null, null), { tun: false, group: "", server: "", delay: -1, counts: {} })
// a server not tested yet: -1, not 0 (0 means the test failed)
assert.strictEqual(M.status({}, proxies, { providers: {} }).delay, -1)
// view
assert.deepStrictEqual(M.view(cs, stt, true), { kind: "on", name: "example", server: "LTE_3", delay: 45 })
assert.strictEqual(M.view(cs, stt, false).kind, "down")
assert.strictEqual(M.view(M.defaults("k"), stt, true).kind, "empty")
assert.strictEqual(M.view(cs, Object.assign({}, stt, { tun: false }), true).kind, "off")
assert.strictEqual(M.view(cs, Object.assign({}, stt, { counts: { s2: 0 } }), true).kind, "nosrv")
assert.strictEqual(M.view(cs, Object.assign({}, stt, { delay: 0 }), true).kind, "dead")
assert.ok(M.isError({ kind: "dead" }) && M.isError({ kind: "down" }) && M.isError({ kind: "nosrv" }) && !M.isError({ kind: "off" }))
assert.strictEqual(M.glyph({ kind: "on" }), "\u{F0565}")
assert.strictEqual(M.glyph({ kind: "off" }), "\u{F099E}")
assert.strictEqual(M.glyph({ kind: "dead" }), "\u{F0ECC}")
const trEn = (t, ...a) => a.reduce((s, x, i) => s.split("%" + (i + 1)).join(x), t)
assert.strictEqual(M.tooltip({ kind: "on", name: "A", server: "B", delay: -1 }, trEn), "VPN: A · B · … ms")
// a one-link subscription is named like its server: say it once
assert.strictEqual(M.tooltip({ kind: "on", name: "A", server: "A", delay: 45 }, trEn), "VPN: A · 45 ms")
// retries
assert.deepStrictEqual([0, 1, 2, 3, 9].map(M.retryDelay), [5000, 15000, 60000, 300000, 300000])

// Every tr() in the QML and Model.js has a Russian line
const I = new Function(fs.readFileSync(__dirname + "/I18n.js", "utf8").replace(".pragma library", "") + "; return { TABLES }")()
for (const f of ["Panel.qml", "Menu.qml", "Status.qml", "Model.js"]) {
  if (!fs.existsSync(__dirname + "/" + f)) continue
  for (const m of fs.readFileSync(__dirname + "/" + f, "utf8").matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g))
    assert.ok(Object.prototype.hasOwnProperty.call(I.TABLES.ru, JSON.parse(`"${m[1]}"`)), f + ": no ru for " + m[1])
}

// QML: no own property may reuse a built-in Item/Panel property name — it
// shadows the built-in and reads as undefined (rules.md §9: "state" broke Status.qml,
// id "status" read as Loader.status inside PanelHero's components)
const builtins = ["state", "status", "data", "children", "visible", "enabled", "opacity", "parent", "left", "right", "top", "bottom", "x", "y", "width", "height", "states", "focus", "settings", "opened", "bar"]
for (const f of ["Panel.qml", "Status.qml", "Menu.qml"]) {
  if (!fs.existsSync(__dirname + "/" + f)) continue
  for (const m of fs.readFileSync(__dirname + "/" + f, "utf8").matchAll(/^\s*(?:readonly\s+|required\s+)?property\s+\S+\s+(\w+)/gm))
    assert.ok(!builtins.includes(m[1]), f + ": property '" + m[1] + "' shadows a built-in")
  // ids too: components that PanelHero loads (a Loader, which has "status") see Loader's property first
  for (const m of fs.readFileSync(__dirname + "/" + f, "utf8").matchAll(/\bid:\s*(\w+)/g))
    assert.ok(!builtins.includes(m[1]), f + ": id '" + m[1] + "' shadows a built-in")
}

console.log("ok")
