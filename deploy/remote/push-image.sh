#!/usr/bin/env bash
# ponytail: 手工 save/load 是首次部署最短路径；稳定后由 Jenkins 推 ACR，走 DataAsset 同款 deploy.sh
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <ssh-target> <sha>" >&2
  exit 2
fi

target=$1
sha=$2
image="pi-ops:$sha"
tarball="/tmp/pi-ops-$sha.tar.gz"

if [[ ! -f "$tarball" ]]; then
  echo "missing $tarball; build and export it first:" >&2
  echo "  docker build --platform linux/amd64 -f deploy/docker/Dockerfile -t $image ." >&2
  echo "  docker save $image | gzip > $tarball" >&2
  exit 1
fi

scp "$tarball" "$target:/tmp/$(basename "$tarball")"
ssh "$target" "gunzip -c /tmp/$(basename "$tarball") | docker load && docker image inspect $image >/dev/null"
echo "loaded $image on $target"
