#!/usr/bin/env bash
# Install or upgrade Net Logger Plus on Debian 13 (Trixie) as a systemd service, optionally behind Caddy.
#
#   sudo bash deploy/install-debian.sh --domain nets.example.org --caddy     # domain: trusted HTTPS
#   sudo bash deploy/install-debian.sh --ip 203.0.113.10 --caddy             # IP address only
#   sudo bash deploy/install-debian.sh --ip auto --tls none --caddy          # IP only, plain HTTP
#
# Address (needed on the first install; later runs may omit it and keep the current one):
#   --domain NAME   DNS name pointing at this server. Gets a trusted HTTPS certificate automatically.
#   --ip ADDRESS    IPv4 or IPv6 address people will use, or "auto" to detect this server's address.
#
# With --ip, --tls chooses how browsers connect:
#   internal      (default) HTTPS with a certificate Caddy signs itself. Encrypted, but browsers warn
#                 until the Caddy root certificate is trusted on each device.
#   letsencrypt   Trusted HTTPS from a short-lived Let's Encrypt IP-address certificate. Needs a public
#                 IP, port 80 open, and a recent Caddy. Falls back to "internal" if issuance fails.
#   none          Plain HTTP. Sign-in links and sessions are NOT encrypted. Trusted networks only.
#
# Other:
#   --caddy         Also install Caddy and write /etc/caddy/Caddyfile (an existing one is backed up).
#   -h, --help      Show this help.
#
# First run : installs Node.js if needed, copies the app to /opt/net-logger-plus, writes /etc/net-logger-plus/net-logger-plus.env
#             with a fresh random SESSION_SECRET, and starts the service.
# Re-run    : updates the code and restarts. Settings and data are kept; passing a different
#             --domain/--ip updates BASE_URL (and the Caddyfile with --caddy).
set -euo pipefail

DESTDIR="${DESTDIR:-}"   # testing only: install into a scratch directory, skip apt/systemctl/caddy
APP_DIR="$DESTDIR/opt/net-logger-plus"
ENV_DIR="$DESTDIR/etc/net-logger-plus"
ENV_FILE="$ENV_DIR/net-logger-plus.env"
UNIT="$DESTDIR/etc/systemd/system/net-logger-plus.service"
CADDYFILE="$DESTDIR/etc/caddy/Caddyfile"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

DOMAIN=""; IP_ARG=""; TLS=""; WRITE_CADDY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || die "--domain needs a value"; DOMAIN="$2"; shift 2 ;;
    --ip)     [ $# -ge 2 ] || die "--ip needs a value (an address, or auto)"; IP_ARG="$2"; shift 2 ;;
    --tls)    [ $# -ge 2 ] || die "--tls needs a value (internal, letsencrypt or none)"; TLS="$2"; shift 2 ;;
    --caddy)  WRITE_CADDY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done

# --- checks that need nothing installed ---
[ -n "$DESTDIR" ] || [ "$(id -u)" -eq 0 ] || die "run as root (use sudo)"
[ -z "$DOMAIN" ] || [ -z "$IP_ARG" ] || die "use either --domain or --ip, not both"
[ -z "$TLS" ] || [ -n "$IP_ARG" ] || die "--tls only applies with --ip (a domain always gets HTTPS)"
case "${TLS:-internal}" in internal|letsencrypt|none) ;; *) die "--tls must be internal, letsencrypt or none" ;; esac
TLS="${TLS:-internal}"
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
  die "\"$DOMAIN\" does not look like a lowercase domain name (to use an IP address, pass --ip)"
fi
[ -d "$SRC/src" ] && [ -d "$SRC/public" ] || die "run this from a Net Logger Plus checkout (src/ and public/ not found)"

# Node.js 20.19 is the oldest we support: it is what Debian 13 ships, and the MongoDB driver 7 needs it.
# (Node 20 itself passed its upstream end of life in April 2026, so 22 or 24 is better; see the note below.)
# NET_LOGGER_PLUS_TEST_NODE_VERSION lets the tests pretend to be another version, and only works together with DESTDIR.
current_node_version() {
  if [ -n "$DESTDIR" ] && [ -n "${NET_LOGGER_PLUS_TEST_NODE_VERSION:-}" ]; then echo "$NET_LOGGER_PLUS_TEST_NODE_VERSION"
  elif command -v node >/dev/null 2>&1; then node -p 'process.versions.node'
  else return 1; fi
}
node_ok() {
  local v maj min
  v="$(current_node_version)" || return 1
  IFS=. read -r maj min _ <<<"$v"
  [ "$maj" -gt 20 ] || { [ "$maj" -eq 20 ] && [ "${min:-0}" -ge 19 ]; }
}
if ! node_ok; then
  [ -z "$DESTDIR" ] || die "Node.js 20.19 or newer is required"
  echo "Installing Node.js from Debian (npm is not needed to run Net Logger Plus)..."
  apt-get update -qq && apt-get install -y nodejs
  node_ok || die "Node.js 20.19 or newer is required; this machine's package is too old. Install a current Node.js (https://nodejs.org/en/download) and re-run."
fi
echo "Using Node.js $(current_node_version)"
case "$(current_node_version)" in
  20.*) echo "note: Node.js 20 passed its upstream end of life in April 2026. Net Logger Plus works on it, but Node.js 24 (the current long-term-support release) is recommended: install it from https://nodejs.org/en/download and re-run this script." >&2 ;;
esac

# --- work out the address people will use (needs node for IPv6-safe validation) ---
ip_family() { node -e 'process.stdout.write(String(require("net").isIP(process.argv[1])))' -- "$1"; }
is_private() {
  local a="${1,,}"
  [[ "$a" =~ ^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]] ||
    [[ "$a" =~ ^(f[cd][0-9a-f]{2}:|fe80:|::1$) ]]
}

KIND=""; SITE_HOST=""; URL=""
if [ -n "$DOMAIN" ]; then
  KIND=domain; SITE_HOST="$DOMAIN"; URL="https://$DOMAIN"
elif [ -n "$IP_ARG" ]; then
  KIND=ip
  ADDR="$IP_ARG"
  if [ "$ADDR" = auto ]; then
    command -v ip >/dev/null 2>&1 || die "cannot auto-detect without the 'ip' command; pass the address explicitly"
    ADDR="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -n "$ADDR" ] || die "could not detect this server's address; pass --ip ADDRESS"
    echo "Detected this server's address: $ADDR"
  fi
  ADDR="${ADDR,,}"
  FAMILY="$(ip_family "$ADDR")"
  [ "$FAMILY" != 0 ] || die "\"$IP_ARG\" is not a valid IPv4 or IPv6 address"
  if is_private "$ADDR"; then
    [ "$TLS" != letsencrypt ] || die "$ADDR is a private address; Let's Encrypt can only issue certificates for public IPs (use --tls internal or none)"
    echo "note: $ADDR looks like a private/local address. People outside your network cannot reach it." >&2
    echo "      Some clouds NAT a public IP onto a private one; if so, pass the public address with --ip." >&2
  fi
  SITE_HOST="$ADDR"; [ "$FAMILY" = 6 ] && SITE_HOST="[$ADDR]"
  if [ "$TLS" = none ]; then URL="http://$SITE_HOST"; else URL="https://$SITE_HOST"; fi
fi
[ "$WRITE_CADDY" -eq 0 ] || [ -n "$KIND" ] || die "--caddy needs --domain or --ip"

# --- code ---
install -d -m 0755 "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -r "$SRC/src" "$SRC/public" "$APP_DIR/"
install -m 0644 "$SRC/package.json" "$APP_DIR/package.json"
[ -n "$DESTDIR" ] || chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# --- settings (created once; only BASE_URL follows --domain/--ip) ---
install -d -m 0750 "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  echo "Keeping existing $ENV_FILE"
  if [ -n "$URL" ]; then
    current="$(grep '^BASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
    if [ "$current" != "$URL" ]; then
      if grep -q '^BASE_URL=' "$ENV_FILE"; then sed -i "s|^BASE_URL=.*|BASE_URL=$URL|" "$ENV_FILE"; else echo "BASE_URL=$URL" >> "$ENV_FILE"; fi
      echo "Updated BASE_URL: ${current:-"(unset)"} -> $URL"
    fi
  fi
else
  [ -n "$URL" ] || die "first install needs --domain your.domain.example, or --ip ADDRESS"
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -e "s|^BASE_URL=.*|BASE_URL=$URL|" \
      -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$secret|" \
      "$SRC/deploy/net-logger-plus.env.example" > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (BASE_URL=$URL, new SESSION_SECRET generated)"
fi

# --- service ---
install -D -m 0644 "$SRC/deploy/net-logger-plus.service" "$UNIT"
if [ -z "$DESTDIR" ]; then
  systemctl daemon-reload
  systemctl enable net-logger-plus >/dev/null 2>&1
  systemctl restart net-logger-plus
fi

# --- Caddy (optional) ---
render_caddy() { # $1 = site address line, $2 = tls block (may be empty)
  SITE="$1" TLS_BLOCK="$2" awk '
    /^nets\.example\.org \{$/ { print ENVIRON["SITE"] " {"; next }
    /__TLS__/ { if (ENVIRON["TLS_BLOCK"] != "") print ENVIRON["TLS_BLOCK"]; next }
    { print }' "$SRC/deploy/Caddyfile"
}
if [ "$WRITE_CADDY" -eq 1 ]; then
  site="$SITE_HOST"; tls_block=""
  if [ "$KIND" = ip ]; then
    case "$TLS" in
      internal)    tls_block=$'\ttls internal' ;;
      letsencrypt) tls_block=$'\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t\tissuer internal\n\t}' ;;
      none)        site="http://$SITE_HOST" ;;
    esac
  fi

  if [ -z "$DESTDIR" ] && ! command -v caddy >/dev/null 2>&1; then
    echo "Installing Caddy from Debian..."
    apt-get install -y caddy
  fi
  tmp="$(mktemp)"; trap 'rm -f "$tmp" "$tmp.err"' EXIT
  render_caddy "$site" "$tls_block" > "$tmp"
  if [ -z "$DESTDIR" ]; then
    # Never replace a working Caddyfile with one this Caddy cannot load.
    if ! caddy validate --config "$tmp" --adapter caddyfile >/dev/null 2>"$tmp.err"; then
      cat "$tmp.err" >&2
      [ "$TLS" != letsencrypt ] || echo "Hint: Let's Encrypt IP certificates need a recent Caddy. Install it from Caddy's own apt repository, or use --tls internal." >&2
      die "Caddy rejected the generated configuration (above). Your Caddyfile was not changed."
    fi
  fi
  install -d -m 0755 "$(dirname "$CADDYFILE")"
  if [ -f "$CADDYFILE" ]; then
    cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
    echo "Backed up the existing Caddyfile next to it (.bak.*)"
  fi
  install -m 0644 "$tmp" "$CADDYFILE"
  [ -n "$DESTDIR" ] || { systemctl enable caddy >/dev/null 2>&1 || true; systemctl reload-or-restart caddy; }
fi

# --- check ---
if [ -z "$DESTDIR" ]; then
  sleep 2
  if node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/api/me").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; then
    echo "Net Logger Plus is running."
  else
    echo "Net Logger Plus did not answer. See: journalctl -u net-logger-plus -n 50 --no-pager" >&2
    exit 1
  fi
fi

# --- what to do next ---
echo
echo "Next steps"
n=1
step() { echo "  $n. $*"; n=$((n+1)); }
case "$KIND:$TLS" in
  domain:*)
    step "Point a DNS A/AAAA record for $DOMAIN at this server and open ports 80 and 443." ;;
  ip:internal)
    step "Open ports 80 and 443. Browse to $URL"
    step "Browsers will warn that the certificate is not trusted (it is signed by this server's own Caddy)."
    step "To remove the warning, install the file /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt as a trusted root on each device that will use Net Logger Plus." ;;
  ip:letsencrypt)
    step "Open ports 80 and 443 to the internet (Let's Encrypt must reach port 80). Browse to $URL"
    step "If issuance fails, Caddy falls back to a self-signed certificate (browser warning); see: sudo journalctl -u caddy -n 50" ;;
  ip:none)
    step "Open port 80. Browse to $URL"
    echo "  WARNING: plain HTTP. Sign-in links and session cookies are NOT encrypted; anyone on the network path can take over accounts. Use only on a trusted network, or re-run with --tls internal." ;;
esac
[ "$WRITE_CADDY" -eq 1 ] || step "Net Logger Plus listens on 127.0.0.1:3000 only. Put a reverse proxy in front (re-run with --caddy to set up Caddy)."
step "Edit $ENV_FILE to add a mail relay (MAIL_WEBHOOK_URL) and, if you use it, QRZ credentials. Then: sudo systemctl restart net-logger-plus"
step "Until a mail relay is set, sign-in links appear in the log:  sudo journalctl -u net-logger-plus -f"
step "Data lives in /var/lib/net-logger-plus/db.json (back it up). Logs: journalctl -u net-logger-plus"
