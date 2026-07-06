#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh — Selects and starts the right nginx config based on USE_SSL.
# Called by the nginx container's entrypoint.
# ─────────────────────────────────────────────────────────────────────────────
set -e

NGINX_CONF="/etc/nginx/nginx.conf"
TEMPLATE_HTTP="/etc/nginx/nginx.conf.http"
TEMPLATE_HTTPS="/etc/nginx/nginx.conf.https"

if [[ "${USE_SSL}" == "true" ]]; then
    echo "[setup] USE_SSL=true — generating HTTPS nginx config"

    CERT="/etc/nginx/ssl/cert.pem"
    KEY="/etc/nginx/ssl/key.pem"

    if [[ ! -f "${CERT}" || ! -f "${KEY}" ]]; then
        echo "[setup] ERROR: SSL certificate files not found inside container:"
        echo "[setup]   ${CERT}"
        echo "[setup]   ${KEY}"
        echo "[setup] Set SSL_CERT_PATH and SSL_KEY_PATH in .env to host paths"
        exit 1
    fi

    echo "[setup] SSL certs OK"
    envsubst < "${TEMPLATE_HTTPS}" > "${NGINX_CONF}"
else
    echo "[setup] USE_SSL=false — generating HTTP-only nginx config"
    envsubst < "${TEMPLATE_HTTP}" > "${NGINX_CONF}"
fi

echo "[setup] Starting nginx..."
exec nginx -g 'daemon off;'