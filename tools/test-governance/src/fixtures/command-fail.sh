#!/usr/bin/env bash
# Canonical failing command fixture for Selected Test Runner self-tests.
set -euo pipefail
echo "command-failure" >&2
exit 7
