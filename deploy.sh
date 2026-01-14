#!/bin/bash
set -e

REGISTRY="192.168.50.150:5000"
IMAGE_NAME="espocrm-mcp-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/EspoMCP"

cd "$BUILD_DIR"

# Generate timestamp tag (yyyymmddhhmmss)
TIMESTAMP=$(date +"%Y%m%d%H%M%S")

# Get git short SHA
GIT_SHA=$(git rev-parse --short HEAD)

# Construct the versioned tag
VERSION_TAG="${TIMESTAMP}-${GIT_SHA}"

echo "Building ${IMAGE_NAME}..."
echo "  Registry: ${REGISTRY}"
echo "  Tags: latest, ${VERSION_TAG}"

# Build the image
docker build -t "${IMAGE_NAME}" .

# Tag for registry
docker tag "${IMAGE_NAME}" "${REGISTRY}/${IMAGE_NAME}:latest"
docker tag "${IMAGE_NAME}" "${REGISTRY}/${IMAGE_NAME}:${VERSION_TAG}"

# Push to registry
echo "Pushing to registry..."
docker push "${REGISTRY}/${IMAGE_NAME}:latest"
docker push "${REGISTRY}/${IMAGE_NAME}:${VERSION_TAG}"

echo "Done! Deployed:"
echo "  ${REGISTRY}/${IMAGE_NAME}:latest"
echo "  ${REGISTRY}/${IMAGE_NAME}:${VERSION_TAG}"
