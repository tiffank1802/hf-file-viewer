#!/usr/bin/env python3
"""
Script de déploiement automatique du Space Hugging Face (version Python).

Utilisation:
    HF_TOKEN=your_token python scripts/deploy-space.py
    HF_TOKEN=your_token python scripts/deploy-space.py --private --skip-files

Variables d'environnement requises:
    - HF_TOKEN: Token Hugging Face avec permissions "write" et "repo.create"

Dépendance:
    pip install huggingface_hub

Note importante sur le plan Hugging Face:
    - Static Spaces : gratuits pour tout le monde (mais pas de backend Python).
    - Gradio/Docker Spaces (cpu-basic) : nécessitent un abonnement PRO.
      https://huggingface.co/pro
    - Comptes personnels gratuits : jusqu'à 2 Spaces Gradio sur ZeroGPU.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

try:
    from huggingface_hub import HfApi, SpaceStage
    from huggingface_hub.errors import HfHubHTTPError
except ImportError:
    print(
        "❌ La dépendance 'huggingface_hub' est manquante.\n"
        "   Installez-la avec:  pip install huggingface_hub\n"
    )
    sys.exit(1)

# ── Configuration ────────────────────────────────────────────────────────────
SPACE_NAME = "solidworks-viewer"
SPACE_SDK = "docker"
SPACE_HARDWARE = "cpu-basic"  # cpu-basic, cpu-upgrade, t4-medium, a10g-small, ...


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Déploiement automatique du Space SolidWorks Viewer (Hugging Face).",
    )
    parser.add_argument(
        "--space-id",
        default=None,
        help="ID du Space (format: username/space-name). Défaut: <username>/solidworks-viewer",
    )
    parser.add_argument(
        "--private",
        action="store_true",
        help="Créer un Space privé (défaut: public)",
    )
    parser.add_argument(
        "--skip-files",
        action="store_true",
        help="Ne pas uploader les fichiers (seulement la création du repo)",
    )
    parser.add_argument(
        "--skip-wait",
        action="store_true",
        help="Ne pas attendre la fin du déploiement",
    )
    parser.add_argument(
        "--sdk",
        default=SPACE_SDK,
        help=f"SDK du Space (défaut: {SPACE_SDK})",
    )
    parser.add_argument(
        "--hardware",
        default=SPACE_HARDWARE,
        help=f"Hardware du Space (défaut: {SPACE_HARDWARE})",
    )
    return parser.parse_args()


def get_username(api: HfApi) -> str:
    info = api.whoami()
    return info["name"]


def create_space(
    api: HfApi,
    space_id: str,
    is_private: bool,
    sdk: str,
    hardware: str,
) -> bool:
    """Crée le Space via huggingface_hub. Retourne True si créé, False s'il existe déjà."""
    print(f"\n🚀 Création du Space: {space_id}")
    print(f"   SDK: {sdk}")
    print(f"   Hardware: {hardware}")
    print(f"   Visibilité: {'privé' if is_private else 'public'}")

    if api.repo_exists(repo_id=space_id, repo_type="space"):
        print(f"⚠️  Le Space {space_id} existe déjà")
        return False

    api.create_repo(
        repo_id=space_id,
        repo_type="space",
        space_sdk=sdk,
        space_hardware=hardware,
        private=is_private,
        exist_ok=True,
    )

    print("✅ Space créé avec succès")
    return True


def upload_files(api: HfApi, space_id: str, source_dir: Path) -> None:
    """Upload tous les fichiers du dossier source vers la racine du Space."""
    print(f"\n📁 Upload des fichiers depuis {source_dir}")

    api.upload_folder(
        repo_id=space_id,
        repo_type="space",
        folder_path=str(source_dir),
        commit_message="Upload des fichiers du Space",
    )

    print("✅ Tous les fichiers ont été uploadés")


def wait_for_deployment(api: HfApi, space_id: str, timeout: int = 600) -> bool:
    """Attend que le Space passe en RUNNING. Timeout en secondes."""
    print(f"\n⏳ Attente du déploiement (timeout: {timeout // 60}min)...")

    start_time = time.time()
    check_interval = 10  # secondes

    while time.time() - start_time < timeout:
        try:
            runtime = api.get_space_runtime(space_id)
            stage = runtime.stage
            print(f"   Status: {stage}")

            if stage == SpaceStage.RUNNING:
                print("✅ Space déployé et opérationnel!")
                return True

            if stage == SpaceStage.RUNTIME_ERROR:
                print(f"❌ Erreur de déploiement: {runtime}")
                return False
        except HfHubHTTPError as exc:
            print(f"   Erreur vérification status: {exc}")

        time.sleep(check_interval)

    print("⏰ Timeout atteint - le déploiement est toujours en cours")
    return False


def main() -> None:
    args = parse_args()

    print("🔧 Déploiement automatique du Space SolidWorks Viewer\n")

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("❌ Variable HF_TOKEN manquante")
        print("   Usage: HF_TOKEN=your_token python scripts/deploy-space.py")
        sys.exit(1)

    source_dir = Path(__file__).resolve().parent.parent / "space-huggingface"
    if not source_dir.is_dir():
        print(f"❌ Dossier source introuvable: {source_dir}")
        sys.exit(1)

    api = HfApi(token=token)

    try:
        # Récupérer le username
        print("📋 Récupération des informations utilisateur...")
        username = get_username(api)

        # Déterminer le spaceId
        space_id = args.space_id or f"{username}/{SPACE_NAME}"
        print(f"🎯 Space ID cible: {space_id}")

        # Créer le Space
        create_space(api, space_id, args.private, args.sdk, args.hardware)

        # Upload des fichiers
        if not args.skip_files:
            upload_files(api, space_id, source_dir)

        if args.skip_wait:
            print(f"\n📍 URL du Space: https://huggingface.co/spaces/{space_id}")
            return

        # Attendre le déploiement
        print("\n🔄 Le déploiement va prendre quelques minutes...")
        print(f"   Vous pouvez suivre la progression sur:")
        print(f"   https://huggingface.co/spaces/{space_id}")

        deployed = wait_for_deployment(api, space_id)

        if deployed:
            print("\n✅ DÉPLOIEMENT TERMINÉ AVEC SUCCÈS!")
            print(f"\n📍 URL du Space: https://huggingface.co/spaces/{space_id}")
            print("\n💡 Pour appeler ce Space depuis votre application:")
            print("   - Utilisez gradio_client (Python) ou @gradio/client (JS)")
            print(f"   - Endpoint: https://{space_id.replace('/', '-')}.hf.space")
            print("\n⚠️  Note: Le Space se met en veille après inactivité.")
            print("   Premier appel = cold start (30-60 secondes)")
        else:
            print("\n⚠️  Déploiement en cours ou échoué - vérifiez les logs manuellement")
            print(f"   https://huggingface.co/spaces/{space_id}/tree/main")

    except HfHubHTTPError as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 402:
            print("\n❌ ERREUR 402: votre compte nécessite un plan payant pour héberger ce Space.")
            print("   Le SDK choisi (Docker/Gradio) tourne sur du compute et requiert:")
            print("   - Un abonnement PRO (compte personnel): https://huggingface.co/pro")
            print("   - Ou Team/Enterprise (organisation).")
            print("\n   Alternatives gratuites:")
            print("   - Static Space (gratuit, mais pas de backend Python possible).")
            print("   - Jusqu'à 2 Spaces Gradio sur ZeroGPU pour un compte personnel gratuit.")
            print("     (nécessite de convertir le Space Docker → Gradio avec `packages.txt` pour FreeCAD)")
        else:
            print(f"\n❌ ERREUR API: {exc}")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ ERREUR CRITIQUE: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
