# HIPPODATA — PMU rapports probables — V20.11

## Artefact
PMU_extraction_couples_probables_REUNION_AGREGEE_V20.11.user.js

## Correction isolée
- Extraction du rapport probable par relation DOM exacte dans le dialogue PMU ouvert.
- Le libellé « Rapport probable du e-Couplé Gagnant pour 1 € » est recherché dans le dialogue.
- Le montant est lu dans son élément frère dédié au montant.
- Aucun filtrage de « 1 € » : une valeur de rapport à 1 € reste valide.
- Navigation, clics, boucle des couples, cale, agrégation et export réunion conservés.

## Diagnostic de référence
Inspection DOM V2 : le libellé et la valeur du rapport sont deux éléments frères dans le même conteneur ; le montant est donc isolable sans heuristique visuelle.

## Validation
- Syntaxe JavaScript vérifiée avec Node.js --check.
- SHA-256 de l'artefact local validé : e533fff9fea73bb41026dee2e5c7a042661c30c9913321aecd9d9c1b84550697
