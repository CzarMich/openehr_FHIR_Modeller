#!/bin/sh
set -eu
# Passwords remain in secret files and are passed through a pipe, never process arguments.
app_password=$(cat /run/secrets/governance-password)
case "$app_password" in *[!a-f0-9]*|'') echo 'Expected generated hex database password' >&2; exit 1;; esac
[ "${#app_password}" -ge 64 ] || exit 1
printf "CREATE ROLE modelling_app LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;\n" "$app_password" | psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1
unset app_password
