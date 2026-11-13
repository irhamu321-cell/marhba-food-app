# Putting Marhba online, with HTTPS

A step-by-step guide for one small server. It assumes you have never done this
before. Everything here is done once; after that, updating is three commands.

Nothing in this guide is automated by the app. Read it, do it, and keep the
notes you write along the way.

---

## What you need

| | |
|---|---|
| A small VPS | 1 vCPU, 2 GB RAM is plenty. Hetzner, Contabo, DigitalOcean, OVH — about 5 € a month |
| A domain name | e.g. `marhba.ma`. Buy it anywhere; you only need to edit its DNS |
| Your business details | The nine fields in `server/config/business.js`. The app refuses to start in production without them |
| About an hour | Less if you have done it before |

---

## 1. Point the domain at the server

In your domain registrar's DNS panel, create two records pointing at your
server's IP address:

```
A     marhba.ma        203.0.113.10
A     www.marhba.ma    203.0.113.10
```

Wait a few minutes, then check from your own machine:

```bash
ping marhba.ma
```

It must answer from your server's address. **Do not continue until it does** —
Caddy cannot obtain a certificate for a domain that does not point at it.

---

## 2. Prepare the server

Connect to it:

```bash
ssh root@203.0.113.10
```

Install Node.js 22 and Caddy:

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

node -v     # must print v22.x
caddy version
```

Create a user for the app, so it does not run as root:

```bash
adduser --system --group --home /opt/marhba marhba
```

---

## 3. Copy the app over

From **your own computer**, in the folder that contains `food-app`:

```bash
rsync -av --exclude data --exclude node_modules food-app/ root@203.0.113.10:/opt/marhba/
```

Then back on the server:

```bash
chown -R marhba:marhba /opt/marhba
mkdir -p /opt/marhba/data && chown marhba:marhba /opt/marhba/data
```

---

## 4. Write the configuration

Create `/opt/marhba/.env`:

```bash
nano /opt/marhba/.env
```

Paste this and fill in every value:

```ini
NODE_ENV=production
PORT=3000

# A long random string. Generate one with:  openssl rand -hex 32
JWT_SECRET=

# The first administrator password. Long, and not reused anywhere else.
ADMIN_PASSWORD=

# Only your own site may call the API.
CORS_ORIGIN=https://marhba.ma

# The app sits behind Caddy, so it must trust the forwarded address.
TRUST_PROXY=1

# Never true on a live server.
SEED_DEMO_DATA=false

# --- your business identity: the legal pages are built from these ---
BUSINESS_NAME=
LEGAL_FORM=
RC_NUMBER=
ICE_NUMBER=
BUSINESS_ADDRESS=
BUSINESS_CITY=
BUSINESS_PHONE=
BUSINESS_EMAIL=
RESPONSIBLE_PERSON=
# Leave empty until the declaration is actually filed. Never invent it.
CNDP_DECLARATION=
```

Lock it down — it holds your secret:

```bash
chmod 600 /opt/marhba/.env
chown marhba:marhba /opt/marhba/.env
```

**The app will refuse to start** if `JWT_SECRET` is missing or weak, if
`ADMIN_PASSWORD` is missing, if `SEED_DEMO_DATA=true`, if `CORS_ORIGIN` is `*`,
or if any business field is empty. That refusal is deliberate: each of those is
a way to get hurt in public.

---

## 5. Keep it running

Create `/etc/systemd/system/marhba.service`:

```ini
[Unit]
Description=Marhba
After=network.target

[Service]
Type=simple
User=marhba
WorkingDirectory=/opt/marhba/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/marhba.log
StandardError=append:/var/log/marhba.log

[Install]
WantedBy=multi-user.target
```

```bash
touch /var/log/marhba.log && chown marhba:marhba /var/log/marhba.log
systemctl daemon-reload
systemctl enable --now marhba
systemctl status marhba        # must say "active (running)"
tail -n 40 /var/log/marhba.log
```

If it refuses to start, the log says exactly which setting is wrong.

---

## 6. HTTPS with Caddy

Replace `/etc/caddy/Caddyfile` with:

```caddy
marhba.ma, www.marhba.ma {
    encode gzip

    # Caddy obtains and renews the certificate on its own.
    reverse_proxy 127.0.0.1:3000

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        Content-Security-Policy "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
        -Server
    }

    # The uptime check does not need to be logged on every hit.
    @health path /api/health
    log_skip @health

    log {
        output file /var/log/caddy/marhba.log
        format json
    }
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Open `https://marhba.ma` in a browser. You should see the padlock and the
customer app. Caddy renews the certificate automatically; there is nothing to
remember.

**The app must stay on 127.0.0.1.** Do not open port 3000 in the firewall:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## 7. First login

The first start prints the administrator password, once, into
`data/FIRST-ADMIN-LOGIN.txt` — unless you set `ADMIN_PASSWORD`, which you did.

```bash
# log in at https://marhba.ma/admin.html with your ADMIN_PASSWORD
# then, in Settings, change it, and delete the file if it exists
rm -f /opt/marhba/data/FIRST-ADMIN-LOGIN.txt
```

Go to **Paramètres → Système** and check that the banner is green: no missing
legal field, backup recent, disk healthy.

---

## 8. Backups that leave the machine

The app writes a backup every day into `data/backups/` and keeps 14 days.
**A backup on the same disk is not a backup.** Copy them off, every night.

From another machine you control:

```bash
# in that machine's crontab:  crontab -e
0 4 * * * rsync -az root@203.0.113.10:/opt/marhba/data/backups/ ~/marhba-backups/
```

Then, once a month, actually test a restore — a backup nobody has restored is
a guess:

```bash
cd /opt/marhba/server
node src/restore.js ../data/backups/backup-2026-11-02.db /tmp/test-restore.db
```

It prints a table-by-table row count and refuses the file if anything is
missing, truncated or from an older format.

### Uploaded pictures are not in the backups

Logos and dish photos are files under `web/uploads/`, not rows in the database,
so `data/backups/` does not contain them. A restore brings back every order and
every price and leaves the menu with broken images.

Copy that folder off the machine on the same schedule as the database:

```bash
# in that machine's crontab, next to the line above:
15 4 * * * rsync -az root@203.0.113.10:/opt/marhba/web/uploads/ ~/marhba-uploads/
```

The alternative is to paste image links hosted elsewhere into the picture
fields instead of uploading — both editors accept a URL — in which case there
is nothing local to back up.

---

## 9. Watching it

**Uptime.** Point a free external monitor (UptimeRobot, Better Stack, Healthchecks.io)
at `https://marhba.ma/api/health` every 5 minutes. It answers `200` when
healthy and `503` when the database is unreachable, so no body parsing is
needed. Have it alert you by email and SMS.

**Backups and disk.** The admin panel's Système panel shows the last backup,
its table and row counts, and free disk space, and a red banner appears on
every screen when a backup fails or the disk runs low. Look at it weekly.

**Errors somewhere you will look.** Set `SENTRY_DSN` in `.env` and errors are
sent to Sentry — only errors, never an info or a warning, and never the 500
pages a crawler causes. Everything is scrubbed first, with the same rules as
the local log: a phone number becomes a fingerprint, a token is never there at
all, and absolute paths are trimmed so this server's directory layout does not
end up in a third party's database. Sends are capped at 20 a minute, so a
crash loop cannot flood it or slow the app down. An uncaught crash is written
locally and sent before the process exits, so the supervisor's restart is not
the only trace of it.

**Logs.** One JSON object per line in `/var/log/marhba.log`. Failed logins,
permission refusals, refunds, backup results and database errors are all there,
and never a password, token or verification code.

```bash
# failed logins today
grep login.failed /var/log/marhba.log | tail -20

# anything that went wrong
grep '"level":"error"' /var/log/marhba.log | tail -20
```

**Disk space**, checked by hand now and then:

```bash
df -h /opt/marhba
```

---

## 10. Updating later

```bash
# on your computer
rsync -av --exclude data --exclude node_modules food-app/ root@203.0.113.10:/opt/marhba/

# on the server
systemctl restart marhba
systemctl status marhba
tail -n 30 /var/log/marhba.log
```

Take a backup first, and check the Système panel afterwards.

---

## If something goes wrong

| Symptom | Where to look |
|---|---|
| The app will not start | `tail -n 50 /var/log/marhba.log` — a refused start names the setting |
| Browser cannot reach the site | `systemctl status caddy`, then `caddy validate --config /etc/caddy/Caddyfile` |
| No certificate | DNS must point at the server *before* Caddy asks. Check with `ping marhba.ma` |
| Logged out constantly | `JWT_SECRET` changed, or is different between restarts |
| "Session expirée" for everyone | Normal after a password change or "log out everywhere" |
| Backup banner is red | Open Paramètres → Système; the exact error is shown |

---

## Ready-made configuration files

| File | What it is |
|---|---|
| `deploy/Caddyfile` | the Caddy site from section 6, complete, with the order stream left unbuffered |
| `deploy/nginx.conf` | the same for nginx, with per-address rate limits on login and verification codes |
| `ecosystem.config.cjs` | PM2, if you would rather use it than the systemd unit in section 5. Never both at once |

Both proxy files carry a note about the one decision in them: the address map
loads Leaflet from a CDN, so the content policy trusts that CDN. The note
explains how to host it yourself instead.

---

## What this guide does not do

- It does not set up a staging server. You are editing the live site.
- It does not set up log rotation. Add `logrotate` for `/var/log/marhba.log`
  before the file gets large.
- It does not configure an SMS provider, so verification codes are still read
  from the admin panel. See the README.
- It does not replace legal advice. Finish the business details and confirm the
  CNDP declaration before you take a single real order.
