#!/bin/bash
# End-to-end: a real OpenVPN client connects through vpn-server, configured by vpn-manager.
# Needs Docker with /dev/net/tun and the vpn-manager:dev and vpn-server:dev images. Exits non-zero on failure.
set -u
D=$(mktemp -d)
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
A="Authorization: Bearer admin-e2e"
api() { curl -s -H "$A" -H "content-type: application/json" "$@"; }
jsonq() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }
cleanup() { docker rm -f e2e-manager e2e-udp e2e-tcp e2e-target e2e-client >/dev/null 2>&1; docker network rm e2e-pub e2e-int >/dev/null 2>&1; }
cleanup
docker network create e2e-pub >/dev/null
docker network create --subnet 172.30.20.0/24 e2e-int >/dev/null
# One internal host with two services: the IP group allows port 80 only.
docker run -d --name e2e-target --network e2e-int --ip 172.30.20.10 vpn-server:dev node -e "
  const h = require('http');
  h.createServer((q, s) => s.end('hello from the internal network')).listen(80);
  h.createServer((q, s) => s.end('port 8081 should be blocked')).listen(8081);" >/dev/null
docker run -d --name e2e-manager --network e2e-pub -p 18090:8080 -e VPN_SERVER_TOKEN=server-e2e -e VPN_ADMIN_TOKEN=admin-e2e -e VPN_PUBLIC_HOST=vpn.test vpn-manager:dev >/dev/null
agent() { # name proto port alias
  docker run -d --name "$1" --network e2e-pub --network-alias "$4" --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
    -e VPN_MANAGER_URL=http://e2e-manager:8080 -e VPN_SERVER_TOKEN=server-e2e -e VPN_SERVER_ID="$1" -e OPENVPN_PROTO="$2" -e OPENVPN_PORT="$3" -e HEARTBEAT_SECONDS=2 vpn-server:dev >/dev/null
  docker network connect e2e-int "$1"
}
for _ in $(seq 1 30); do curl -sf localhost:18090/readyz >/dev/null && break; sleep 0.5; done
agent e2e-udp udp 1194 vpn.test
agent e2e-tcp tcp 443 vpn-tcp.test

api -X POST localhost:18090/api/v1/groups -d '{"name":"Backend engineers"}' >/dev/null
api -X POST localhost:18090/api/v1/ip-groups -d '{"name":"Internal","networks":[{"cidr":"172.30.20.0/24","ports":"tcp/80"}],"allowedGroups":["Backend engineers"]}' >/dev/null
PERSON=$(api -X POST localhost:18090/api/v1/people -d '{"name":"Dana Kim","email":"dana@example.com","groups":["Backend engineers"]}' | jsonq d.id)
api -X POST "localhost:18090/api/v1/people/$PERSON/devices" -d '{"name":"Laptop"}' > "$D/device.json"
jsonq d.ovpn < "$D/device.json" > "$D/client.ovpn"
DEVICE=$(jsonq d.device.id < "$D/device.json")
grep -v '^remote ' "$D/client.ovpn" | sed "s#^nobind#nobind\nremote vpn-tcp.test 443 tcp-client#" > "$D/client-tcp.ovpn"
echo "remotes in client.ovpn: $(grep '^remote ' "$D/client.ovpn" | tr '\n' ';')"

# Wait until both agents applied the latest config, the one that contains the device.
latest() { curl -s -H "Authorization: Bearer server-e2e" "localhost:18090/api/v1/servers/$1/config" | jsonq d.version; }
for _ in $(seq 1 30); do
  want="$(latest e2e-udp) $(latest e2e-tcp)"
  have=$(api localhost:18090/api/v1/servers | jsonq '["e2e-udp","e2e-tcp"].map(i=>d.servers.find(x=>x.id===i)?.configVersion).join(" ")')
  [ "$want" = "$have" ] && break; sleep 1
done

get() { docker exec e2e-client node -e "fetch('$1',{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(console.log,e=>console.log('BLOCKED',e.cause?.code??e.name))"; }
completed() { docker logs e2e-client 2>&1 | grep -c "Initialization Sequence Completed"; }
client() { # config label
  docker rm -f e2e-client >/dev/null 2>&1
  docker run -d --name e2e-client --network e2e-pub --cap-add NET_ADMIN --device /dev/net/tun -v "$D:/c:ro" vpn-server:dev \
    openvpn --config "/c/$1" --server-poll-timeout 4 --connect-retry-max 2 >/dev/null
  for _ in $(seq 1 25); do [ "$(completed)" -ge 1 ] && break; sleep 1; done
  if [ "$(completed)" -ge 1 ]; then
    echo "[$2] connected as $(docker logs e2e-client 2>&1 | grep -oE 'net_addr_v4_add: [0-9./]+' | head -1 | cut -d' ' -f2)"
    return 0
  fi
  echo "[$2] not connected: $(docker logs e2e-client 2>&1 | grep -E 'VERIFY|TLS Error|AUTH|exiting' | tail -1)"
  return 1
}
sessions() { api localhost:18090/api/v1/sessions | jsonq "d.sessions.filter(s=>s.deviceId==='$DEVICE').map(s=>s.serverId+':'+s.personName).join(',')"; }

echo "--- connect over UDP"
client client.ovpn UDP || fail "UDP client did not connect"
out=$(get http://172.30.20.10)
echo "[UDP] tcp/80, allowed: $out"
[ "$out" = "hello from the internal network" ] || fail "an allowed port was not reachable"
out=$(get http://172.30.20.10:8081)
echo "[UDP] tcp/8081, not allowed: $out"
[[ "$out" == BLOCKED* ]] || fail "a port outside the IP group was reachable"

for _ in $(seq 1 10); do [ -n "$(sessions)" ] && break; sleep 1; done
echo "[UDP] session in vpn-manager: $(sessions)"
[ "$(sessions)" = "e2e-udp:Dana Kim" ] || fail "the session was not listed"

echo "--- disconnect the session from vpn-manager: the device is still allowed, so it reconnects"
api -X DELETE "localhost:18090/api/v1/sessions/e2e-udp/$DEVICE" >/dev/null
for _ in $(seq 1 20); do [ "$(completed)" -ge 2 ] && break; sleep 1; done
echo "[UDP] connections completed: $(completed)"
[ "$(completed)" -ge 2 ] || fail "the disconnected client did not reconnect"
docker logs e2e-udp 2>&1 | grep -q '"reason":"disconnected from vpn-manager"' || fail "the server did not report ending the session"

echo "--- connect over TCP 443"
client client-tcp.ovpn TCP || fail "TCP client did not connect"
out=$(get http://172.30.20.10)
echo "[TCP] tcp/80: $out"
[ "$out" = "hello from the internal network" ] || fail "TCP client could not reach the internal network"

echo "--- revoke the device while it is connected"
client client.ovpn UDP || fail "UDP client did not connect again"
api -X DELETE "localhost:18090/api/v1/devices/$DEVICE" >/dev/null
for _ in $(seq 1 15); do docker logs e2e-udp 2>&1 | grep -q '"reason":"no longer allowed"' && break; sleep 1; done
docker logs e2e-udp 2>&1 | grep -q '"reason":"no longer allowed"' || fail "the revoked device's session was not ended"
sleep 3
out=$(get http://172.30.20.10 2>/dev/null || echo "BLOCKED client gone")
echo "[UDP] after revoke: $out"
[[ "$out" == BLOCKED* || -z "$out" ]] || fail "the revoked device still reached the internal network"
docker logs e2e-udp 2>&1 | grep -q "certificate revoked" || fail "the server did not refuse the revoked certificate on reconnect"
echo "[UDP] reconnect refused: $(docker logs e2e-udp 2>&1 | grep -c 'certificate revoked') time(s), certificate revoked"
for _ in $(seq 1 10); do [ -z "$(sessions)" ] && break; sleep 1; done
[ -z "$(sessions)" ] || fail "vpn-manager still lists the revoked device's session"

[ "${KEEP:-}" = "1" ] || cleanup
rm -rf "$D"
[ "$FAIL" = 0 ] && echo "e2e: all checks passed"
exit $FAIL
