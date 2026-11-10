#!/bin/bash

# Checks the installed vpn-guard against the network, with the VPN on: sudo guard/check.sh
# Prints PASS or FAIL per check; the exit code is the number of failures.

set -uo pipefail

U=${SUDO_USER:?run with sudo}
UNIT=vpn-guard@$U
if ! systemctl is-active -q "$UNIT"; then
  echo "$UNIT is not active: install and start it first (README, Install)" >&2
  exit 1
fi
IF=$(ip route show table main default | awk '{print $5; exit}')

D=$(mktemp -d)
chmod 755 "$D"
# The test names leave the map with the reload: it reads the user's list again.
trap 'rm -rf "$D"; systemctl reload "$UNIT"' EXIT
cp /usr/bin/curl "$D/vgc-curl"
cp /usr/bin/curl "$D/vgc-free"
cat >"$D/vgc-launch" <<EOF
#!/bin/sh
# a listed launcher: waits \$1 seconds, then runs an unlisted curl two levels down (sh -c, a setsid fork)
sleep "\$1"
shift
sh -c 'setsid -w "\$0" "\$@"' "$D/vgc-free" "\$@"
EOF
chmod 755 "$D"/vgc-*
for n in vgc-curl vgc-launch; do
  read -ra k <<<"$({ printf '%s' "$n"; head -c 64 /dev/zero; } | head -c 64 | od -An -v -tx1 -w64)"
  bpftool map update pinned /sys/fs/bpf/vpn-guard/maps/apps key hex "${k[@]}" value hex 01 || exit 1
done

failed=0
run() { # run <program> [args...]: as the user, the exit code of curl
  setpriv --reuid="$U" --regid="$(id -g "$U")" --init-groups --inh-caps=-all -- \
    "$D/$1" "${@:2}" -s -m 10 -o /dev/null https://ifconfig.me/ip
}
check() { # check <pass|block> <what> <exit code>
  if [[ $1 == pass && $3 == 0 || $1 == block && $3 != 0 ]]; then
    echo "PASS  $2"
  else
    echo "FAIL  $2 (curl exit $3)"
    ((++failed))
  fi
}

run vgc-curl
check pass "listed program through Meta" $?
run vgc-curl --interface "$IF"
check block "listed program through $IF" $?
run vgc-free --interface "$IF"
check pass "unlisted program through $IF" $?
run vgc-launch 0 --interface "$IF"
check block "unlisted program started by a listed script, through $IF" $?

run vgc-launch 3 --interface "$IF" &
pid=$!
# reload only once the launcher has run: its tag is set at exec
for _ in {1..50}; do
  pgrep -xu "$U" vgc-launch >/dev/null && break
  sleep 0.1
done
systemctl reload "$UNIT"
wait $pid
check block "the tag of a running launcher survives a reload" $?
run vgc-curl --interface "$IF"
check pass "a name gone from the list after a reload is free again" $?

exit $failed
