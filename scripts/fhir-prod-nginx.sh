#!/usr/bin/env bash
set -euo pipefail

action=${1:?prepare, activate or restore is required}
backup=${2:?A release backup directory is required}
source_file=deploy/production/openehr-fhir-modeller.sandbox.hygeoniq.com.conf
available=/etc/nginx/sites-available/openehr-fhir-modeller.sandbox.hygeoniq.com.conf
enabled=/etc/nginx/sites-enabled/openehr-fhir-modeller.sandbox.hygeoniq.com.conf
marker='# Managed by openehr_FHIR_Modeller production delivery.'
lock=/opt/hygeoniq/fhir-production-tooling/nginx.lock
[[ -f "$lock" && ! -L "$lock" && "$(stat -c '%u:%g:%a' "$lock")" == 0:1000:660 ]] || { echo 'The shared Nginx delivery lock is missing or has unexpected ownership.' >&2; exit 2; }
exec 9<>"$lock"
flock --wait 30 9 || { echo 'Another Nginx delivery is active; retry later.' >&2; exit 75; }

owned_site() {
  if [[ -e "$available" || -L "$available" ]]; then
    [[ -f "$available" && ! -L "$available" && "$(stat -c %u "$available")" == 0 ]] || { echo 'Refusing an unrelated Nginx available-site target.' >&2; return 1; }
    [[ "$(head -n 1 "$available")" == "$marker" ]] || { echo 'The existing Nginx site is not owned by this delivery.' >&2; return 1; }
  fi
  if [[ -e "$enabled" || -L "$enabled" ]]; then
    [[ -L "$enabled" && "$(readlink "$enabled")" == "$available" && "$(stat -c %u "$enabled")" == 0 ]] || { echo 'Refusing an unrelated Nginx enabled-site target.' >&2; return 1; }
  fi
}

restore() {
  owned_site || return 1
  # Do not overwrite an operator change made after our activation.
  [[ -f "$available" ]] && cmp -s "$source_file" "$available" || { echo 'The active Nginx site changed outside this release; refusing overwrite.' >&2; return 1; }
  if [[ "$(cat "$backup/available-existed")" == yes ]]; then
    sudo -n install -o root -g root -m 0644 "$backup/available.conf" "$available" || return 1
  else
    sudo -n rm -f -- "$available" || return 1
  fi
  if [[ "$(cat "$backup/enabled-existed")" == yes ]]; then
    if [[ ! -L "$enabled" ]]; then sudo -n ln -s "$available" "$enabled" || return 1; fi
  elif [[ -L "$enabled" ]]; then
    sudo -n rm -f -- "$enabled" || return 1
  fi
  sudo -n nginx -t || return 1
  sudo -n systemctl reload nginx
}

case "$action" in
  prepare)
    owned_site
    [[ "$(head -n 1 "$source_file")" == "$marker" ]] || { echo 'The tracked Nginx site lacks its ownership marker.' >&2; exit 2; }
    mkdir -p "$backup"
    if [[ -f "$available" ]]; then
      cp "$available" "$backup/available.conf"
      printf 'yes\n' > "$backup/available-existed"
    else
      printf 'no\n' > "$backup/available-existed"
    fi
    if [[ -L "$enabled" ]]; then printf 'yes\n' > "$backup/enabled-existed"; else printf 'no\n' > "$backup/enabled-existed"; fi
    ;;
  activate)
    owned_site
    if [[ "$(cat "$backup/available-existed")" == yes ]]; then
      cmp -s "$available" "$backup/available.conf" || { echo 'Nginx configuration changed after the release preflight.' >&2; exit 2; }
    else
      [[ ! -e "$available" && ! -L "$available" ]] || { echo 'A new Nginx site appeared after preflight.' >&2; exit 2; }
    fi
    trap 'status=$?; trap - ERR; restore || true; exit "$status"' ERR
    sudo -n install -o root -g root -m 0644 "$source_file" "$available"
    if [[ ! -L "$enabled" ]]; then sudo -n ln -s "$available" "$enabled"; fi
    sudo -n nginx -t
    sudo -n systemctl reload nginx
    trap - ERR
    ;;
  restore) restore ;;
  *) echo 'Unknown Nginx delivery operation.' >&2; exit 2 ;;
esac
