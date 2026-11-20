## Télécharger ENISE Docs

| Plateforme | Fichier principal |
|---|---|
| Windows 10/11, 64 bits | `ENISE-Docs-windows-x64-setup.exe` (ou `.msi`) |
| macOS 11+, Apple Silicon et Intel | `ENISE-Docs-macos-universal.dmg` |
| Android 7+ | `ENISE-Docs-android-universal.apk` |
| iOS 14+ | `ENISE-Docs-ios-unsigned.ipa` (**non signé**) |

**Ces fichiers sont des versions de test**, pas des applications publiées sur les stores.

- Windows SmartScreen et macOS Gatekeeper peuvent afficher un avertissement : les versions desktop ne sont pas signées/notariées avec un certificat de distribution officiel.
- L’APK Android s’installe hors Play Store. Sans clé de signature stable conservée entre les builds, une mise à jour peut nécessiter de désinstaller la version précédente. Le fichier `.aab` n’est pas un APK et doit être signé avant une diffusion sur Google Play.
- L’IPA iOS ne peut pas être installé directement : sa signature et un profil Apple approprié sont nécessaires. L’archive du simulateur est réservée à Xcode sur Mac Apple Silicon.
- `SHA256SUMS.txt` permet de vérifier l’intégrité des fichiers après téléchargement.
