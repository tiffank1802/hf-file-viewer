# Remplacer le lecteur PDF natif par un lecteur annotable

> Étude historique du choix de moteur. Le dépôt dispose désormais du lecteur unifié PDF.js. Pour le parcours d’annotation et d’assistant recommandé aujourd’hui, voir [la proposition inspirée d’alphaXiv](PARCOURS_LECTURE_ALPHAXIV.md).

**Verdict : faisable, mais la piste alphaXiv n’est pas confirmée.** Je n’ai pas identifié dans les dépôts publics d’[alphaXiv](https://github.com/orgs/alphaXiv/repositories) un SDK de visualisation et d’annotation PDF à intégrer à React pour des fichiers arbitraires. Cette recherche ne prouve pas qu’il n’existe pas : un lien vers le dépôt permettrait de vérifier sa licence et ses API. Le lecteur en production reste inchangé.

## Vérifications côté alphaXiv

| Projet | Ce qu’il fournit | Convient au remplacement ? |
| --- | --- | --- |
| [alphaXiv/feedback](https://github.com/alphaXiv/feedback) | Suivi des demandes et des problèmes du site alphaXiv. | Non, ce n’est pas le code du lecteur. |
| [alphaXiv/OpenResearch](https://github.com/alphaXiv/OpenResearch) | Application et CLI pour agents de recherche. | Pas de composant de lecture et d’annotation PDF autonome identifié. |
| [Companion-Inc/alpha-hub](https://github.com/Companion-Inc/alpha-hub) | Client/CLI non officiel : recherche, rapports et notes locales attachées à un identifiant d’article. | Non, ces notes ne sont pas des annotations positionnées dans un PDF Hugging Face. |
| [AsyncFuncAI/alphaxiv-open](https://github.com/AsyncFuncAI/alphaxiv-open) | Application tierce pour discuter d’articles arXiv. | Non, ce n’est pas un SDK de lecteur PDF. |

## Solution recommandée : EmbedPDF

[`@embedpdf/viewer-react`](https://github.com/embedpdf/embed-pdf-viewer) fournit un lecteur React avec sélection, recherche, zoom et outils d’annotation. Le [SDK client est sous licence Apache-2.0](https://github.com/embedpdf/embed-pdf-viewer/blob/main/LICENSING.md) ; le serveur CloudPDF (licence distincte) n’est pas nécessaire pour le moteur local PDFium.

**Prototype isolé, hors du code livré :** `@embedpdf/viewer-react@3.3.0`, React 19, build Vite 8, Chromium et un vrai PDF de test servi par une route locale `/api/file?path=fixture.pdf`. Avec la CSP actuelle, le navigateur télécharge le Wasm mais refuse de l’exécuter. Avec seulement `'wasm-unsafe-eval'` ajouté à `script-src` dans les réponses du prototype, le PDF s’affiche et les outils Annoter (surligneur, dessin, notes) sont disponibles. Aucune requête vers un autre domaine n’a été observée sur ce parcours. Le fichier PDFium du build pèse environ **7,9 Mo brut / 3,2 Mo gzip** : charger cette interface seulement à l’ouverture du lecteur, pas à l’arrivée sur le site ni à chaque sélection dans le Finder. La persistance, l’export des annotations et le comportement avec les gros fichiers restent à valider avant adoption.

**Alternative :** [Mozilla PDF.js](https://github.com/mozilla/pdf.js), Apache-2.0. Intéressant pour héberger un lecteur générique ou maîtriser son interface en profondeur ; comparer le coût de personnalisation de la visionneuse, la couverture des annotations et l’export avec EmbedPDF. Ce candidat n’a pas été prototypé ici.

## Intégration progressive

1. **Lecteur distinct, activé par une option de test.** Charger le lecteur React de manière différée dans `PreviewModal.jsx`, pour `file.kind === 'pdf'` seulement. Ouvrir `fileProxyUrl(file.path)` sur la même origine. Conserver « Lecteur du navigateur » et « Télécharger l’original » comme repli. Ne pas instancier le moteur Wasm dans le volet de prévisualisation du Finder. L’aperçu PDF des conversions Office (`ConvertedPdfViewer.jsx`, URL Blob) est un périmètre séparé.
2. **Déploiement et limites.** Servir le worker, le Wasm et les ressources sur la même origine. Tester le type MIME et les en-têtes Cloudflare et Go ; la CSP statique est définie dans `public/_headers` et `backend/internal/api/server.go`. Préférer une page dédiée si elle permet d’isoler l’autorisation Wasm à ce lecteur, et ne pas ajouter `'unsafe-eval'` pour JavaScript. Mesurer le temps d’ouverture, la mémoire et les requêtes `Range` avec des PDF longs : les proxys existants les prennent en charge, mais le comportement du SDK sur de gros PDF doit être confirmé.
3. **Première version sans écriture serveur.** Annoter la copie ouverte dans le navigateur et proposer l’export d’un PDF annoté. Ne pas modifier le PDF source, ne pas envoyer le contenu à alphaXiv ou à CloudPDF et ne pas promettre de sauvegarde automatique. Vérifier qu’un PDF exporté et rouvert dans un autre lecteur conserve les annotations attendues ; tester aussi la rotation, les PDF scannés, les fichiers protégés, le clavier, le tactile et Safari.
4. **Synchronisation facultative.** Si elle est demandée, stocker les annotations séparément dans un espace privé Appwrite, avec une politique d’accès côté serveur et une clé de version du fichier (par exemple chemin + ETag fiable). En cas de remplacement du PDF, ne pas réappliquer automatiquement les annotations à une autre pagination. Le partage ou l’édition collaborative n’est pas fourni par le moteur local.

**Décision conseillée :** commencer par une option expérimentale EmbedPDF après validation de l’export et de la CSP de déploiement. Sans lien pour un SDK alphaXiv confirmé, ne pas intégrer les API de recherche alphaXiv à la place du lecteur PDF.
