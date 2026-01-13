#!/usr/bin/env bash
set -euo pipefail

# --- Config (override via env or flags) ---
IMAGE_NAME="${IMAGE_NAME:-espo-mcp}"                 # repo/app name
REGISTRY="${REGISTRY:-blackbox:5000}"               # e.g. 192.168.50.165:5000
CONTEXT="${CONTEXT:-.}"                             # build context (path)
DOCKERFILE="${DOCKERFILE:-Dockerfile}"              # dockerfile path

# --- Flags ---
PUSH="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)    IMAGE_NAME="$2"; shift 2 ;;
    --registry) REGISTRY="$2";   shift 2 ;;
    --context)  CONTEXT="$2";    shift 2 ;;
    --file|-f)  DOCKERFILE="$2"; shift 2 ;;
    --push)     PUSH="true";     shift 1 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- Derive tags ---
# git describe: tag if available, else short SHA; appends -dirty if uncommitted changes
GIT_TAG="$(git describe --tags --always --dirty)"
# also embed exact commit for labels
GIT_SHA="$(git rev-parse --short=12 HEAD)"

# full image refs
REF_BASE="${REGISTRY}/${IMAGE_NAME}"
REF_LATEST="${REF_BASE}:latest"
REF_GIT="${REF_BASE}:${GIT_TAG}"

echo "Building:"
echo "  ${REF_LATEST}"
echo "  ${REF_GIT}"
echo

# --- Build once, tag twice ---
docker build \
  -f "${DOCKERFILE}" \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --label "org.opencontainers.image.source=$(git config --get remote.origin.url || echo unknown)" \
  -t "${REF_LATEST}" \
  -t "${REF_GIT}" \
  "${CONTEXT}"

echo
echo "Built images:"
echo "  ${REF_LATEST}"
echo "  ${REF_GIT}"

if [[ "${PUSH}" == "true" ]]; then
  echo
  echo "Pushing:"
  docker push "${REF_LATEST}"
  docker push "${REF_GIT}"
fi

echo
echo "Done."
