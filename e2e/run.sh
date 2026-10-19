#!/bin/bash
# End-to-end: a real OpenVPN client connects through vpn-server, configured by vpn-manager.
set -u
# Needs Docker with /dev/net/tun and the vpn-manager:dev and vpn-server:dev images. Exits non-zero on failure.
D=$(mktemp -d)
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
A="Authorization: Bearer admin-e2e"
api() { curl -s -H "$A" -H "content-type: application/json" "$@"; }
cleanup() { docker rm -f e2e-manager e2e-udp e2e-tcp e2e-target e2e-client >/dev/null 2>&1; docker network rm e2e-pub e2e-int >/dev/null 2>&1; }
cleanup
docker network create e2e-pub >/dev/null
docker network create --subnet 172.30.20.0/24 e2e-int >/dev/null
docker run -d --name e2e-target --network e2e-int --ip 172.30.20.10 vpn-server:dev node -e "require('http').createServer((q,s)=>s.end('hello from the internal network')).listen(80)" >/dev/null
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
PERSON=$(api -X POST localhost:18090/api/v1/people -d '{"name":"Dana Kim","email":"dana@example.com","groups":["Backend engineers"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
api -X POST "localhost:18090/api/v1/people/$PERSON/devices" -d '{"name":"Laptop"}' > "$D/device.json"
node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).ovpn' "$D/device.json" > "$D/client.ovpn"
DEVICE=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).device.id' "$D/device.json")
echo "remotes in client.ovpn:"; grep '^remote ' "$D/client.ovpn"

# Wait until both agents applied the latest config, the one that contains the device.
latest() { curl -s -H "Authorization: Bearer server-e2e" "localhost:18090/api/v1/servers/$1/config" | node -pe 'JSON.parse(require("fs").readFileSync(0)).version'; }
for _ in $(seq 1 30); do
  want="$(latest e2e-udp) $(latest e2e-tcp)"
  have=$(api localhost:18090/api/v1/servers | node -pe 'const s=JSON.parse(require("fs").readFileSync(0)).servers; ["e2e-udp","e2e-tcp"].map(i=>s.find(x=>x.id===i)?.configVersion).join(" ")')
  [ "$want" = "$have" ] && break; sleep 1
done
echo "servers:"; api localhost:18090/api/v1/servers | node -pe 'JSON.parse(require("fs").readFileSync(0)).servers.map(s=>`${s.id} ${s.listen} running=${s.openvpnRunning} config=${s.configVersion}`).join("\n")'

client() { # config label
  CONNECTED=0
  docker rm -f e2e-client >/dev/null 2>&1
  docker run -d --name e2e-client --network e2e-pub --cap-add NET_ADMIN --device /dev/net/tun -v "$D:/c:ro" vpn-server:dev \
    openvpn --config "/c/$1" --server-poll-timeout 4 --connect-retry-max 2 >/dev/null
  for _ in $(seq 1 25); do docker logs e2e-client 2>&1 | grep -q "Initialization Sequence Completed" && break; sleep 1; done
  if docker logs e2e-client 2>&1 | grep -q "Initialization Sequence Completed"; then
    echo "[$2] connected: $(docker logs e2e-client 2>&1 | grep -oE 'net_addr_v4_add: [0-9./]+' | head -1)"
    echo "[$2] routes via tun0: $(docker exec e2e-client node -e "const r=require('fs').readFileSync('/proc/net/route','utf8').split('\\n').slice(1).filter(l=>l.startsWith('tun0'));const ip=h=>h.match(/../g).reverse().map(x=>parseInt(x,16)).join('.');console.log(r.map(l=>{const f=l.split(/\\s+/);return ip(f[1])+'/'+ip(f[7])}).join(', '))")"
    out=$(docker exec e2e-client node -e "fetch('http://172.30.20.10',{signal:AbortSignal.timeout(4000)}).then(r=>r.text()).then(console.log,e=>console.log('FAILED',e.cause?.code??e.message))")
    echo "[$2] internal service: $out"
    [ "$out" = "hello from the internal network" ] || fail "[$2] could not reach the internal network"
    CONNECTED=1
  else
    echo "[$2] not connected: $(docker logs e2e-client 2>&1 | grep -E 'VERIFY|TLS Error|AUTH|refused|exiting|CRL|client-config-dir' | tail -2 | tr '\n' ' ')"
  fi
}
client client.ovpn UDP
[ "$CONNECTED" = 1 ] || fail "UDP client did not connect"
grep -v '^remote ' "$D/client.ovpn" | sed "s#^nobind#nobind\nremote vpn-tcp.test 443 tcp-client#" > "$D/client-tcp.ovpn"
client client-tcp.ovpn TCP
[ "$CONNECTED" = 1 ] || fail "TCP client did not connect"

echo "--- revoke the device"
api -X DELETE "localhost:18090/api/v1/devices/$DEVICE" >/dev/null
sleep 5
client client.ovpn "UDP after revoke"
[ "$CONNECTED" = 0 ] || fail "a revoked device connected"
docker logs e2e-udp 2>&1 | grep -q "certificate revoked" || fail "the server did not refuse the revoked certificate"
[ "${KEEP:-}" = "1" ] || cleanup
rm -rf "$D"
[ "$FAIL" = 0 ] && echo "e2e: all checks passed"
exit $FAIL
