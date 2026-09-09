# Conversion SolidWorks locale → bucket Hugging Face

Ce script permet de tester la conversion **avant de déployer le Worker**. La
conversion s’exécute sur votre machine avec le binaire HOOPS Converter local,
puis le script téléverse uniquement les STEP et leurs manifests dans le bucket
`ktongue/ENISE-SITE`.

Le binaire HOOPS et les licences ne sont pas fournis par ce dépôt. Il faut
avoir un package HOOPS Converter autorisé par Tech Soft 3D installé localement.

## 1. Installer la dépendance d’upload

```bash
python3 -m pip install 'huggingface_hub>=1.0.0'
```

## 2. Préparer les secrets dans le terminal

Ne les écrivez pas dans le script et ne les commitez pas :

```bash
export HOOPS_CONVERTER_PATH="$HOME/hoops/bin/converter"
export HOOPS_LICENSE_FILE="$HOME/.config/hoops/license.key"

# Lecture sans affichage ni historique de commande :
read -r -s HF_TOKEN
export HF_TOKEN
echo
```

`HF_TOKEN` doit être un token Hugging Face avec le droit d’écriture dans le
bucket. Si vous utilisez une clé HOOPS plutôt qu’un fichier de licence, vous
pouvez utiliser temporairement :

```bash
read -r -s HOOPS_LICENSE_KEY
export HOOPS_LICENSE_KEY
echo
```

Dans ce cas, ne définissez pas `HOOPS_LICENSE_FILE` en même temps.

## 3. Préparer les fichiers sources

`./bucket-export` est seulement un exemple de dossier local : le script ne le
crée pas et ne télécharge pas automatiquement le bucket. Si les fichiers
SolidWorks ne sont pas encore présents sur la machine, télécharge uniquement
les `.sldprt` et `.sldasm` avec le token HF :

```bash
mkdir -p ./bucket-export
python3 - <<'PY'
import os
from pathlib import Path
from huggingface_hub import HfApi

bucket = "ktongue/ENISE-SITE"
destination = Path("bucket-export")
token = os.environ["HF_TOKEN"]
api = HfApi(token=token)
items = [
    item for item in api.list_bucket_tree(bucket, recursive=True, token=token)
    if getattr(item, "type", "") == "file"
    and Path(item.path).suffix.lower() in {".sldprt", ".sldasm"}
]
if not items:
    raise SystemExit("Aucun fichier .sldprt/.sldasm dans le bucket.")
for item in items:
    target = destination / item.path
    target.parent.mkdir(parents=True, exist_ok=True)
    api.download_bucket_files(
        bucket,
        [(item.path, target)],
        raise_on_missing_files=True,
        token=token,
    )
    print(target)
PY
```

Tu peux aussi simplement utiliser le vrai dossier contenant déjà tes fichiers :

```bash
find . -type f \( -iname '*.sldprt' -o -iname '*.sldasm' \) -print
```

## 4. Tester sans téléverser

Supposons que `./bucket-export` soit maintenant une copie locale de
l’arborescence du bucket :

```bash
python3 scripts/convert-solidworks-local.py \
  --root ./bucket-export \
  --output-mode original \
  --local-output-dir ./converted-step \
  --no-xvfb
```

Le script trouve récursivement les `.sldprt` et `.sldasm`, produit les STEP et
un manifest local dans `./converted-step` et conserve les dossiers. Par exemple :

```text
bucket-export/GM/piece.sldprt
→ converted-step/GM/piece.step
→ converted-step/GM/piece.step.json
```

Pour un assemblage, les `.sldprt` et sous-assemblages du même dossier et de ses
sous-dossiers sont copiés dans le workspace temporaire HOOPS. Ils ne sont pas
écrits dans le bucket une seconde fois.

Retirez `--no-xvfb` si HOOPS a besoin de Xvfb et que `xvfb-run` est installé.

## 5. Vérifier puis téléverser

Après vérification des fichiers dans `./converted-step`, relancez avec
`--upload` :

```bash
python3 scripts/convert-solidworks-local.py \
  --root ./bucket-export \
  --bucket-id ktongue/ENISE-SITE \
  --output-mode original \
  --local-output-dir ./converted-step \
  --upload \
  --no-xvfb
```

Les objets écrits sont :

```text
GM/piece.step
GM/piece.step.json
```

Le fichier source `GM/piece.sldprt` n’est pas modifié. Le manifest contient les
SHA-256 du source, des dépendances et du STEP.

## Préfixe local

Si le dossier local correspond déjà au dossier `GM` du bucket :

```bash
python3 scripts/convert-solidworks-local.py \
  --root ./GM \
  --bucket-prefix GM \
  --output-mode original \
  --upload
```

Si le dossier local correspond à la racine du bucket, ne mettez pas
`--bucket-prefix`.

## Convention du Worker

Le site utilise normalement une autre destination pour éviter de mélanger les
sources et les dérivés :

```bash
python3 scripts/convert-solidworks-local.py \
  --root ./bucket-export \
  --output-mode derived \
  --upload
```

Cela écrit par exemple :

```text
derived/step/GM/piece.step
derived/step/GM/piece.step.json
```

`--output-mode original` est prévu pour votre demande de dépôt à côté du
fichier source ; le Worker réutilise ce résultat s’il trouve le manifest. Le
mode `--output-mode derived` reste compatible avec la convention de cache du
Worker et de l’interface web.

## Options utiles

```text
--input fichier.sldprt       Un seul fichier
--source-root dossier        Racine des dépendances pour --input
--force                      Reconvertir même si le STEP local existe déjà
--continue-on-error          Continuer un lot malgré une erreur
--step-export-format 2       AP242 (0=AP203, 1=AP214)
--max-dependency-files 64    Limite d’assemblage
--max-bundle-bytes 262144000 Limite source + dépendances
```

Le script n’utilise pas le token du navigateur et ne demande pas de token au
frontend. Pour la conversion locale, seul le terminal et le bucket HF sont
utilisés.
