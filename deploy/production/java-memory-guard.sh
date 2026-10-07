#!/bin/sh
# Production-only admission for the shared validator / IG Publisher host.
# The lock is provisioned separately and mounted into both application stacks.
set -u

real_java=/opt/java/openjdk/bin/java
lock=/run/fhir-tooling/java.lock
flock=/usr/bin/flock

# Readiness must work while another application owns the heavy-work slot.
if [ "$#" -eq 1 ]; then
    case "$1" in
        -version|--version) exec "$real_java" "$@" ;;
    esac
fi

if [ ! -f "$lock" ] || [ ! -r "$lock" ] || [ ! -w "$lock" ]; then
    echo "Java tooling admission unavailable: the shared lock must be mounted and readable/writable." >&2
    exit 78
fi
if [ ! -x "$flock" ] || [ ! -x "$real_java" ]; then
    echo "Java tooling admission unavailable: flock and the Java runtime must be executable." >&2
    exit 78
fi

# No queue: a waiting job would consume the caller's validation timeout.
# --no-fork replaces flock with Java; existing process-group/tree cancellation
# kills that process and releases its lock. Preserve all JVM arguments and heap.
"$flock" --exclusive --nonblock --conflict-exit-code 75 --no-fork "$lock" "$real_java" "$@"
status=$?
if [ "$status" -eq 75 ]; then
    echo "Java tooling busy: another validator or IG Publisher is running. Retry after it finishes; this operation did not complete successfully." >&2
fi
exit "$status"
