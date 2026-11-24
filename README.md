# 🎡 Roue des Coalitions

Une roue à tourner pour distribuer des points entre 3 coalitions représentées par des dinosaures — T-rex (vert), tricératops (bleu) et stégosaure (rouge) — … ou des TIG.

35 cases :
- 30 cases coalition : `-50`, `-25`, `0`, `+25`, `+50` × 3 coalitions × 2
- 4 cases TIG (1 TIG chacune) — **1 chance sur 10** au total de tomber sur un TIG
- 1 case **42**, visible mais impossible à obtenir

La taille des cases suit leur probabilité (les cases TIG sont un peu plus fines), sauf la 42 qui prend la place de 2 cases (pour que les TIG tombent pile à 90°) mais a 0 % de chance.

## Utilisation

Ouvre `index.html` dans un navigateur.

- Clique sur **Tourner !** (ou appuie sur Espace)
- Les 4 TIG sont placées comme une boussole (N / E / S / O) ; les autres cases sont mélangées au hasard à chaque chargement et avec **🔀 Mélanger** — jamais deux cases de la même coalition ni deux cases de la même valeur côte à côte
- Le score de chaque coalition et le total de TIG sont gardés (localStorage) avec l'historique des tirages
- « Remettre les scores à zéro » (deux clics) pour repartir de zéro

Les noms, couleurs et cases se modifient en haut du `<script>` (`COALS`, `TIG_CHANCE`, `COA_REPEAT`, `VALUE_ORDERS`).
