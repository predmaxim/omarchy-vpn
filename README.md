# VPN (mihomo) for Omarchy

An Omarchy shell plugin that runs your VPN through [mihomo](https://github.com/MetaCubeX/mihomo) in TUN mode: the whole machine's traffic goes through mihomo, and mihomo decides per rule what goes through the VPN and what goes direct. No app needs a proxy setting.

- **On/off** — the icon's middle click, the menu, or the modal.
- **Subscriptions** — add a subscription URL or proxy links (`hy2://`, `vless://`, `trojan://`, … — whatever mihomo parses) from the clipboard or from a QR code on screen. Pick the active subscription by hand; inside it mihomo keeps the fastest server (`url-test`) and switches when one dies.
- **Rules** — a country whose sites go direct (Russia, or none), ad blocking, and your own "always through VPN" / "always direct" domain lists (subdomains included). Private networks (LAN, corporate VPNs, Tailscale) always go direct.

No logs, server picker or other settings in the UI on purpose.

## Install

Requirements: `mihomo-bin` (AUR), `slurp`, `grim`, `zbar`, `wl-clipboard`, `curl` ≥ 8.3, `libnotify`.

```bash
git clone https://github.com/predmaxim/omarchy-vpn.git ~/.config/omarchy/plugins/predmaxim.vpn
yay -S mihomo-bin
sudo install -Dm644 ~/.config/omarchy/plugins/predmaxim.vpn/systemd/override.conf \
  /etc/systemd/system/mihomo@.service.d/override.conf
omarchy bar put predmaxim.vpn      # the widget creates ~/.config/mihomo on first load
sudo systemctl daemon-reload && sudo systemctl enable --now mihomo@$USER
```

`override.conf` makes the packaged `mihomo@.service` run as you on `~/.config/mihomo` with only the network capabilities TUN needs (the packaged unit runs as root on `/etc/mihomo` with far more), and restarts it forever if it exits.

## How it works

- `~/.config/mihomo/state.json` — your subscriptions, the active one, on/off, rules and the API secret. The widget builds `config.yaml` (and `links/*.txt` for plain links) from it. Everything there is `0600` and holds subscription keys: keep it out of git.
- The widget talks to mihomo's REST API on `127.0.0.1:9097`. On/off is a config reload, not a runtime TUN toggle: toggling TUN at runtime leaves Hysteria2's QUIC socket unbound to the uplink, and its packets loop into the tunnel.
- TUN uses the `gvisor` stack: with `system`/`mixed`, connections hung on a machine with `rp_filter=1`.
- Retries: a dead current server re-tests its group, an empty subscription re-downloads — after 5 s, 15 s, 60 s, then every 5 minutes. The icon turns red when the service is down, a subscription has no servers or none answers.

## IPC

```bash
omarchy-shell predmaxim.vpn toggle            # the settings modal (open / close too)
omarchy-shell predmaxim.vpn-ctl power         # VPN on/off
omarchy-shell predmaxim.vpn-ctl use <id>      # active subscription (ids in state.json)
omarchy-shell predmaxim.vpn-ctl add '<text>'  # add a subscription URL or links
```

## Tests

```bash
node test.js
```
