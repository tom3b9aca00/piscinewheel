// Règles de la roue — partagées par le serveur (tirage) et la page (affichage).
// Modifie ici puis redémarre le serveur.
(function (root) {
  const WHEEL_RULES = {
    coalitions: ["a", "b", "c"],          // clés des coalitions (noms/couleurs/dinos dans public/index.html)
    values: [-50, -25, 0, 25, 50],        // points possibles
    repeat: 2,                            // chaque (coalition, valeur) est présente 2 fois sur la roue
    tigCount: 4,                          // nombre de cases TIG (placées en boussole)
    tigChance: 0.10,                      // probabilité totale de tomber sur un TIG
    cooldownS: 30,                        // attente entre deux tirages, par personne
    spinMs: 10800,                        // durée de l'animation (5000 + 4500 + 1300)
  };
  if (typeof module !== "undefined") module.exports = WHEEL_RULES;
  else root.WHEEL_RULES = WHEEL_RULES;
})(this);
