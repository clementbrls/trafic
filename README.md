# trafic.

Un jeu de gestion de trafic minimaliste pour le navigateur, inspiré de *Mini Motorways* et de *Cities: Skylines + TM:PE*.
Trace des routes pour relier chaque maison au bâtiment de sa couleur, puis garde la ville fluide pendant qu'elle grandit.

Le jeu tourne **entièrement côté client** (aucun serveur) : ordinateur, tablette et téléphone, en portrait comme en paysage. Une fois ajouté à l'écran d'accueil, il fonctionne hors-ligne.

## Jouer

```bash
npm install
npm run dev
```

Ouvre l'adresse affichée (`http://localhost:5173`). Pour tester sur ton téléphone, connecte-le au même Wi-Fi et ouvre l'adresse « Network » affichée par Vite (le serveur écoute déjà sur le réseau local).

## Principe

- Chaque **maison** possède deux voitures. Les **bâtiments** génèrent des demandes (points blancs) que les voitures de leur couleur viennent satisfaire : chaque livraison rapporte 1 point.
- Si un bâtiment accumule trop de demandes, un compte à rebours démarre. S'il arrive au bout, la partie est perdue.
- Chaque **semaine**, la ville s'agrandit, tu reçois des routes et tu choisis une amélioration.

### Mécaniques de trafic

| Élément | Effet |
| --- | --- |
| **Rue** | Route standard, 1 route par case. |
| **Avenue** (semaine 2) | Plus rapide et **prioritaire** : aux carrefours, les rues lui cèdent le passage. Coûte 2 routes par case. |
| **Sens unique** (semaine 2) | Tracé dans le sens du glisser, flèches sur la chaussée. Supprime des conflits aux carrefours. |
| **Carrefour** | Une route traversante (2 branches de la classe la plus haute) est prioritaire ; quand 3 routes équivalentes ou plus se croisent, le carrefour fonctionne comme un **stop** (chacun s'arrête). |
| **Rond-point** | Plusieurs voitures circulent en même temps, les entrants cèdent le passage à l'anneau. |
| **Feux** | Phases alternées, adaptatives selon la demande. |
| **Autoroute** | Voie rapide en ligne droite qui passe au-dessus de tout. |
| **Pont** | Se pose automatiquement quand tu traces au-dessus de l'eau. |
| **Règles** (semaine 3) | Un tap sur un carrefour y interdit les tourne-à-gauche : moins de conflits, trajets plus longs. |
| **Vue trafic** | Colore les routes selon la congestion (vert → rouge). |
| **Heure de pointe** | La demande suit un rythme hebdomadaire : fin de semaine chargée, week-end calme. |

Repasser sur une route existante avec un autre type la transforme (une rue devient avenue, un sens unique redevient double sens…).

### Contrôles

- **Souris** : clic gauche pour tracer, clic droit pour effacer, molette pour zoomer, clic milieu (ou Maj + glisser) pour déplacer la vue.
- **Tactile** : un doigt pour tracer, deux doigts pour déplacer / zoomer, gomme pour effacer.
- **Clavier** : `Espace` pause · `1`–`6` outils · `T` type de route · `V` vue trafic · `F` vitesse · `C` recentrer · `Échap` menu.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement (accessible sur le réseau local). |
| `npm run build` | Vérification TypeScript + build de production dans `dist/`. |
| `npm run preview` | Sert le build de production. |
| `npm test` | Tests (réseau routier, itinéraires, simulation, carrefours). |
| `BALANCE=1 npx vitest run tests/balance.test.ts` | Sondes d'équilibrage (un bot joue plusieurs parties). |

Le dossier `dist/` est un site statique : il peut être déployé tel quel sur GitHub Pages, Netlify, itch.io, etc. (les chemins sont relatifs).

## Architecture

```
src/
  core/        maths, PRNG, polylignes, tas binaire
  game/
    network.ts    graphe routier (nœuds sur la grille, liens 8 directions, ponts, autoroutes)
    geometry.ts   trajectoires des voies (courbes, ronds-points, zones de conflit)
    pathfind.ts   A* sur (nœud, bras d'arrivée) : sens uniques, interdictions de tourner
    traffic.ts    voitures, files, carrefours (tickets, priorités, stops, feux, ronds-points), parkings
    game.ts       apparitions, demande, semaines, améliorations, inventaire
    builder.ts    outils de construction (tracé, gomme, types de routes, annulation d'un tracé)
    autobuild.ts  petit bot constructeur (ville de démo du menu, tests)
  render/      rendu Canvas 2D (terrain, routes, bâtiments, voitures, effets), caméra
  ui/          HUD et menus en DOM
  audio.ts     sons et musique générative (WebAudio, aucun fichier audio)
  input.ts     souris / tactile / pincement
```

La simulation avance à pas fixe (60 Hz). Chaque voiture suit une liste de segments ; les voitures partageant un segment partagent une voie. Aux carrefours, une voiture doit obtenir un « ticket » : il est accordé si aucun mouvement en conflit n'est en cours, si la sortie a de la place (jamais de voiture bloquée au milieu du carrefour) et selon les priorités (route traversante, stop, feux, anneau du rond-point).
