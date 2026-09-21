# HTTPS certificates

Place a PEM certificate/full chain at `cert.pem` and its private key at `cert.key`.
The web container selects HTTPS when both files are present. Restart `web` after
installing or renewing them. These files are ignored by Git.

The certificate must cover the exact hostname or IP users visit. nginx preserves
that host; it does not add `www`. See [local and LAN deployment](../../deploy/LOCAL.md)
for trusted local certificates and [private server deployment](../../deploy/SERVER.md)
for domain certificates and renewal.
