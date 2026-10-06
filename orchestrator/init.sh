#!/usr/bin/env bash
# Locks the network down to the internet, then hands over to the agent without any capabilities.
set -euo pipefail

subnet=$(ip -4 route | awk '/dev eth0 proto kernel/ {print $1; exit}')
gateway=$(ip -4 route | awk '/^default/ {print $3; exit}')
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$gateway" -j REJECT          # the host itself
iptables -A OUTPUT -d "$subnet" -j ACCEPT           # db and api of this run
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A OUTPUT -d "$net" -j REJECT             # home network, tailnet, other containers
done

exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --bounding-set=-all \
  env HOME=/home/agent "$@"
