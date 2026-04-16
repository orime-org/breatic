#!/bin/sh
# Auto-select HTTP or HTTPS nginx config based on cert presence.

if [ -f /etc/nginx/certs/cert.pem ] && [ -f /etc/nginx/certs/cert.key ]; then
  echo "[entrypoint] SSL certs found, enabling HTTPS"
  cp /etc/nginx/templates/nginx-ssl.conf /etc/nginx/conf.d/breatic.conf
else
  echo "[entrypoint] No SSL certs, using HTTP only"
  cp /etc/nginx/templates/nginx.conf /etc/nginx/conf.d/breatic.conf
fi

exec nginx -g "daemon off;"
