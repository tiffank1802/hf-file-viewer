#!/usr/bin/env python3
"""
Crée des liens de partage « Toute personne disposant du lien peut afficher »
pour des carnets OneNote / fichiers OneDrive via Microsoft Graph, puis met à
jour les fichiers `.url` correspondants (localement et/ou dans le bucket HF).

Fonctionne avec un compte Microsoft personnel (outlook/hotmail/live) comme
avec un compte école/entreprise : l’authentification se fait en « device code
flow » (un code à valider dans le navigateur, jeton mis en cache ensuite).

Prérequis :
    pip install msal requests huggingface_hub   # huggingface_hub : uniquement si --hf-repo / --upload
    + une app Entra ID (voir scripts/README_SHARE_ONENOTE.md)

Exemples :
    # Simulation depuis un dossier local de .url (aucune écriture)
    python scripts/share-onenote-links.py --client-id APP_ID --source-dir ./urls --dry-run

    # Liens réels + .url réécrits en local
    python scripts/share-onenote-links.py --client-id APP_ID --source-dir ./urls --output-dir ./urls-partages

    # Lecture + réécriture directe dans le bucket Hugging Face
    HF_TOKEN=hf_xxx python scripts/share-onenote-links.py --client-id APP_ID \\
        --hf-repo ktongue/ENISE-SITE --upload
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests

try:
    import msal
except ImportError:
    print("Dépendance manquante : pip install msal requests", file=sys.stderr)
    sys.exit(2)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = ["Files.ReadWrite.All"]
RETRY_STATUS = {429, 502, 503, 504}
MS_HOSTS = (
    "onedrive.live.com",
    "1drv.ms",
    "sharepoint.com",
    "onenote.com",
    "officeapps.live.com",
)


# ---------------------------------------------------------------------------
# Raccourcis .url (miroir de parseInternetShortcut dans src/utils/files.js)
# ---------------------------------------------------------------------------

def parse_url_file(content):
    """Parse un .url (section [InternetShortcut]) -> dict de champs."""
    result = {"url": "", "baseUrl": "", "iconFile": "", "iconIndex": "", "hotkey": "", "modified": ""}
    if not isinstance(content, str):
        return result
    section = ""
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(";") or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            continue
        if section != "internetshortcut" or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().lower()
        value = value.strip()
        mapping = {
            "url": "url",
            "baseurl": "baseUrl",
            "iconfile": "iconFile",
            "iconindex": "iconIndex",
            "hotkey": "hotkey",
            "modified": "modified",
        }
        if key in mapping and not result[mapping[key]]:
            result[mapping[key]] = value
    return result


def rewrite_url_file(content, new_url):
    """Remplace la cible URL= d’un .url en préservant le reste du fichier."""
    lines = content.splitlines(keepends=True)
    if not lines:
        lines = ["[InternetShortcut]\n"]
    newline = "\r\n" if content.startswith("[InternetShortcut]\r\n") or "\r\n" in content[:200] else "\n"
    section = ""
    for index, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].strip().lower()
            continue
        if section != "internetshortcut":
            continue
        key, sep, _ = stripped.partition("=")
        if sep and key.strip().lower() == "url":
            lines[index] = f"URL={new_url}{newline}"
            return "".join(lines)
    # Pas de ligne URL= : l’insérer après [InternetShortcut], ou créer la section.
    for index, raw_line in enumerate(lines):
        if raw_line.strip().lower() == "[internetshortcut]":
            lines.insert(index + 1, f"URL={new_url}{newline}")
            return "".join(lines)
    return f"[InternetShortcut]{newline}URL={new_url}{newline}" + "".join(lines)


# ---------------------------------------------------------------------------
# Microsoft Graph
# ---------------------------------------------------------------------------

def encode_sharing_id(url):
    """Encode une URL OneDrive/SharePoint pour l’API /shares/{id}."""
    token = base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")
    return "u!" + token


def is_microsoft_url(url):
    try:
        from urllib.parse import urlparse

        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "1drv.ms" or any(host == h or host.endswith("." + h) for h in MS_HOSTS)


def token_cache_path():
    path = Path.home() / ".cache" / "enise-docs" / "msal-cache.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def acquire_token(client_id, authority):
    cache = msal.SerializableTokenCache()
    cache_file = token_cache_path()
    if cache_file.exists():
        cache.deserialize(cache_file.read_text(encoding="utf-8"))
    app = msal.PublicClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{authority}",
        token_cache=cache,
    )
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            return result["access_token"]
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Device flow refusé : {json.dumps(flow)}")
    print(flow["message"])
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(
            "Échec d’authentification : "
            + str(result.get("error_description") or result.get("error"))
        )
    cache_file.write_text(cache.serialize(), encoding="utf-8")
    try:
        os.chmod(cache_file, 0o600)
    except OSError:
        pass
    return result["access_token"]


class GraphClient:
    def __init__(self, token):
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )

    def _request(self, method, path, payload=None):
        last_error = ""
        for attempt in range(4):
            try:
                response = self.session.request(
                    method, GRAPH_BASE + path, json=payload, timeout=30
                )
            except requests.RequestException as exc:
                last_error = f"réseau : {exc}"
                time.sleep(2 * (attempt + 1))
                continue
            if response.status_code in RETRY_STATUS and attempt < 3:
                wait = int(response.headers.get("Retry-After", 2 * (attempt + 1)))
                time.sleep(wait)
                continue
            if 200 <= response.status_code < 300:
                return response.json() if response.content else {}
            try:
                detail = response.json().get("error", {}).get("message", response.text)
            except ValueError:
                detail = response.text
            raise RuntimeError(f"Graph {response.status_code} : {str(detail)[:300]}")
        raise RuntimeError(last_error or "échec répété de l’appel Graph")

    def resolve_item(self, target_url):
        """Résout une URL OneDrive/SharePoint vers son driveItem (lecture seule)."""
        data = self._request(
            "GET", f"/shares/{encode_sharing_id(target_url)}/driveItem?$select=id,name"
        )
        if not data.get("id"):
            raise RuntimeError("élément introuvable via /shares")
        return data

    def create_anonymous_link(self, target_url, link_type="view"):
        """Crée (ou récupère) le lien « Anyone » et renvoie sa webUrl."""
        data = self._request(
            "POST",
            f"/shares/{encode_sharing_id(target_url)}/driveItem/createLink",
            {"type": link_type, "scope": "anonymous"},
        )
        web_url = (data.get("link") or {}).get("webUrl", "")
        if not web_url:
            raise RuntimeError("createLink n’a pas renvoyé de webUrl")
        return web_url


# ---------------------------------------------------------------------------
# Sources / destinations des .url
# ---------------------------------------------------------------------------

def collect_local(dir_path):
    items = []
    for pattern in ("*.url", "*.URL", "*.Url"):
        items.extend(sorted(Path(dir_path).rglob(pattern)))
    return [("local:" + p.name, p.read_text(encoding="utf-8-sig"), None) for p in items]


def collect_hf(repo_id, token):
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError:
        print("Dépendance manquante : pip install huggingface_hub", file=sys.stderr)
        sys.exit(2)
    api = HfApi(token=token)
    paths = [
        p for p in api.list_repo_files(repo_id, repo_type="dataset") if p.lower().endswith(".url")
    ]
    items = []
    for path in sorted(paths):
        local = hf_hub_download(repo_id, path, repo_type="dataset", token=token)
        items.append(
            (f"hf:{path}", Path(local).read_text(encoding="utf-8-sig"), path)
        )
    return items


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Partage OneNote/OneDrive « Anyone » + mise à jour des .url."
    )
    parser.add_argument("--client-id", required=True, help="Application (client) ID Entra")
    parser.add_argument(
        "--authority",
        default="common",
        help="Locataire Entra : common (défaut, perso+pro), consumers (perso seul), "
        "organizations ou un tenant ID (pro seul)",
    )
    parser.add_argument("--source-dir", help="Dossier local de .url à traiter (récursif)")
    parser.add_argument("--hf-repo", help="Bucket HF à lire, ex. ktongue/ENISE-SITE")
    parser.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""),
                        help="Token HF (défaut : variable HF_TOKEN)")
    parser.add_argument("--output-dir", help="Dossier local d’écriture des .url mis à jour")
    parser.add_argument("--upload", action="store_true",
                        help="Réécrit les .url dans --hf-repo (nécessite un token en écriture)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Résout sans créer de lien ni rien écrire")
    parser.add_argument("--link-type", default="view", choices=["view", "edit"],
                        help="Type de lien partage (défaut : view)")
    args = parser.parse_args(argv)

    if not args.source_dir and not args.hf_repo:
        parser.error("indiquez --source-dir et/ou --hf-repo")
    if args.upload and not args.hf_repo:
        parser.error("--upload nécessite --hf-repo")
    if args.hf_repo and not args.hf_token:
        parser.error("--hf-repo nécessite --hf-token ou la variable HF_TOKEN")
    if not args.dry_run and not args.output_dir and not args.upload:
        parser.error("hors --dry-run, indiquez --output-dir et/ou --upload")

    entries = []
    if args.source_dir:
        entries.extend(collect_local(args.source_dir))
    if args.hf_repo:
        entries.extend(collect_hf(args.hf_repo, args.hf_token))
    if not entries:
        print("Aucun fichier .url trouvé.")
        return 0

    print(f"Authentification Microsoft ({len(entries)} fichier(s), autorité {args.authority})…")
    token = acquire_token(args.client_id, args.authority)
    graph = GraphClient(token)

    try:
        from huggingface_hub import HfApi

        hf_api = HfApi(token=args.hf_token) if args.upload else None
    except ImportError:
        hf_api = None
    if args.upload and hf_api is None:
        print("Dépendance manquante : pip install huggingface_hub", file=sys.stderr)
        return 2
    if args.output_dir:
        Path(args.output_dir).mkdir(parents=True, exist_ok=True)

    ok, skipped, failed = 0, 0, 0
    for label, content, hf_path in entries:
        target = parse_url_file(content).get("url", "")
        if not target:
            print(f"[SKIP] {label} : aucune URL dans le raccourci")
            skipped += 1
            continue
        if not target.lower().startswith(("http://", "https://")):
            print(f"[SKIP] {label} : protocole non web ({target[:40]}…), partage manuel requis")
            skipped += 1
            continue
        if not is_microsoft_url(target):
            print(f"[SKIP] {label} : cible hors Microsoft, rien à partager")
            skipped += 1
            continue
        try:
            item = graph.resolve_item(target)
            print(f"[OK]   {label} : résolu → {item.get('name', '?')}")
            if args.dry_run:
                continue
            new_url = graph.create_anonymous_link(target, args.link_type)
            updated = rewrite_url_file(content, new_url)
            if args.output_dir:
                out = Path(args.output_dir) / Path(hf_path or label.split(":", 1)[1]).name
                out.write_text(updated, encoding="utf-8")
            if args.upload:
                hf_api.upload_file(
                    path_or_fileobj=updated.encode("utf-8"),
                    path_in_repo=hf_path,
                    repo_id=args.hf_repo,
                    repo_type="dataset",
                    commit_message=f"Partage Anyone : {Path(hf_path).name}",
                )
            print(f"       → lien Anyone : {new_url[:90]}")
            ok += 1
        except Exception as exc:  # noqa: BLE001 - rapport par fichier, pas d’arrêt global
            print(f"[FAIL] {label} : {exc}")
            failed += 1

    print(f"\nRésumé : {ok} partagé(s), {skipped} ignoré(s), {failed} en échec"
          + (" (simulation)" if args.dry_run else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
