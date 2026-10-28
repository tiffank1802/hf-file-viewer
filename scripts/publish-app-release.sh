#!/usr/bin/env bash
# Publie une release stable seulement après téléchargement de TOUS ses fichiers.
set -euo pipefail

ASSET_DIR=${1:?Usage: publish-app-release.sh <dossier-des-fichiers>}
TAG=${RELEASE_TAG:?RELEASE_TAG est requis}
TARGET=${RELEASE_TARGET:?RELEASE_TARGET est requis}

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Le tag doit être une version stable vMAJEUR.MINEUR.PATCH : $TAG" >&2
  exit 1
fi
for file in \
  ENISE-Docs-windows-x64-setup.exe ENISE-Docs-windows-x64.msi \
  ENISE-Docs-macos-universal.dmg ENISE-Docs-macos-universal.app.tar.gz \
  ENISE-Docs-android-universal.apk ENISE-Docs-android-universal.aab \
  ENISE-Docs-ios-unsigned.ipa ENISE-Docs-ios-simulator-arm64.app.zip SHA256SUMS.txt; do
  test -s "$ASSET_DIR/$file" || { echo "Fichier manquant ou vide : $file" >&2; exit 1; }
done

# Un rerun peut reprendre un brouillon ; une release déjà publique est
# immuable pour ne jamais remplacer silencieusement les téléchargements.
if state=$(gh release view "$TAG" --json isDraft --jq .isDraft 2>/dev/null); then
  if [[ "$state" != "true" ]]; then
    echo "La release $TAG est déjà publiée ; utilisez un nouveau tag." >&2
    exit 1
  fi
else
  gh release create "$TAG" --target "$TARGET" --draft \
    --title "ENISE Docs $TAG — applications de test" \
    --notes-file .github/APP_RELEASE_NOTES.md
fi

gh release upload "$TAG" "$ASSET_DIR"/* --clobber
gh release edit "$TAG" --draft=false --latest
