# Parcours de lecture et d’annotation inspiré d’alphaXiv

## Décision

**Conserver PDF.js et le lecteur documentaire d’ENISE Docs, puis reproduire le parcours de lecture, pas le site ni une dépendance à alphaXiv.** Le [lecteur unifié](PDF_UNIFIED_READER.md) possède déjà la page PDF, la sélection de texte, les notes et surlignages privés, l’assistant et les citations cliquables. Cela permet de traiter les documents ENISE sans envoyer le PDF à alphaXiv, sans changer les URL et sans réécrire la couche de permissions. Aucun SDK officiel d’annotation alphaXiv n’a été identifié dans [l’étude précédente](PDF_ANNOTATION_FEASIBILITY.md). Le prototype EmbedPDF y répondait à un besoin de rendu/édition PDF, pas à lui seul au parcours d’étude ni à la synchronisation. On ne le réévalue que si l’export PDF annoté ou les outils de dessin deviennent prioritaires.

Depuis Finder, afficher la **Prévisualisation** et sélectionner un PDF, puis choisir **Annoter et interroger le PDF**. Le lecteur plein écran conserve l’original au centre. Les notes persistent seulement si le compte et le stockage Appwrite sont configurés ; les réponses dépendent du moteur IA et de l’API déployés. Cette entrée n’ajoute ni annotation publique, ni activation de services de production.

## Expérience cible

| Geste | Comportement |
|---|---|
| Sélectionner un passage dans une page | Une barre ancrée propose **Surligner**, **Ajouter une note**, **Expliquer** et **Poser une question**. Elle reste utilisable au clavier et ne recouvre pas la sélection. |
| Surligner / prendre une note | L’annotation apparaît sur le PDF et dans le volet **Notes**. Un clic dans ce volet ramène à la page et au passage. Notes et surlignages restent privés par défaut. |
| Expliquer le passage | Le volet **Assistant** s’ouvre avec la citation et son périmètre (« sélection », « page » ou « document ») visibles avant envoi. La réponse arrive en flux, avec annulation. Cliquer sur une citation ramène à la page, et au passage exact uniquement si une ancre existe. |
| Poser une question sur tout le PDF | La recherche combine les passages de Docling de la même révision, s’ils existent, et le texte extrait par PDF.js en repli. Si l’index est incomplet ou le PDF scanné, l’interface affiche la couverture et ne présente pas une réponse partielle comme exhaustive. |
| Revenir au document plus tard | Le volet recharge les annotations autorisées pour le compte. Si la révision a changé, les anciennes annotations sont marquées « à vérifier », sans déplacement silencieux sur le nouveau PDF. |

Sur ordinateur : séparer **Notes** et **Assistant** par des onglets latéraux. Sur petit écran : conserver la page en plein écran et utiliser un panneau inférieur repliable. La page, le zoom et la position de lecture ne doivent pas changer quand on ouvre un panneau.

## Plan proposé et critères de livraison

1. **Parité du parcours texte.** Consolider la barre de sélection et l’accès à Notes/Assistant dans `src/reader/DocumentWorkspace.jsx` et les composants PDF existants. Réutiliser l’ancre `pdf-anchor/v1` (révision, page, texte cité, quadrilatères en coordonnées PDF). Tester une sélection multipage, une rotation, une sauvegarde/relecture et un retour vers le passage. Aucun changement de schéma ni mutation du document original.
2. **Citations vérifiables et confidentialité.** Conserver le flux IA dans le backend Go. Résoudre l’identifiant du document, sa révision et les pages côté serveur. Pour les extraits Docling, vérifier la citation dans l’artefact de la même révision ; pour un extrait fourni par le lecteur, marquer explicitement sa provenance si le serveur ne peut pas le vérifier. Limiter les extraits envoyés, ne jamais injecter les notes privées par défaut ni les journaliser, et traiter le contenu extrait comme des données, pas comme des instructions au modèle. Refuser ou signaler les références sans preuve plutôt que de générer une page fictive. Tester annulation, indisponibilité Docling, citation invalide, PDF scanné et isolation entre deux comptes.
3. **Zones, dessin et export séparés.** Après validation du texte, ajouter un type d’ancre géométrique versionné pour rectangles ou tracés, attaché à la page et à la révision, avec des limites sur le nombre de points. Prévoir un export privé JSON avant d’envisager une copie PDF annotée. Ne pas écraser l’original. Le partage et les discussions publiques sont un lot distinct : ils nécessitent des ACL explicites, consentement et modération, pas un changement de visibilité par défaut.

**Pilote conseillé :** un PDF natif de cours, un PDF long et un PDF scanné, avec deux comptes distincts sur le projet Appwrite de test. Valider le même scénario sur Chromium, Safari/WebKit et les WebViews de l’application, avec Docling disponible puis coupé. Activer avec `VITE_READER_ROLLOUT=pilot` sur une liste de chemins. Les règles de déploiement, de sauvegarde et de retour arrière sont dans [DEPLOY_PDF_UNIFIED.md](DEPLOY_PDF_UNIFIED.md). Les étapes ci-dessus sont une proposition d’implémentation ; elles ne signifient pas que l’export, le dessin ou la vérification serveur des citations client sont déjà livrés.
