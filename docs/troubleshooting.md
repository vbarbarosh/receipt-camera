# Troubleshooting

- The header shows the app version (e.g. v10). After updating files on the
  laptop, refresh the page and check the number changed — it proves the phone
  runs the new copy.
- The phone reports diagnostics to the server terminal as `[...][phone_report]`
  lines — check them first when something misbehaves.
- If the phone can't reach the laptop, check the laptop firewall allows the
  port (`sudo ufw allow 8080/tcp` on Ubuntu).
- If your laptop's IP changes (DHCP), the home-screen icon points at a dead URL
  — give the laptop a static IP / DHCP reservation in the router, or re-add the
  icon.
