Place your SSL certificate files here:

- `cert.pem` — certificate (or fullchain)
- `cert.key` — private key

Example:
```bash
cp thinkai.cc.pem cert.pem
cp thinkai.cc.key cert.key
```

These files are git-ignored and will not be committed.
Without these files, nginx serves on HTTP only (port 80).
