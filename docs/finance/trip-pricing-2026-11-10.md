# Tarification des trajets Zwanga

Règle initiale du **10 novembre 2026**, tarifs normaux par véhicule ajustés le **13 novembre 2026**. Version API `2026-11-13`. Préparée localement, non déployée par cette intervention.

## Grille tarifaire

Les montants sont en francs congolais (FC, code monétaire CDF). Le contrat actuel de l’API est **par place**, et non par véhicule. Les tarifs normaux diffèrent par type ; les limites de places ne changent pas. Les montants demandés de 1 200 et 1 000 FC sont appliqués au kilomètre en conditions normales. Les autres règles existantes sont conservées, sans inventer de nouveaux tarifs majorés pour les motos.

| Élément | Règle |
| --- | --- |
| Minimum | **2 500 FC par place** |
| Voiture, conditions normales | **1 500 FC/km par place** |
| Moto 2 roues, conditions normales | **1 200 FC/km par place** |
| Moto 3 roues, conditions normales | **1 000 FC/km par place** |
| Circulation lourde ou forte pluie | **2 000 FC/km par place** |
| Retard en circulation lourde | **120 FC/min de retard par place**, en supplément |

Le tarif de 2 000 FC/km **remplace** le tarif normal du type choisi. Il ne s’y ajoute pas. Il reste commun aux trois types. La présence simultanée de pluie et d’embouteillages ne double pas la majoration.

## Quand la circulation est considérée comme lourde

Deux conditions doivent être réunies :

1. La durée avec circulation est supérieure ou égale à **125 % de la durée normale**.
2. Le retard est d’au moins **5 minutes**.

Ces seuils sont inclusifs : 20 minutes normalement et 25 minutes avec circulation constituent une circulation lourde. En revanche, 50 minutes normalement et 60 minutes avec circulation ne suffisent pas : l’augmentation n’est que de 20 %.

Le retard est la différence positive entre la durée avec circulation et la durée normale. **Les 120 FC ne portent jamais sur toute la durée du trajet.** Sous le seuil de circulation lourde, aucun supplément par minute n’est appliqué, même si la pluie active le tarif kilométrique majoré.

## Formule

```text
retard = max(0, durée avec circulation − durée normale)

tarif kilométrique = 2 000 FC si circulation lourde OU forte pluie
                    sinon : voiture 1 500 FC, moto 2 roues 1 200 FC,
                           moto 3 roues 1 000 FC

supplément de retard = 120 × retard en minutes si circulation lourde
                      0 sinon

prix estimé par place = max(2 500,
                           distance en km × tarif kilométrique
                           + supplément de retard)

total estimé = prix estimé par place × nombre de places demandées
```

Le serveur arrondit la part kilométrique et le supplément au franc le plus proche, puis applique le minimum. Les fractions de minute sont calculées proportionnellement : 5 min 15 s de retard donnent **630 FC**, pas six minutes facturées.

## Exemples

| Situation | Calcul pour une place | Montant |
| --- | --- | --- |
| 1 km, conditions normales | max(2 500, 1 × 1 500) | **2 500 FC** |
| 5 km, voiture, conditions normales | 5 × 1 500 | **7 500 FC** |
| 5 km, moto 2 roues, conditions normales | 5 × 1 200 | **6 000 FC** |
| 5 km, moto 3 roues, conditions normales | 5 × 1 000 | **5 000 FC** |
| 5 km, forte pluie, sans retard | 5 × 2 000 | **10 000 FC** |
| 5 km, durée normale 20 min, durée avec trafic 30 min | 5 × 2 000 + 10 × 120 | **11 200 FC** |
| Même trajet, pluie et circulation lourde | même calcul, sans deuxième majoration | **11 200 FC** |
| Même trajet, deux places | 11 200 × 2 | **22 400 FC** |

## Origine des données et fonctionnement dégradé

- **Distance et circulation :** Google Directions, avec une heure de départ fournie pour demander la durée avec trafic. Les réponses liées au trafic sont mises en cache pendant 60 secondes, séparément des itinéraires statiques. Le champ de durée avec trafic dépend de la disponibilité du fournisseur : [documentation Google Directions](https://developers.google.com/maps/documentation/directions/get-directions).
- **Météo :** le service météo existant détecte la forte pluie dans les zones couvertes autour du départ et de l’arrivée. Le seuil configuré est conservé, avec 7,6 mm/h par défaut et les codes météo de fortes pluies/orages déjà pris en charge. « Mauvais temps » correspond donc actuellement à cette détection, pas à n’importe quel ciel couvert.
- **Trafic absent, invalide ou incomplet sur l’itinéraire :** retard inconnu, aucun supplément de retard et aucune majoration pour embouteillage. Une forte pluie connue peut toujours déclencher 2 000 FC/km.
- **Météo absente ou zone non couverte :** aucune majoration météo inventée. Un trafic lourd connu peut toujours déclencher la grille majorée.
- **Google indisponible :** le calcul peut utiliser la distance à vol d’oiseau existante, explicitement signalée comme approximative. Cette distance peut sous-estimer le parcours routier ; elle ne fournit aucune information de circulation.
- **Aucune distance exploitable :** aucun prix automatique fictif. Le passager doit saisir explicitement un budget d’au moins 2 500 FC par place.

Les conditions sont celles disponibles **au moment de l’estimation**. Ce mécanisme n’est ni une prévision météo pour un départ futur, ni un compteur de retard réellement constaté à l’arrivée.

## Affichage, confirmation et historique

Les endpoints de recommandation et de choix des véhicules retournent le prix par place, le total et un objet `pricing` : version de grille, minimum, tarif kilométrique appliqué, retard connu, secondes facturables, supplément, conditions et source de distance.

- `POST /trip-requests/recommended-price` : estimation pour le type sélectionné.
- `POST /trip-requests/vehicle-options` : estimation pour les différents types et leur capacité.

Ces chemins sont relatifs au préfixe de l’API existante et nécessitent l’authentification habituelle.

Le mobile utilise le montant du serveur et ne lui ajoute pas une seconde fois les places, la pluie ou le retard. Une recommandation comme **11 200 FC** n’est plus ramenée automatiquement à un palier de 500 FC. Les boutons de modification manuelle du budget conservent leur pas de 500 FC et leur plancher de 2 500 FC.

### Estimation sous chaque véhicule

Dans les deux parcours de création mobile (depuis l’accueil et formulaire standard), chaque choix **Voiture**, **Moto 2 roues** et **Moto 3 roues** affiche son `recommendedTotalPrice` reçu de `/trip-requests/vehicle-options`, même si ce type n’est pas sélectionné. Ce total inclut déjà le nombre de places et les éventuelles majorations. Le budget manuel du passager ne remplace pas ces estimations.

Pour **3,3 km en conditions normales et une place**, les estimations sont **4 950 FC voiture**, **3 960 FC moto 2 roues** et **3 300 FC moto 3 roues**. Avec deux places, les totaux doublent. Les montants peuvent encore être identiques sur une courte distance à cause du minimum commun de 2 500 FC, ou en conditions difficiles à cause du tarif majoré commun. Les limites de capacité restent appliquées : un type trop petit est indiqué indisponible.

Chaque `options[].pricing` contient maintenant le détail du type concerné. Le `pricing` global de la réponse conserve la référence voiture pour les anciens clients : il ne doit pas remplacer la grille de l'option choisie. Le mobile utilise le détail de l'option pour son explication, avec repli global pour les anciens backends. Itinéraire et météo sont récupérés une seule fois par appel, puis réutilisés pour calculer les trois montants.

Un changement d’itinéraire ou de places actualise les estimations. Pendant le chargement, le mobile affiche « Calcul… » ; en cas d’échec, « Indisponible », sans présenter l’ancien montant comme une estimation à jour. Ces prix nécessitent le backend mis à jour : une application encore reliée à l’ancienne production continue de recevoir l’ancienne grille tant que le backend n’est pas déployé.

L’aperçu de carte permanent du formulaire « Votre commande » est replié derrière « Voir l’itinéraire » pour laisser davantage de place aux adresses, horaires et prix. Le sélecteur d’adresses conserve sa carte ; le calcul serveur de distance et de prix ne dépend pas de l’affichage de cet aperçu.

Le prix reste une **recommandation modifiable avant confirmation**, pas un montant imposé égal au calcul au kilomètre. Le backend contrôle le minimum pour les nouvelles demandes, nouvelles offres de conducteur, nouvelles propositions de prix sur réservation, nouvelles publications payantes et nouveaux tarifs saisis en modification. Les trajets explicitement gratuits restent possibles.

Un budget déjà enregistré n’est pas remplacé à l’arrivée d’une nouvelle estimation. Les prix déjà acceptés, paiements, remboursements et historiques ne sont pas recalculés par cette grille. Les anciennes valeurs inchangées peuvent être conservées. Aucun supplément n’est automatiquement ajouté après la course et aucune dette supplémentaire n’est créée par une nouvelle observation de trafic.

Les subventions, remises et règles de règlement existantes restent distinctes du prix brut par place : elles peuvent faire varier le montant effectivement payé sans changer cette grille.

## Fichiers et activation

- Backend : `src/trip-requests/trip-request-pricing.ts`, `trip-requests.service.ts`, `src/google-maps/google-maps.service.ts`, `src/trips/trips.service.ts`.
- Mobile : `features/trip-request/requestFormModel.ts`, `pricingDescription.ts`, contrats API et hooks de tarification des demandes et publications.
- Aucun nouveau paramètre d’environnement ni migration PostgreSQL n’est nécessaire pour **cette grille**. Les autres modifications du dépôt peuvent avoir leurs propres migrations.
- Déployer le backend puis publier le mobile compatible. Les anciens clients peuvent encore afficher l’ancien plancher et recevoir le refus explicite `TRIP_PRICE_BELOW_MINIMUM` lors d’une nouvelle saisie trop basse.
- Contrôler les quotas et la facturation Google associés aux requêtes avec trafic, ainsi que la couverture effective des zones météo. Aucun appel fournisseur réel ni changement AWS n’est nécessaire aux tests automatisés de cette grille.

## Validation

Les campagnes ci-dessous sont historiques et correspondent à la grille initiale.
Pour la mise à jour du 13 novembre : voir l'entrée du journal technique. Ne pas
additionner les campagnes recouvrantes ni les présenter comme une recette native.

**174 tests backend ciblés réussis, dans 9 suites**, couvrant le minimum, les tarifs normaux et majorés, les deux seuils de congestion, les fractions de minute, les données absentes, le cumul pluie/trafic, le cache Google, les totaux multi-places, les alertes de création et la conservation des anciens prix acceptés.

**93 tests mobiles ciblés réussis**, avec fournisseurs simulés et échanges HTTP locaux sur les contrats de publication. Contrôles TypeScript backend et mobile réussis. Il ne s’agit pas d’une recette complète sur téléphones ni d’une validation contre les fournisseurs réels ; ces essais restent à effectuer avant généralisation.

Contrôle complémentaire des estimations par véhicule et du formulaire allégé : **99 tests backend réussis (5 suites) et 100 tests mobiles réussis**. Ces campagnes recouvrent les précédentes et ne s’additionnent pas à leurs totaux. Elles vérifient la cohérence entre recommandation individuelle et liste des véhicules, le minimum, 3,3 km et 5 km, la pluie, le retard, les places, le rendu des trois choix et le repli de la carte, sans appels aux fournisseurs réels. Treize aperçus React Native Web ont également été contrôlés avec les nouvelles estimations synthétiques ; aucun essai natif n’est revendiqué.
