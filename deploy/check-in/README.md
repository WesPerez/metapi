# Check-in deployment

This compose file runs the `check-in` branch as an isolated service.
The build sets `VITE_CHECKIN_MODE=true`, so the UI exposes only account management and the password, schedule, and system-proxy settings. The runtime sets `CHECKIN_APP_MODE=true`, which keeps the check-in scheduler active while disabling balance refresh, daily summary, log cleanup, polling, OAuth callback, backup, proxy-retention background jobs, and canonical full-app SQLite migrations. Initialize a fresh data directory with `scripts/checkin/init-checkin-database.ts`; migrate an older full database by copying it and running `scripts/checkin/prune-checkin-database.ts --apply` while the service is stopped.

## Staging

1. Keep the production Metapi container running on port 4000.
2. Create a separate data directory and copy a database backup into it. Do not mount `/root/metapi-deploy/data` directly.
3. Keep exactly one automatic check-in owner. Before enabling this instance, back up the old database and disable `checkin_enabled` on the old instance's accounts. Restore that backup to roll back ownership.
4. Copy `.env.example` to the staging directory, fill the same admin credentials (or deliberately choose a new password), then run:

```sh
docker compose -f /root/metapi/deploy/check-in/docker-compose.yml \
  --env-file /root/metapi-checkin-deploy/.env up -d --build
```

The staging service listens only on `127.0.0.1:14000`. Check it before changing any DNS or Nginx mapping:

```sh
curl -i http://127.0.0.1:14000/
docker inspect --format '{{.State.Health.Status}}' metapi-checkin
```

## Temporary Nginx mapping (manual, after acceptance)

Back up the active file first:

```sh
cp -a /etc/nginx/sites-available/weesai \
  /etc/nginx/sites-available/weesai.check-in.backup.$(date +%Y%m%d%H%M%S)
```

Inside the `weesai.com` HTTPS server block, replace only the existing `location /` static fallback with:

```nginx
location / {
    proxy_pass http://127.0.0.1:14000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

Run `nginx -t` and reload only if the test succeeds. Keep the existing special locations (`/images/`, `/router/`, mail, V2Ray, and other service paths) unchanged. Restore the backup and reload Nginx to roll back.

The repository does not change system Nginx automatically.
