#!/bin/bash

# vpn-guard, without root and without the machine's network or DNS: guard/test.sh runs
# itself again in namespaces of its own (unshare -rnm): two dummy devices, an uplink
# "wlan" and the TUN "Meta"; /run/systemd and /home on tmpfs; systemctl, resolvectl and
# setpriv stand-ins that log their calls. Nothing answers there: a rejected connection
# fails at once (curl exit 7), one the guard lets out times out (exit 28).
# PASS or FAIL per check; the exit code is the number of failures.

set -uo pipefail
G=$(dirname "$(realpath "$0")")/vpn-guard
if [[ ${1-} != --inside ]]; then
  REAL_USER=$(id -un) exec unshare -rnm "$0" --inside
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

# DNS of the domains: resolved's drop-in (resolved itself is not here), its server held.
conf=$(printf 'anthropic.com\nclaude.ai\r\nfoo\nx.com; DNS=1.1.1.1\n%s.com\n\n' "$(printf 'a%.0s' {1..64})" | "$G" resolved 2>/dev/null)
check "resolved's drop-in: the domains, route-only, to the server through the VPN" \
  $'# vpn-guard: the DNS of "always through VPN" goes through the VPN\n[Resolve]\nDNS=9.9.9.9:9953\nDomains=~anthropic.com ~claude.ai' "$conf"
check "no domains, no drop-in" "" "$(printf '' | "$G" resolved)"
printf '' | "$G" ruleset --dns | nft -f -
check "with domains the DNS server is held: past the VPN refused" 1 "$(python3 -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try: s.sendto(b"x", ("9.9.9.9", 9953))
except PermissionError: exit(1)' 2>/dev/null; echo $?)"
printf '' | "$G" ruleset | nft -f -
check "without them it is free" 28 "$(conn 9.9.9.9)"


# start and stop as the unit runs them, on this namespace's /run and /home only.
STUB=$(mktemp -d)
cp "$G" "$STUB/vpn-guard" && G=$STUB/vpn-guard # /home goes under tmpfs, this repo with it
mount -t tmpfs tmpfs /run/systemd && mount -t tmpfs tmpfs /home || exit 1
export LOG=$STUB/log STATE=running
# shellcheck disable=SC2016 # expanded by the stand-ins
printf '#!/bin/bash\necho "systemctl $*" >>"$LOG"\n[[ $1 == is-system-running ]] && echo "$STATE"\nexit "${SYSTEMCTL_EXIT:-0}"\n' >"$STUB/systemctl"
printf '#!/bin/bash\necho "resolvectl $*" >>"$LOG"\n' >"$STUB/resolvectl"
printf '#!/bin/bash\nwhile [[ $1 != -- ]]; do shift; done\nshift\nexec "$@"\n' >"$STUB/setpriv" # no other user here
chmod 755 "$STUB"/*
export PATH=$STUB:$PATH
M=/home/$REAL_USER/.config/mihomo
D=/run/systemd/resolved.conf.d/50-vpn-guard.conf
mkdir -p "$M"
reloads() { grep -c 'try-reload-or-restart systemd-resolved' "$LOG" 2>/dev/null; }

printf '160.79.104.0/23\n' >"$M/vpn-addresses.txt"
printf 'anthropic.com\nclaude.ai\n' >"$M/vpn-domains.txt"
"$G" start "$REAL_USER"
check "start: addresses and domains" 0 $?
check "the drop-in for the domains" "Domains=~anthropic.com ~claude.ai" "$(grep Domains "$D")"
check "resolved reloaded, its cache dropped" "1 1" "$(reloads) $(grep -c flush-caches "$LOG")"
check "the DNS server's port held past the VPN" 1 "$(python3 -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try: s.sendto(b"x", ("9.9.9.9", 9953))
except PermissionError: exit(1)' 2>/dev/null; echo $?)"
check "its other ports free (it may be the network's own DNS)" 28 "$(conn 9.9.9.9)"
check "and the address" 7 "$(conn 160.79.104.10)"
"$G" start "$REAL_USER"
check "the same lists again: resolved reloaded again (a failed reload left it behind)" 2 "$(reloads)"

SYSTEMCTL_EXIT=1 "$G" start "$REAL_USER" 2>/dev/null
check "a failed reload of resolved fails the start" 1 $?

head -c 70000 /dev/zero | tr '\0' 'a' >"$M/vpn-domains.txt"
"$G" start "$REAL_USER" 2>/dev/null
check "a list over 64 KB fails the start" 1 $?
check "and leaves the table" 7 "$(conn 160.79.104.10)"

rm "$M/vpn-domains.txt"
"$G" start "$REAL_USER"
check "no domains file: an empty list, the drop-in removed" "0 no" "$? $([[ -e $D ]] && echo yes || echo no)"
check "the DNS server free again" 28 "$(conn 9.9.9.9)"

printf 'anthropic.com\n' >"$M/vpn-domains.txt"
"$G" start "$REAL_USER"
before=$(reloads)
STATE=stopping "$G" stop
check "stop while shutting down: drop-in and table gone, no reload" "no 1 $before" \
  "$([[ -e $D ]] && echo yes || echo no) $(nft list table inet vpn_guard >/dev/null 2>&1; echo $?) $(reloads)"
"$G" start "$REAL_USER" && "$G" stop
check "stop: resolved reloaded without the drop-in" "no $((before + 2))" "$([[ -e $D ]] && echo yes || echo no) $(reloads)"

exit $failed
