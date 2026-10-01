.pragma library
// One request to mihomo's REST API on localhost. done(ok, data, httpStatus):
// data is the parsed JSON body (or null). A dead service answers with status 0.
function request(port, secret, method, path, body, done) {
  var xhr = new XMLHttpRequest()
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== XMLHttpRequest.DONE) return
    var data = null
    try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch (e) {}
    done(xhr.status >= 200 && xhr.status < 300, data, xhr.status)
  }
  xhr.open(method, "http://127.0.0.1:" + port + path)
  xhr.setRequestHeader("Authorization", "Bearer " + secret)
  if (body === null || body === undefined) {
    xhr.send()
  } else {
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.send(JSON.stringify(body))
  }
}
