# Partage automatisé des carnets OneNote (`share-onenote-links.py`)

Crée des liens **« Toute personne disposant du lien peut afficher »** via
Microsoft Graph, puis met à jour les `.url` correspondants (localement et/ou
directement dans le bucket Hugging Face).

## 1. Créer l’application Entra ID (une fois, gratuit, ~5 min)

1. Aller sur [portal.azure.com](https://portal.azure.com/) → **Microsoft Entra ID**
   (ou « Azure Active Directory ») → **App registrations** → **New registration**.
2. Nom : `enise-docs-sharing` (libre).
3. **Supported account types** : choisir
   **« Accounts in any organizational directory and personal Microsoft accounts »**
   (indispensable si les carnets sont sur un compte perso `outlook`/`hotmail`/`live`).
4. **Redirect URI** : rien à renseigner (device code flow).
5. Créer, puis noter l’**Application (client) ID**.
6. Menu **Authentication** → **Advanced settings** → **Allow public client flows** :
   passer sur **Yes** → Save (requis pour le device code flow).
7. Menu **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → cocher **`Files.ReadWrite.All`** → Add.
   - Compte école/entreprise : cliquer **Grant admin consent** (ou demander à l’admin).
   - Compte personnel : le consentement sera demandé à la première exécution.

Aucun secret client n’est nécessaire (application publique, device code flow).

## 2. Installer les dépendances

```bash
pip install msal requests huggingface_hub
```

`huggingface_hub` n’est requis que pour `--hf-repo` / `--upload`.

## 3. Utilisation

```bash
# 3a. Simulation : vérifie la résolution sans rien créer ni écrire
python scripts/share-onenote-links.py --client-id APP_ID --source-dir ./urls --dry-run

# 3b. Réel, .url réécrits en local
python scripts/share-onenote-links.py --client-id APP_ID --source-dir ./urls --output-dir ./urls-partages

# 3c. Lecture + réécriture directe dans le bucket (token HF en écriture)
HF_TOKEN=hf_xxx python scripts/share-onenote-links.py --client-id APP_ID \
  --hf-repo ktongue/ENISE-SITE --upload
```

À la première exécution, le script affiche un code à valider sur
[microsoft.com/devicelogin](https://www.microsoft.com/devicelogin) ; le jeton
est ensuite mis en cache (`~/.cache/enise-docs/msal-cache.json`, jamais dans Git).

Options utiles : `--authority consumers` (app perso uniquement), `--link-type edit`
(lien en modification plutôt qu’en lecture), `--dry-run`.

## 4. Dépannage

| Symptôme | Cause probable |
|---|---|
| `Device flow refusé` | « Allow public client flows » non activé (étape 6) |
| `AADSTS50020` / compte refusé | Mauvais « Supported account types » (étape 3) ou mauvaise `--authority` |
| `Need admin approval` | Compte pro : consentement admin requis (étape 7) |
| `createLink 400 : ... not allowed` | La policy OneDrive/SharePoint interdit les liens « Anyone » |
| `[SKIP] protocole non web` | Cible `onenote://` ou `file://` : partage manuel requis |
| `[FAIL] ... /shares` | URL non résolvable (lien obsolète, élément supprimé ou déplacé) |

## 5. Sécurité

- Ne commitez jamais `APP_ID` secret (l’ID seul n’est pas sensible, mais
  restez discret), ni `HF_TOKEN`, ni le cache MSAL : tout passe en arguments
  ou variables d’environnement.
- Les liens « Anyone » rendent les carnets lisibles par **quiconque a le lien** :
  réservez-les aux contenus destinés à la bibliothèque publique.
- Code de sortie : `1` si au moins un fichier est en échec, `2` en cas
  d’usage incorrect ou de dépendance manquante.
