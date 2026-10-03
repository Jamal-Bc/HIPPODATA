# HIPPODATA — PMU rapports probables — V20.8

## Artefact
PMU_extraction_couples_probables_REUNION_AGREGEE_V20.8.user.js

SHA-256:
7a0760152c0dd9584f810d7f5a1e3145e7042fa6b847de1aabd7c6ee356c9215

## Modifications V20.8
- Suppression du message d'interface « CSV construit… » après export réussi.
- Conservation du téléchargement natif Blob → URL.createObjectURL → <a download>, validé sur Android/Firefox lors du test indépendant.
- Remplacement de la lecture fragile du rapport probable via nextElementSibling par une recherche de la valeur monétaire visible située dans la zone du panneau « Rapport probable du… ».
- Navigation, clics, cale, reprise, agrégation et mécanisme d'arrêt/sauvegarde conservés.

## Base
V20.7 — test réel rapports probables / cale / CSV.

## Test technique
Syntaxe JavaScript vérifiée avec Node.js (--check).
