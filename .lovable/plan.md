
# Génération procédurale de circuits — Repulsive Curves

Le repo `LasseHenrich/racetrack-generation` (Unity / C#) implémente le papier *"Generating Race Tracks With Repulsive Curves"* (IEEE 2024). L'idée : on part d'une courbe fermée aléatoire, et on la fait évoluer par descente de gradient sur une **énergie de tangente-point** (Yu, Schumacher, Crane 2021) qui repousse la courbe d'elle-même sans qu'elle s'auto-intersecte, sous contraintes (longueur, courbure, surface). Le résultat : des circuits fermés organiques, variés, "arcade".

Je vais porter une version pragmatique en TypeScript et la brancher au `TrackEditor` actuel.

## Ce qui sera ajouté

1. **Module `src/lib/trackGenerator.ts`** — générateur autonome
   - Seed : polygone régulier bruité (N points sur un cercle, jitter radial)
   - Boucle d'optimisation (~100–300 itérations) :
     - calcul du gradient de l'énergie tangente-point sur la polyligne fermée
     - étape de descente avec préconditionneur diagonal (équivalent simplifié du préconditionneur de Sobolev du papier — un vrai solveur fractionnaire est hors scope navigateur)
     - projection sur contraintes : longueur cible, distance min entre segments non adjacents, optionnel bounding-box
     - resampling périodique pour garder des segments de longueur ~uniforme
   - Sortie : tableau de `Vector3` (points de contrôle pour `CatmullRomCurve3` du TrackEditor existant)

2. **Panneau "Generate" dans `TrackEditor.tsx`**
   - Bouton **Generate Track**
   - Sliders : nombre de points (8–40), longueur cible, "repulsion strength", seed (nombre)
   - Bouton **Regenerate** (nouveau seed aléatoire)
   - Le résultat remplace les points de contrôle actuels via l'API existante (`importJSON` / setter interne)

3. **Génération non-bloquante**
   - L'optimisation tourne dans un `requestIdleCallback`/chunks de ~16 ms, avec barre de progression
   - Aperçu live de la courbe pendant l'optim (mise à jour toutes les ~10 itérations)

## Détails techniques

- **Énergie tangente-point** entre segments `i`,`j` :
  `E_ij = |⟨n_i, p_i − p_j⟩|^α / |p_i − p_j|^β`, avec α=3, β=6 (valeurs standard du papier).
  Énergie totale = double somme sur paires non adjacentes, pondérée par longueurs de segments.
- **Gradient** calculé numériquement (différences finies sur chaque vertex) — O(N³) par itération mais N≤40 reste largement temps réel.
- **Contraintes** appliquées par projection après chaque pas :
  - longueur totale → rescale uniforme
  - distance min entre vertices non adjacents → push-apart
- **Resampling** : redistribue les points par abscisse curviligne toutes les ~20 itérations.
- Pas de support des intersections/crossings du papier original (hors scope V1 — circuits planaires fermés simples).

## Hors scope

- Pont/intersections 3D, élévation procédurale, génération de mesh 3D habillé (rochers, herbe). Le générateur produit seulement les points de contrôle ; le rendu reste celui du `TrackEditor` actuel (ruban blanc minimal).
- Préconditionneur de Sobolev fractionnaire complet (remplacé par préconditionneur diagonal — résultats légèrement moins lisses mais convergence OK pour N≤40).

## Fichiers touchés

- nouveau : `src/lib/trackGenerator.ts`
- modifié : `src/components/TrackEditor.tsx` (panneau Generate + appel API)
