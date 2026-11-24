#!/bin/bash

# Checks the installed vpn-guard against the network, with the VPN on: sudo guard/check.sh
# Prints PASS or FAIL per check; the exit code is the number of failures.

set -uo pipefail

U=${SUDO_USER:?run with sudo}
UNIT=vpn-guard@$U
LIST=/home/$U/.config/mihomo/vpn-addresses.txt
if ! systemctl is-active -q "$UNIT"; then
  echo "$UNIT is not active: install and start it first (README, Install)" >&2
  exit 1
fi
IF=$(ip route show table main default | awk '{print $5; exit}')

failed=0
check() { # check <pass|block> <what> <exit code>; block is curl's 7, the refusal: a timeout or a DNS failure is not
  if [[ $1 == pass && $3 == 0 || $1 == block && $3 == 7 ]]; then
    echo "PASS  $2"
  else
    echo "FAIL  $2 (curl exit $3)"
    ((++failed))
  fi
}
listed() { nft get element inet vpn_guard vpn4 "{ $1 }" >/dev/null 2>&1; }
# As the user: mihomo's PROCESS-NAME and uid rules see what the user's programs do.
get() { # get <host> <ip> [curl args...]: the exit code of curl
  setpriv --reuid="$U" --regid="$(id -g "$U")" --init-groups -- \
    curl -s -m 10 -o /dev/null --resolve "$1:443:$2" "${@:3}" "https://$1/"
}

# Every network of the list is in the table.
missing=0
while IFS= read -r c; do
  [[ $c == *:* ]] && set=vpn6 || set=vpn4
  nft get element inet vpn_guard "$set" "{ $c }" >/dev/null 2>&1 || ((++missing))
done < <(setpriv --reuid="$U" --regid="$(id -g "$U")" --init-groups -- cat "$LIST" 2>/dev/null)
if ((missing)); then
  echo "FAIL  $missing networks of your list are not in the table"
  ((++failed))
else
  echo "PASS  every network of your list is in the table"
fi

# A listed Anthropic: nothing reaches it past the VPN, through it it answers.
A=$(getent ahostsv4 api.anthropic.com | awk '{print $1; exit}')
if [[ -n $A ]] && listed "$A"; then
  get api.anthropic.com "$A" --interface "$IF"
  check block "api.anthropic.com ($A) through $IF" $?
  get api.anthropic.com "$A"
  check pass "api.anthropic.com ($A) through the VPN" $?
else
  echo "SKIP  api.anthropic.com: its address is not in your list"
fi

# The DNS of "always through VPN" domains: resolved asks the global server only, held to TUN.
D=$(setpriv --reuid="$U" --regid="$(id -g "$U")" --init-groups -- head -n1 "/home/$U/.config/mihomo/vpn-domains.txt" 2>/dev/null)
if [[ -n $D ]]; then
  if resolvectl dns | grep '^Global:' | grep -q '9\.9\.9\.9:9953'; then
    echo "PASS  resolved's global DNS is 9.9.9.9:9953"
  else
    echo "FAIL  resolved's global DNS is not 9.9.9.9:9953 (resolvectl dns)"
    ((++failed))
  fi
  resolvectl flush-caches
  if resolvectl query -4 --cache=no "$D" >/dev/null 2>&1; then
    echo "PASS  $D resolves (through the VPN)"
  else
    echo "FAIL  $D does not resolve"
    ((++failed))
  fi
  if python3 - "$IF" <<'PY'; then
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, sys.argv[1].encode())
try:
    s.sendto(b"x", ("9.9.9.9", 9953))
except PermissionError:
    sys.exit(0)
sys.exit(1)
PY
    echo "PASS  the DNS server through $IF: refused"
  else
    echo "FAIL  the DNS server through $IF: let out"
    ((++failed))
  fi
else
  echo "SKIP  DNS: no domains in ALWAYS THROUGH VPN"
fi

# A test address added for a moment: refused past the VPN, free again after a reload.
T=$(getent ahostsv4 ifconfig.me | awk '{print $1; exit}')
if listed "$T"; then
  echo "SKIP  ifconfig.me ($T) is in your list already"
else
  get ifconfig.me "$T" --interface "$IF"
  check pass "unlisted ifconfig.me ($T) through $IF" $?
  nft add element inet vpn_guard vpn4 "{ $T }"
  get ifconfig.me "$T" --interface "$IF"
  check block "ifconfig.me listed, through $IF" $?
  get ifconfig.me "$T"
  check pass "ifconfig.me listed, through the VPN" $?
  systemctl reload "$UNIT"
  get ifconfig.me "$T" --interface "$IF"
  check pass "a reload reads your list again: ifconfig.me is free" $?
fi

exit $failed
