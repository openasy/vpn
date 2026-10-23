#!/bin/bash
# End-to-end: a real OpenVPN client connects through vpn-server, configured by vpn.
# Needs Docker with /dev/net/tun and the vpn:dev and vpn-server:dev images. Exits non-zero on failure.
set -u
D=$(mktemp -d)
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
A="Authorization: Bearer admin-e2e"
api() { curl -s -H "$A" -H "content-type: application/json" "$@"; }
jsonq() { node -pe "const d=JSON.parse(require('fs').readFileSync(0)); $1"; }
cleanup() { docker rm -f e2e-vpn e2e-udp e2e-tcp e2e-target e2e-client >/dev/null 2>&1; docker network rm e2e-pub e2e-int >/dev/null 2>&1; }
cleanup
docker network create e2e-pub >/dev/null
docker network create --subnet 172.30.20.0/24 e2e-int >/dev/null
# One internal host with two services: the IP group allows port 80 only.
docker run -d --name e2e-target --network e2e-int --ip 172.30.20.10 vpn-server:dev node -e "
  const h = require('http');
  h.createServer((q, s) => s.end('hello from the internal network')).listen(80);
  h.createServer((q, s) => s.end('port 8081 should be blocked')).listen(8081);" >/dev/null
openssl rand -hex 32 > "$D/kek"
docker run -d --name e2e-vpn --network e2e-pub -p 18090:8080 -v "$D/kek:/run/secrets/openasy-kek:ro" -e VPN_ADMIN_TOKEN=admin-e2e vpn:dev >/dev/null
# Each server is added with its own address, as at two locations, and enrols with its own one-time token (ADR 0032).
agent() { # name proto port address
  local token
  token=$(api -X POST localhost:18090/api/v1/servers -d "{\"id\":\"$1\",\"address\":\"$4\"}" | jsonq d.enrollToken)
  [ -n "$token" ] || fail "$1 was not added"
  docker run -d --name "$1" --network e2e-pub --network-alias "$4" --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
    -e VPN_URL=http://e2e-vpn:8080 -e VPN_ENROLL_TOKEN="$token" -e OPENVPN_PROTO="$2" -e OPENVPN_PORT="$3" -e HEARTBEAT_SECONDS=2 vpn-server:dev >/dev/null
  docker network connect e2e-int "$1"
}
for _ in $(seq 1 30); do curl -sf localhost:18090/readyz >/dev/null && break; sleep 0.5; done
agent e2e-udp udp 1194 vpn.test
agent e2e-tcp tcp 443 vpn-tcp.test
# Client configs list the servers that have reported, so wait for both before issuing the device.
for _ in $(seq 1 30); do
  [ "$(api localhost:18090/api/v1/servers | jsonq 'd.servers.filter(s=>s.status==="online").length')" = 2 ] && break; sleep 1
done

api -X POST localhost:18090/api/v1/groups -d '{"name":"Backend engineers"}' >/dev/null
api -X POST localhost:18090/api/v1/ip-groups -d '{"name":"Internal","networks":[{"cidr":"172.30.20.0/24","ports":"tcp/80"}],"allowedGroups":["Backend engineers"]}' >/dev/null
PERSON=$(api -X POST localhost:18090/api/v1/people -d '{"name":"Dana Kim","email":"dana@example.com","groups":["Backend engineers"]}' | jsonq d.id)
[ -n "$PERSON" ] || fail "the person was not added"
# The device is issued with the command line tool in the image, as an operator would (ADR 0014).
cli() { docker run --rm --network e2e-pub -e VPN_URL=http://e2e-vpn:8080 -e VPN_API_TOKEN=admin-e2e vpn:dev cli/openasy-vpn.ts "$@"; }
cli devices add dana@example.com Laptop --out - > "$D/client.ovpn" || fail "the command line tool did not issue the device"
DEVICE=$(cli devices dana@example.com --json | jsonq 'd.devices[0].id')
cli people | grep -q "Dana Kim" || fail "the command line tool does not list Dana Kim"
grep -v '^remote ' "$D/client.ovpn" | sed "s#^nobind#nobind\nremote vpn-tcp.test 443 tcp-client#" > "$D/client-tcp.ovpn"
echo "remotes in client.ovpn: $(grep '^remote ' "$D/client.ovpn" | tr '\n' ';')"
[ "$(grep '^remote ' "$D/client.ovpn" | tr '\n' ';')" = "remote vpn.test 1194 udp;remote vpn-tcp.test 443 tcp-client;" ] || fail "client.ovpn does not list each server at its address"

# Wait until both agents applied the latest config, the one that contains the device. Each asks with its own secret.
secret() { docker exec "$1" node -pe "JSON.parse(require('fs').readFileSync('/var/lib/openasy-vpn/server.json')).secret"; }
latest() { curl -s -H "Authorization: Bearer $(secret "$1")" "localhost:18090/api/v1/servers/$1/config" | jsonq d.version; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(secret e2e-tcp)" localhost:18090/api/v1/servers/e2e-udp/config)" = 403 ] || fail "one server's secret fetched another server's config"
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
echo "[UDP] session in vpn: $(sessions)"
[ "$(sessions)" = "e2e-udp:Dana Kim" ] || fail "the session was not listed"

echo "--- disconnect the session from vpn: the device is still allowed, so it reconnects"
api -X DELETE "localhost:18090/api/v1/sessions/e2e-udp/$DEVICE" >/dev/null
for _ in $(seq 1 20); do [ "$(completed)" -ge 2 ] && break; sleep 1; done
echo "[UDP] connections completed: $(completed)"
[ "$(completed)" -ge 2 ] || fail "the disconnected client did not reconnect"
docker logs e2e-udp 2>&1 | grep -q '"reason":"disconnected from vpn"' || fail "the server did not report ending the session"

echo "--- connect over TCP 443"
client client-tcp.ovpn TCP || fail "TCP client did not connect"
out=$(get http://172.30.20.10)
echo "[TCP] tcp/80: $out"
[ "$out" = "hello from the internal network" ] || fail "TCP client could not reach the internal network"

echo "--- the UDP server goes down: the same client.ovpn connects to the next server"
docker stop e2e-udp >/dev/null
client client.ovpn failover || fail "the client did not move to the TCP server"
# The stopped server's last report stays listed until it is 60 seconds old; the new session must be there too.
for _ in $(seq 1 10); do [[ ",$(sessions)," == *",e2e-tcp:Dana Kim,"* ]] && break; sleep 1; done
echo "[failover] sessions in vpn: $(sessions)"
[[ ",$(sessions)," == *",e2e-tcp:Dana Kim,"* ]] || fail "the session was not listed on the TCP server"
docker start e2e-udp >/dev/null
for _ in $(seq 1 30); do [ "$(api localhost:18090/api/v1/servers | jsonq 'd.servers.find(s=>s.id==="e2e-udp").status')" = online ] && break; sleep 1; done

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
[ -z "$(sessions)" ] || fail "vpn still lists the revoked device's session"

[ "${KEEP:-}" = "1" ] || cleanup
rm -rf "$D"
[ "$FAIL" = 0 ] && echo "e2e: all checks passed"
exit $FAIL
