# Parcours de lecture et d’annotation inspiré d’alphaXiv

## Décision

**Conserver PDF.js et le lecteur documentaire d’ENISE Docs, puis reproduire le parcours de lecture, pas le site ni une dépendance à alphaXiv.** Le [lecteur unifié](PDF_UNIFIED_READER.md) possède déjà la page PDF, la sélection de texte, les notes et surlignages privés, l’assistant et les citations cliquables. Cela permet de traiter les documents ENISE sans envoyer le PDF à alphaXiv, sans changer les URL et sans réécrire la couche de permissions. Aucun SDK officiel d’annotation alphaXiv n’a été identifié dans [l’étude précédente](PDF_ANNOTATION_FEASIBILITY.md). Le prototype EmbedPDF y répondait à un besoin de rendu/édition PDF, pas à lui seul au parcours d’étude ni à la synchronisation. On ne le réévalue que si l’export PDF annoté ou les outils de dessin deviennent prioritaires.

Depuis Finder, afficher la **Prévisualisation** et sélectionner un PDF, puis choisir **Annoter et interroger le PDF**. Le lecteur plein écran conserve l’original au centre. Les notes persistent seulement si le compte et le stockage Appwrite sont configurés ; les réponses dépendent du moteur IA et de l’API déployés. Cette entrée n’ajoute ni annotation publique, ni activation de services de production.

## Parcours implémenté

| Geste | Comportement |
|---|---|
| Sélectionner un passage dans une page | Une barre ancrée propose **Surligner**, **Ajouter une note**, **Expliquer** et **Poser une question**. Elle reste utilisable au clavier et ne recouvre pas la sélection. |
| Surligner / prendre une note | L’annotation apparaît sur le PDF et dans le volet **Notes**. Un clic dans ce volet ramène à la page et au passage. Notes et surlignages restent privés par défaut. |
| Expliquer le passage | Le volet **Assistant** s’ouvre avec la question préremplie et le passage visible. L’envoi est explicite et le périmètre peut être changé (« sélection », « page » ou « document »). La réponse arrive en flux, avec annulation. Cliquer sur une citation ramène à la page, et au passage exact uniquement si une ancre existe. |
| Poser une question sur tout le PDF | La recherche privilégie les passages de Docling lorsque le SHA-256 du manifeste correspond aux octets de la révision ouverte ; sinon, elle utilise les extraits PDF.js disponibles. Une sélection explicite ne transmet que le passage affiché. Si l’index est incomplet ou le PDF scanné, l’interface affiche la couverture et ne présente pas une réponse partielle comme exhaustive. |
| Revenir au document plus tard | Le volet recharge les annotations autorisées pour le compte. Si la révision a changé, les anciennes annotations sont marquées « à vérifier », sans déplacement silencieux sur le nouveau PDF. |

Les aperçus PDF ouverts depuis la conversation de bibliothèque passent eux aussi par PDF.js, sans le fond sombre du lecteur natif du navigateur.

Sur ordinateur : séparer **Notes** et **Assistant** par des onglets latéraux. Sur petit écran : conserver la page en plein écran et utiliser un panneau inférieur repliable. La page, le zoom et la position de lecture ne doivent pas changer quand on ouvre un panneau.

## Annotations graphiques et confidentialité

- **Zone** et **Tracer** : glisser sur une page, puis choisir la couleur et, si besoin, ajouter une note. L’ancre `pdf-geometry/v1` stocke un rectangle ou jusqu’à 160 points en coordonnées PDF, dissociés du texte et liés à la révision. Ces annotations utilisent les mêmes lignes privées Appwrite que les notes et surlignages, sans migration de l’enum.
- **Notes → Exporter mes annotations (JSON)** : téléchargement local des annotations chargées pour ce PDF, avec leur révision et leur statut. Le PDF original n’est jamais modifié. Le fichier exporté contient des données privées : ne le partagez que volontairement.
- L’assistant ne reçoit ni notes, ni zones, ni tracés. Le panneau conserve les messages quand on le replie, mais le fil PDF n’est pas enregistré dans l’historique du compte et les échanges précédents ne sont pas renvoyés au modèle. Les questions et extraits effectivement envoyés sont transmis au fournisseur IA configuré.
- **Docling vérifié** signifie que l’extrait vient d’un artefact de la même révision, pas que l’OCR est exact ou la couverture exhaustive. La sélection PDF.js et ses coordonnées sont déclarées par le navigateur. La citation ne ramène qu’à la page quand aucune géométrie fiable n’est disponible. Aucun OCR à la demande n’est déclenché.

**Pilote conseillé :** un PDF natif de cours, un PDF long et un PDF scanné, avec deux comptes distincts sur le projet Appwrite de test. Vérifier Safari/WebKit et les WebViews natives, avec Docling disponible puis coupé. Activer avec `VITE_READER_ROLLOUT=pilot` sur une liste de chemins. Voir [DEPLOY_PDF_UNIFIED.md](DEPLOY_PDF_UNIFIED.md) pour le déploiement et le retour arrière. La copie PDF annotée et le partage public restent hors périmètre.
