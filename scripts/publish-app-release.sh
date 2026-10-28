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

# Les annotations exposent l'erreur de GitHub même lorsque les logs détaillés
# Actions ne sont pas accessibles ; les secrets ne sont jamais affichés.
run_gh() {
  local output
  if output=$(gh "$@" 2>&1); then
    printf '%s\n' "$output"
  else
    printf '%s\n' "$output" >&2
    printf '::error::Échec gh %s %s : %s\n' "$1" "$2" "${output//$'\n'/ }" >&2
    return 1
  fi
}

# Les droits GITHUB_TOKEN du dépôt permettent d'alimenter un brouillon, mais
# la création d'une release renvoie 403. Un mainteneur doit donc créer le
# brouillon avec son accès GitHub avant de lancer la publication.
if ! release_info=$(gh release view "$TAG" --json isDraft,targetCommitish --jq '[.isDraft, .targetCommitish] | @tsv' 2>&1); then
  printf '::error::Brouillon %s introuvable ou inaccessible. Créez-le avec --draft --target %s avant publication. %s\n' \
    "$TAG" "$TARGET" "${release_info//$'\n'/ }" >&2
  exit 1
fi
IFS=$'\t' read -r state draft_target <<< "$release_info"
if [[ "$state" != "true" ]]; then
  echo "La release $TAG est déjà publiée ; utilisez un nouveau tag." >&2
  exit 1
fi
if [[ "$draft_target" != "$TARGET" ]]; then
  printf '::error::Le brouillon %s cible %s, et non le commit compilé %s.\n' "$TAG" "$draft_target" "$TARGET" >&2
  exit 1
fi

# Un rerun peut reprendre un brouillon ; une release publique est immuable.
run_gh release upload "$TAG" "$ASSET_DIR"/* --clobber
run_gh release edit "$TAG" --draft=false --latest
