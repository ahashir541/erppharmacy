# Moving MedFlow HQ to a cloud server

Today MedFlow HQ runs on the owner's PC and is reached through Tailscale Funnel. That works, but HQ
stops when the PC is off. This guide moves it to a small always-on server. **Only you can do the
account steps** (buying the server and a domain).

## 1. What you need (about Rs 2,000–4,000 a month)
- A small Linux server (VPS): 1–2 vCPU, 2 GB RAM, 25 GB disk, Ubuntu 24.04. Any provider is fine
  (for example Hetzner, DigitalOcean, Vultr, or a Pakistani host). Pick a nearby region.
- **A domain you own**, for example `hq.yourcompany.pk`. This matters most: pharmacies remember
  HQ's address, so use a name you can move to any server later without updating every pharmacy.

## 2. Point pharmacies at a name you own (do this first, even before the move)
1. Buy the domain. Keep using Tailscale until step 6; the domain goes live at the switch-over.
2. Record the new address: `node build-hq.mjs --url https://hq.yourcompany.pk` (writes `hq.json`), then
   `node build.mjs`, and publish that MedFlow Local version from HQ → Updates **before** the switch, while
   the old address still works. Pharmacies pick up the new address with that update. (One pharmacy can
   also be switched by hand: `"hqUrl": "https://hq.yourcompany.pk"` in `C:\MedFlow\config.json`.)

## 3. Prepare the server
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl ufw unattended-upgrades
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt -y install nodejs
sudo apt -y install caddy                      # HTTPS certificates, automatically
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
sudo adduser --system --group --home /opt/medflowhq medflowhq
```
Port 5299 stays closed to the internet; only Caddy talks to it.

## 4. Copy HQ over
1. On the HQ PC: close MedFlow HQ (end `node.exe` for `medflow-hq.mjs`).
2. Copy to `/opt/medflowhq` on the server: `medflow-hq.mjs`, `hq-public`, `sql`, `node_modules`,
   **`hq-data`** (the database) and **`hq-keys`** (the signing key). Not the Windows `node` folder.
3. `sudo chown -R medflowhq:medflowhq /opt/medflowhq && sudo chmod 700 /opt/medflowhq/hq-keys`

## 5. Run it as a service
`/etc/systemd/system/medflowhq.service`:
```ini
[Unit]
Description=MedFlow HQ
After=network-online.target

[Service]
User=medflowhq
WorkingDirectory=/opt/medflowhq
ExecStart=/usr/bin/node medflow-hq.mjs --port 5299
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/medflowhq

[Install]
WantedBy=multi-user.target
```
`/etc/caddy/Caddyfile`:
```
hq.yourcompany.pk {
    reverse_proxy 127.0.0.1:5299
}
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now medflowhq && sudo systemctl reload caddy
```
Caddy adds `X-Forwarded-For`, so HQ treats every internet request as outside: password sign-in
from the internet stays off, Google sign-in works. Add `https://hq.yourcompany.pk` to the Google
Client ID's Authorised JavaScript origins.

## 6. Switch over
1. Point the domain's A record at the server's IP. Wait until `https://hq.yourcompany.pk/hq/status` answers.
2. Leave the old PC's HQ **switched off** (two HQs must never run on the same data).
3. Admin tasks that need "this PC" (first admin, sign-in options): use an SSH tunnel,
   `ssh -L 5299:127.0.0.1:5299 you@server`, then open `http://localhost:5299` on your laptop.

## 7. Backups off the server
HQ backs up nightly into `/opt/medflowhq/hq-backups`. Copy them, and `hq-keys`, somewhere else
every night (for example the provider's backup/snapshot feature, or `rclone` to Google Drive).
Test a restore every [3] months.
