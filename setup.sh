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

    if [[ -z "${SSL_CERT_PATH}" || -z "${SSL_KEY_PATH}" ]]; then
        echo "[setup] ERROR: USE_SSL=true but SSL_CERT_PATH / SSL_KEY_PATH are not set"
        exit 1
    fi

    if [[ ! -f "${SSL_CERT_PATH}" || ! -f "${SSL_KEY_PATH}" ]]; then
        echo "[setup] ERROR: SSL certificate files not found:"
        echo "[setup]   SSL_CERT_PATH=${SSL_CERT_PATH}"
        echo "[setup]   SSL_KEY_PATH=${SSL_KEY_PATH}"
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