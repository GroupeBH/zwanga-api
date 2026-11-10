# Unicité des numéros de téléphone

Les écritures RDC `0891234567`, `891234567`, `243891234567`, `00243891234567`
et `+243891234567` désignent désormais une même identité de compte. Le backend
utilise les mêmes règles que l'OTP. Un indicatif international explicite est
conservé : les numéros étrangers ne deviennent pas des numéros RDC.

## Comportement

- Les inscriptions classiques, Google et Apple enregistrent les nouveaux numéros
  au format international avec `+`. La création d'administrateurs suit ces règles.
- La connexion mobile et admin, le PIN oublié et la vérification téléphonique
  retrouvent également les anciens comptes enregistrés au format local ou avec espaces.
- S'il existe plusieurs comptes pour la même identité, la connexion par téléphone
  et le PIN oublié ne sélectionnent aucun compte. La réponse du PIN oublié reste
  neutre pour ne pas révéler les comptes inscrits. Elle ne prouve pas un envoi SMS.
- Les sessions existantes ne sont pas révoquées par la migration. Les UUID,
  téléphones historiques, trajets, soldes, bonus et parrainages restent inchangés.
- Un changement réel de numéro vérifie les équivalences. Une simple différence
  de format dans un profil ne réinitialise pas la vérification téléphonique.
- Les anciennes applications peuvent continuer à envoyer un numéro local : la
  normalisation est effectuée côté serveur, pas seulement dans les formulaires.

## Protection PostgreSQL

La migration `CanonicalPhoneIdentity1780000119000` ajoute une fonction immutable,
un index d'identité et la table technique `user_phone_identities`. Une réservation
unique protège chaque numéro contre les inscriptions et modifications concurrentes,
y compris les écritures qui ne passent pas par le service d'inscription.

Une identité historique en conflit est réservée avec un propriétaire NULL.
Elle ne peut pas être réattribuée automatiquement. Les autres écritures sur ces
comptes restent possibles. Les nouvelles insertions et les modifications effectives
de téléphone sont normalisées par un trigger. Les numéros historiques malformés ne
sont pas réécrits ; ils nécessitent une vérification par le support.

La politique existante de réinscription pour un compte indisponible est conservée
uniquement en l'absence de conflit historique. Sa libération de numéro et la création
du nouveau compte sont atomiques. Aucun historique financier n'est transféré.

## Déploiement

1. Sauvegarder la base et tester la migration sur une copie isolée.
2. Exécuter les migrations avant de lancer ce nouveau code. Les recherches
   d'identité nécessitent la fonction PostgreSQL ; ne pas démarrer cette version
   contre un schéma non migré.
   Coordonner ce déploiement : pendant la coexistence avec l'ancien code, une
   inscription locale normalisée par le trigger peut ne plus être retrouvée par
   la recherche exacte de l'ancienne version. Ne pas laisser cet état transitoire
   se prolonger.
3. La migration limite l'attente d'un verrou à 3 secondes et chaque instruction à
   30 secondes. En cas de contention, elle échoue et sa transaction est annulée ;
   replanifier l'exécution, sans désactiver la protection.
4. Exécuter `phone-identity-audit.sql` via une connexion explicitement choisie et
   autorisée. Le diagnostic est en lecture seule, limite les détails à 200 groupes
   et masque les numéros. Garder ses résultats dans les outils internes du support.
5. Contrôler un compte historique unique et une nouvelle inscription, avec les
   variantes locale et internationale. Les tests SMS réels exigent un numéro
   contrôlé et une autorisation distincte.

Aucun déploiement ni diagnostic de données de production n'est déclenché par ces
fichiers. Une nouvelle version mobile n'est pas nécessaire à cette protection.

## Traitement des doublons existants

Ne pas choisir automatiquement le compte le plus ancien, le plus récent ou celui
dont le numéro possède déjà `+243`. Une preuve SMS ne permet pas à elle seule de
décider quel historique financier doit être conservé.

Pour chaque groupe, le support doit vérifier le titulaire, les justificatifs et les
historiques, puis faire approuver les UUID à conserver ou à dissocier du numéro.
Toute correction doit être journalisée, révoquer les sessions appropriées et rester
dans une transaction. Conserver les UUID et écritures financières des deux comptes.
Ne supprimer aucun compte et ne transférer aucun solde dans une normalisation.

Après cette décision seulement, une intervention contrôlée peut dissocier le
numéro des comptes non retenus et attribuer la réservation au compte retenu, puis
normaliser son téléphone. La réservation NULL reste volontairement bloquante tant
que cette intervention n'a pas été réalisée. Aucun script de fusion ou de choix
automatique de titulaire n'est fourni.

## Retour arrière

Revenir d'abord au code précédent, puis exécuter le `down` de cette migration
uniquement lorsque toutes les instances du nouveau code sont arrêtées. Le `down`
retire les objets techniques sans supprimer de compte ni modifier ses données.
Les numéros des comptes créés depuis la migration restent internationaux. Le retour
arrière retire aussi la protection contre les doublons de formats.

## Vérification locale

Les tests PostgreSQL se lancent avec `PHONE_REGISTRATION_TEST_POSTGRES_BIN` pointant
vers le dossier des binaires PostgreSQL, puis :

```text
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/database/registration-phone-postgres.spec.ts
```

Ils créent et suppriment une base temporaire isolée, sans lire `.env`. Ils couvrent
les variantes, les collisions historiques, les créations concurrentes, les erreurs
de modification, les annulations de transaction, le PIN oublié et le retour arrière.

Validation locale du 10 novembre 2026 :

- 29 tests PostgreSQL 18 réussis, migration aller et retour comprise.
- 441 tests réussis dans la sélection élargie authentification, OTP, comptes admin,
  profils, filtre d'erreurs et registre des migrations.
- 17 tests Redis de la sélection élargie ignorés faute d'activation de leur environnement dédié.
- Compilation TypeScript sans émission et contrôle des espaces du diff réussis.

Les appels aux fournisseurs SMS sont simulés dans ces tests. La migration n'a été
appliquée qu'aux bases temporaires des tests, ni à la base de travail ni à AWS.
