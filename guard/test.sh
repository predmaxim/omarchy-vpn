#!/bin/bash

# vpn-guard's table, without root and without the machine's network: guard/test.sh
# runs itself again in a network namespace of its own (unshare -rn) with two dummy
# devices, an uplink "wlan" and the TUN "Meta". Nothing answers there: a rejected
# connection fails at once (curl exit 7), one the guard lets out times out (exit 28).
# PASS or FAIL per check; the exit code is the number of failures.

set -uo pipefail
G=$(dirname "$(realpath "$0")")/vpn-guard
if [[ ${1-} != --inside ]]; then
  exec unshare -rn "$0" --inside
fi

failed=0
check() { # check <what> <expected> <actual>
  if [[ $2 == "$3" ]]; then
    echo "PASS  $1"
  else
    echo "FAIL  $1 (expected $2, got $3)"
    ((++failed))
  fi
}
conn() { # conn <ip> [curl args...]: curl's exit code
  local h=$1
  [[ $h == *:* ]] && h="[$h]"
  curl -s -m 1 -o /dev/null "${@:2}" "http://$h/"
  echo $?
}

ip link set lo up
ip link add wlan type dummy && ip link set wlan up
ip addr add 192.0.2.2/24 dev wlan && ip addr add 2001:db8::2/64 dev wlan nodad
ip route add default via 192.0.2.1 dev wlan && ip -6 route add default via 2001:db8::1 dev wlan
ip link add Meta type dummy && ip link set Meta up
ip addr add 198.18.0.1/30 dev Meta

list=$'160.79.104.10/23\n153.61.224.0/22\n2607:6BC0::/48\n2607:6bc0::/48\n10.1.0.0/16\n1.2.3.4/24; flush ruleset\nfoo\n\r\n'
list+=$'300.1.1.1/24\n1.2.3.4/33\n0.0.0.0/0\n1.0.0.0/7\n::/0\n2607::/15\n2607::/129\n'
err=$(printf '%s' "$list" | "$G" ruleset 2>&1 >/dev/null)
check "invalid, out of range and too wide lines skipped, nft syntax never passed" "vpn-guard: skipped 10 invalid lines" "$err"
printf '%s' "$list" | "$G" ruleset 2>/dev/null | nft -f -
check "the table loads" 0 $?
check "overlapping networks merged, host bits dropped" "160.79.104.0/23" \
  "$(nft -j list set inet vpn_guard vpn4 | jq -r '.nftables[1].set.elem[] | select(.prefix) | "\(.prefix.addr)/\(.prefix.len)"' | grep 160.79)"

check "listed IPv4 past the VPN: rejected" 7 "$(conn 160.79.104.10)"
check "the other listed IPv4 network: rejected" 7 "$(conn 153.61.227.1)"
check "listed IPv6 past the VPN: rejected" 7 "$(conn 2607:6bc0::10)"
check "UDP to a listed address: refused at once" 1 "$(python3 -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try: s.sendto(b"x", ("160.79.104.10", 443))
except PermissionError: exit(1)' 2>/dev/null; echo $?)"
check "an unlisted address: let out" 28 "$(conn 93.184.216.34)"
check "a private network, though listed: let out" 28 "$(conn 10.1.2.3)"
ip route add 160.79.104.0/23 dev Meta
check "listed IPv4 through Meta (the VPN up): let out" 28 "$(conn 160.79.104.10)"
ip route del 160.79.104.0/23 dev Meta

printf '1:2:3:4:5:6:7:8:9/64\n' | "$G" ruleset 2>/dev/null | nft -f - 2>/dev/null
check "a bad IPv6 network fails the whole reload" 1 $?
check "and the table stays as it was" 7 "$(conn 160.79.104.10)"
printf '' | "$G" ruleset | nft -f -
check "an empty list loads" 0 $?
check "and lets everything out" 28 "$(conn 160.79.104.10)"
"$G" stop
check "stop removes the table" 1 "$(nft list table inet vpn_guard >/dev/null 2>&1; echo $?)"

exit $failed
