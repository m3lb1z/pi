#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="${PI_LOCAL_RELEASE_DIR:-/tmp/pi-personal-release}"

cd "$PROJECT_DIR"

echo "Building local release artifacts..."
npm run release:local -- \
	--out "$RELEASE_DIR" \
	--force \
	--skip-test \
	--skip-install

shopt -s nullglob
tarballs=("$RELEASE_DIR"/tarballs/*.tgz)
shopt -u nullglob

if [[ ${#tarballs[@]} -eq 0 ]]; then
	echo "No npm tarballs were created in $RELEASE_DIR/tarballs" >&2
	exit 1
fi

echo "Installing the local packages globally..."
npm install -g --ignore-scripts "${tarballs[@]}"

if ! command -v pi >/dev/null 2>&1; then
	echo "Installation completed, but pi is not available in PATH." >&2
	echo "Global npm bin directory: $(npm prefix -g)/bin" >&2
	exit 1
fi

echo "Installed local Pi variant:"
echo "  Executable: $(command -v pi)"
echo "  Version: $(pi --version)"
echo "Run 'hash -r' in the current shell before invoking pi."
