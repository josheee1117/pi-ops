#!/usr/bin/env bash
# ponytail: 手工 save/load 是首次部署最短路径；稳定后由 Jenkins 推 ACR，走 DataAsset 同款 deploy.sh
set -euo pipefail
[[ $# == 2 && $2 =~ ^[a-fA-F0-9]{7,64}$ ]] || { echo "usage: $0 <ssh-target> <sha>" >&2; exit 2; }
tarball="/tmp/pi-ops-$2.tar.gz"
[[ -f "$tarball" ]] || { echo "missing $tarball; build and export it first" >&2; exit 1; }
scp "$tarball" "$1:$tarball"
ssh "$1" "gunzip -c '$tarball' | docker load && docker image inspect pi-ops:$2 >/dev/null"
echo "loaded pi-ops:$2 on $1"
