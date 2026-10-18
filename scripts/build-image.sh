#!/usr/bin/env bash
# Build the game server image.
#
# Requires Docker with BuildKit. Note that a Vast instance is itself a container
# without the privileges to nest another, so this generally runs in CI or on a
# workstation -- `scripts/smoke-entrypoint.sh` covers the same contract on boxes
# where Docker cannot run.
#
#   ./scripts/build-image.sh                    # tag from the current commit
#   ./scripts/build-image.sh v0.2.0 --push
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/glavin001}"
IMAGE="${IMAGE:-$REGISTRY/vibe-land-server}"
BUILDER_IMAGE="${BUILDER_IMAGE:-$REGISTRY/vibe-land-builder:cuda12.8-physx-ovphysx-5.5.1}"

# Tags are immutable and traceable to a commit. Never `latest`: the fleet var
# records exactly which build is deployed, and a moving tag would make a
# rollback ambiguous.
TAG=""
PUSH=""
PREBUILT=""
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    # Package on this machine and skip the builder image. Requires a working
    # PhysX/Blast toolchain locally, but avoids pulling ~15 GB of CUDA to
    # produce a byte-identical runtime image.
    --prebuilt) PREBUILT=1 ;;
    *) TAG="$arg" ;;
  esac
done
TAG="${TAG:-sha-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)}"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }

echo "[build] image: $IMAGE:$TAG"

# Prefer buildx when the plugin is installed (CI has it); fall back to the
# classic command otherwise. Modern daemons route both through BuildKit, which
# is what the variable `COPY --from=${BUNDLE_STAGE}` needs.
if docker buildx version >/dev/null 2>&1; then
  args=(buildx build --progress plain)
else
  args=(build)
fi
args+=(
  --file "$REPO_ROOT/docker/Dockerfile"
  --tag "$IMAGE:$TAG"
)
if [[ -n "$PREBUILT" ]]; then
  echo "[build] source: locally packaged bundle (dist/physx-server)"
  bash "$REPO_ROOT/scripts/package-physx-server.sh" "$REPO_ROOT/dist/physx-server" >/dev/null
  args+=(--build-arg BUNDLE_STAGE=prebuilt)
else
  echo "[build] source: builder image $BUILDER_IMAGE"
  args+=(--build-arg "BUILDER_IMAGE=$BUILDER_IMAGE")
fi
if [[ -n "$PUSH" ]]; then
  args+=(--push)
elif docker buildx version >/dev/null 2>&1; then
  # buildx keeps its result in the build cache unless told to load it into the
  # local image store; the classic builder already does that.
  args+=(--load)
fi

docker "${args[@]}" "$REPO_ROOT"

echo
echo "[build] done: $IMAGE:$TAG"
docker image inspect "$IMAGE:$TAG" --format '[build] size: {{.Size}} bytes' 2>/dev/null || true
echo "[build] smoke test it with: ./scripts/smoke-image.sh $IMAGE:$TAG"
