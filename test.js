// node test.js
const fs = require("fs")
const assert = require("assert")
const src = fs.readFileSync(__dirname + "/Model.js", "utf8").replace(".pragma library", "")
const M = new Function(src + `; return { defaults, load, randomSecret, clone, patch, idFor, classify, host,
  decodeTitle, splitResponse, urlSubscription, linksSubscription }`)()

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

console.log("ok")
