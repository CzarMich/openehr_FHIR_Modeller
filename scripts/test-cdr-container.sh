#!/usr/bin/env bash
set -euo pipefail
export CDR_TEST_REPO CDR_TEST_ROOT CDR_TEST_UID CDR_TEST_GID
CDR_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
CDR_TEST_ROOT=$(mktemp -d -t modelling-cdr.XXXXXXXX)
CDR_TEST_UID=$(id -u)
CDR_TEST_GID=$(id -g)
compose=(docker compose -p "modelling-cdr-test-$$" -f "$CDR_TEST_REPO/tests/fixtures/cdr/compose.yml")
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$CDR_TEST_ROOT"; }
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$CDR_TEST_ROOT/tls.key" -out "$CDR_TEST_ROOT/tls.crt" -subj /CN=cdr-fixture -addext subjectAltName=DNS:cdr-fixture -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
chmod 644 "$CDR_TEST_ROOT/tls.crt"
"${compose[@]}" up -d --build --wait cdr
"${compose[@]}" run --rm --build -T app php /probe.php
