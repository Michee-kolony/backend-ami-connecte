// Volets spécifiques de la fiche AMI selon le type de structure :
//  - « hopital »     : fiche ENREGISTREMENT HÔPITAL (capacité, services médicaux et spécialisés,
//                      maternité, néonatologie, PEV, laboratoire / imagerie / pharmacie, RH) ;
//  - « centreSante » : fiche ENREGISTREMENT CENTRE DE SANTÉ (infrastructure, consultations, CPN,
//                      accouchement, PEV, nutrition, planification familiale, laboratoire /
//                      pharmacie, RH).
// Les volets sont décrits de façon déclarative : la même description construit le schéma Mongoose
// (models/ficheEtablissement.js), sert le formulaire dynamique de l'application (le frontend
// affiche les champs à partir de `formulaire`) et alimente le contrôle et la complétude.
//
// Types de champ :
//   ouiNon · nombre (entier ≥ 0) · decimal (≥ 0) · texte · date (AAAA-MM-JJ) · choix (options)
//   multi (plusieurs options) · installeFonctionnel ({ installes, fonctionnels })
//   groupe (champs) · liste (une ligne par élément du référentiel `elements`, mêmes champs)
// `max` : clé d'un champ voisin qui borne la valeur (ex. lits fonctionnels ≤ lits installés).
// `pour` : éléments de la liste concernés par le champ (indication pour le formulaire).

const OUI_NON = ['Oui', 'Non'];
const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const ETATS = ['Bon', 'Moyen', 'Mauvais'];
const DISPONIBILITES = ['Disponible', 'Ruptures fréquentes', 'Indisponible'];
const SOURCES_EAU = ['Réseau public (REGIDESO)', 'Forage', 'Puits', 'Source aménagée', 'Citerne / eau de pluie', 'Rivière', 'Autre'];
const DISPONIBILITE_EAU = ['Permanente', 'Intermittente', 'Absente'];
const SOURCES_ELECTRICITE = ['Réseau public', 'Groupe électrogène', 'Solaire', 'Aucune'];
const ELIMINATION_DECHETS = ['Incinérateur', 'Fosse à déchets', 'Collecte externe', 'Brûlage à l’air libre', 'Aucun'];
const EAUX_USEES = ['Réseau d’égouts', 'Fosse septique', 'Puisard', 'Aucun'];
const MOYENS_EVACUATION = ['Ambulance', 'Véhicule', 'Moto', 'Convention de transport', 'Aucun'];
const EXAMENS_PRENATALS = [
  'Hémoglobine', 'Groupe sanguin / Rhésus', 'Test VIH', 'Syphilis (RPR / TPHA)', 'Glycémie', 'Albuminurie / glycosurie',
  'Goutte épaisse / TDR paludisme', 'Hépatite B', 'ECBU', 'Autre',
];
const INTERVENTIONS_PREVENTIVES = [
  'Fer / acide folique', 'TPI (SP)', 'Vaccination antitétanique (VAT)', 'Moustiquaire imprégnée (MII)', 'Déparasitage',
  'Dépistage VIH / PTME', 'Conseils nutritionnels', 'Autre',
];
const STATUTS_PROFESSIONNELS = ['Fonctionnaire (État)', 'Contractuel', 'Prestataire', 'Bénévole', 'Stagiaire', 'Autre'];

// --- Fabriques de champs ------------------------------------------------------------------------

const on = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'ouiNon', ...extra });
const nb = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'nombre', ...extra });
const dec = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'decimal', ...extra });
const tx = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'texte', ...extra });
const dt = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'date', ...extra });
const ch = (cle, libelle, options, extra = {}) => ({ cle, libelle, type: 'choix', options, ...extra });
const mu = (cle, libelle, options, extra = {}) => ({ cle, libelle, type: 'multi', options, ...extra });
const ifn = (cle, libelle, extra = {}) => ({ cle, libelle, type: 'installeFonctionnel', ...extra });
const grp = (cle, libelle, champs, extra = {}) => ({ cle, libelle, type: 'groupe', champs, ...extra });
const liste = (cle, libelle, elements, champs, extra = {}) => ({ cle, libelle, type: 'liste', elements, champs, ...extra });

/** Vaccination et PEV (champs communs aux hôpitaux et aux centres de santé). */
const vaccinationPev = (titre) => grp('vaccination', titre, [
  on('service', 'Service de vaccination (PEV) existant'),
  on('fonctionnel', 'Service fonctionnel'),
  on('routine', 'Vaccination de routine'),
  on('strategieFixe', 'Vaccination / stratégie fixe'),
  on('strategieAvancee', 'Vaccination / stratégie avancée'),
  on('strategieMobile', 'Vaccination / stratégie mobile'),
  on('rattrapage', 'Vaccination de rattrapage'),
  on('nouveauNes', 'Vaccination des nouveau-nés'),
  nb('sallesVaccination', 'Salles de vaccination'),
  grp('personnel', 'Personnel PEV / vaccinateur', [nb('nombre', 'Nombre'), tx('qualifications', 'Qualifications')]),
  grp('refrigerateurs', 'Réfrigérateurs vaccinaux', [
    nb('nombre', 'Nombre'), nb('fonctionnels', 'Fonctionnels', { max: 'nombre' }), ch('etat', 'État', ETATS),
  ]),
  nb('porteVaccins', 'Porte-vaccins disponibles'),
  on('thermometres', 'Thermomètres disponibles'),
  on('chaineFroid', 'Chaîne du froid fonctionnelle'),
  ch('surveillanceThermique', 'Surveillance thermique', ['Fiche papier', 'Dispositif numérique', 'Les deux', 'Aucune']),
  grp('approvisionnement', 'Approvisionnement', [
    tx('source', 'Source d’approvisionnement'),
    ch('frequence', 'Fréquence', ['Hebdomadaire', 'Mensuelle', 'Trimestrielle', 'Irrégulière']),
  ]),
  ch('gestionStocks', 'Gestion des stocks', ['Registre / fiche de stock', 'Logiciel', 'Les deux', 'Aucun']),
  grp('gestionDechets', 'Gestion des déchets', [
    on('boitesSecurite', 'Boîtes de sécurité disponibles'), ch('elimination', 'Circuit d’élimination', ELIMINATION_DECHETS),
  ]),
  grp('seances', 'Séances / jours de vaccination', [
    mu('jours', 'Jours de vaccination', JOURS), nb('nombreParMois', 'Séances par mois'), tx('calendrier', 'Calendrier des séances'),
  ]),
  on('registres', 'Outils PEV disponibles (registres, fiches, carnets)'),
  mu('communication', 'Mobilisation et rappels des bénéficiaires', ['RECO / crieurs', 'SMS de rappel', 'Appels', 'Radio communautaire', 'Églises / écoles', 'Autre']),
]);

// --- Hôpital ----------------------------------------------------------------------------------

const SERVICES_HOPITAL = [
  'Médecine interne', 'Pédiatrie', 'Gynécologie-obstétrique', 'Chirurgie générale', 'Chirurgie spécialisée', 'Néonatologie',
  'Réanimation', 'Urgences', 'Ophtalmologie', 'ORL', 'Dermatologie', 'Stomatologie', 'Anesthésie', 'Orthopédie', 'Psychiatrie',
  'Kinésithérapie', 'Nutrition clinique',
];

const CATEGORIES_RH_HOPITAL = [
  'Médecins généralistes', 'Médecins spécialistes', 'Gynécologues-obstétriciens', 'Pédiatres', 'Chirurgiens', 'Anesthésistes',
  'Sages-femmes', 'Infirmiers A1', 'Infirmiers A2', 'Infirmiers (autres catégories)', 'Techniciens de laboratoire',
  'Techniciens d’imagerie', 'Pharmaciens', 'Nutritionnistes', 'Agents administratifs', 'Personnel d’hygiène et d’assainissement',
];

const HOPITAL = [
  grp('capacite', '2. Capacité d’accueil et infrastructure hospitalière', [
    dec('superficieM2', 'Superficie totale de l’établissement (m²)'),
    nb('batimentsSanitaires', 'Bâtiments sanitaires'),
    nb('blocsFonctionnels', 'Blocs fonctionnels (opérationnels)'),
    nb('litsInstalles', 'Lits installés'),
    nb('litsFonctionnels', 'Lits fonctionnels (utilisables)', { max: 'litsInstalles' }),
    nb('litsDisponibles', 'Lits actuellement disponibles', { max: 'litsFonctionnels' }),
    nb('sallesHospitalisation', 'Salles d’hospitalisation'),
    nb('sallesConsultation', 'Salles de consultation fonctionnelles'),
    nb('sallesUrgence', 'Salles d’urgence'),
    nb('sallesSoins', 'Salles de soins'),
    ifn('blocsOperatoires', 'Blocs opératoires'),
    ifn('sallesAccouchement', 'Salles d’accouchement'),
    ifn('sallesReveil', 'Salles de réveil'),
    nb('servicesSanitairesFonctionnels', 'Services sanitaires fonctionnels'),
    mu('electricite', 'Électricité', SOURCES_ELECTRICITE),
    grp('eau', 'Eau', [mu('sources', 'Source d’approvisionnement', SOURCES_EAU), ch('disponibilite', 'Disponibilité', DISPONIBILITE_EAU)]),
    grp('assainissement', 'Assainissement', [
      nb('toilettes', 'Toilettes'), nb('toilettesFonctionnelles', 'Toilettes fonctionnelles', { max: 'toilettes' }),
      ch('evacuationDechets', 'Évacuation des déchets', ELIMINATION_DECHETS), ch('eauxUsees', 'Évacuation des eaux usées', EAUX_USEES),
    ]),
    grp('transportSanitaire', 'Transport sanitaire', [
      nb('ambulances', 'Ambulances disponibles'), nb('ambulancesFonctionnelles', 'Ambulances fonctionnelles', { max: 'ambulances' }),
    ]),
  ]),

  liste('services', '3. Services médicaux et spécialisés', SERVICES_HOPITAL, [
    on('existe', 'Existence du service'),
    on('fonctionnel', 'Service fonctionnel'),
    dt('dateMiseEnService', 'Date de mise en service'),
    tx('horaires', 'Horaires de fonctionnement'),
    on('permanence24h', 'Disponible 24h/24', { pour: ['Urgences', 'Réanimation', 'Gynécologie-obstétrique'] }),
    nb('lits', 'Nombre de lits (si applicable)'),
    nb('professionnels', 'Nombre de professionnels'),
    nb('personnelSpecialise', 'Dont personnel spécialisé', { max: 'professionnels', pour: ['Gynécologie-obstétrique', 'Anesthésie', 'Néonatologie'] }),
    nb('incubateurs', 'Incubateurs', { pour: ['Néonatologie'] }),
    on('blocAssocie', 'Bloc opératoire associé', { pour: ['Chirurgie générale', 'Chirurgie spécialisée', 'Gynécologie-obstétrique', 'Orthopédie'] }),
    tx('typesChirurgie', 'Types de chirurgie pratiqués', { pour: ['Chirurgie spécialisée'] }),
    tx('prestations', 'Prestations / consultations disponibles'),
    tx('equipements', 'Équipements disponibles'),
    tx('capacite', 'Capacité de prise en charge'),
    tx('motifNonFonctionnement', 'Motif de non-fonctionnement, le cas échéant'),
  ]),

  grp('maternite', '4. Maternité et santé maternelle', [
    on('existe', 'Maternité existante'),
    on('fonctionnelle', 'Maternité fonctionnelle'),
    on('cpn', 'Consultations prénatales (CPN) disponibles'),
    grp('organisationCpn', 'Organisation CPN', [mu('jours', 'Jours', JOURS), tx('horaires', 'Horaires')]),
    grp('personnelCpn', 'Personnel CPN', [nb('medecins', 'Médecins'), nb('sagesFemmes', 'Sages-femmes'), nb('infirmiers', 'Infirmiers')]),
    nb('sallesCpn', 'Salles CPN'),
    mu('equipementsCpn', 'Équipements CPN', [
      'Table d’examen', 'Tensiomètre', 'Balance / pèse-personne', 'Stéthoscope', 'Doppler fœtal', 'Toise', 'Ruban de mesure utérine', 'Autre',
    ]),
    on('echographieObstetricale', 'Échographie obstétricale'),
    mu('laboratoirePrenatal', 'Laboratoire prénatal : examens disponibles', EXAMENS_PRENATALS),
    on('accouchementsAssistes', 'Accouchements assistés disponibles'),
    nb('sallesAccouchement', 'Salles d’accouchement'),
    ifn('tablesAccouchement', 'Tables d’accouchement'),
    on('cesarienne', 'Césarienne disponible'),
    on('blocObstetrical', 'Bloc obstétrical fonctionnel'),
    grp('sonu', 'Soins obstétricaux d’urgence', [ch('niveau', 'Niveau', ['SONU complet', 'SONU de base', 'Aucun']), tx('capacite', 'Capacité de prise en charge')]),
    on('transfusionSanguine', 'Transfusion sanguine disponible'),
    on('soinsPostnatals', 'Soins postnatals disponibles'),
    grp('referenceObstetricale', 'Référence obstétricale', [
      tx('circuit', 'Circuit de référence'), on('contreReference', 'Contre-référence organisée'), tx('structuresReferentes', 'Structures qui réfèrent'),
    ]),
  ]),

  grp('neonatologie', '5. Néonatologie et prise en charge du nouveau-né', [
    on('existe', 'Service de néonatologie existant'),
    nb('lits', 'Lits néonatals'),
    ifn('incubateurs', 'Incubateurs'),
    on('oxygene', 'Oxygène disponible'),
    on('reanimationNeonatale', 'Équipements de réanimation néonatale disponibles'),
    grp('personnel', 'Personnel qualifié', [nb('nombre', 'Nombre'), tx('qualifications', 'Qualifications')]),
    on('prematures', 'Prise en charge des prématurés'),
    on('faiblePoids', 'Prise en charge des nouveau-nés de faible poids'),
    on('soinsKangourou', 'Soins kangourou'),
    tx('capaciteReference', 'Capacité de référence néonatale'),
  ]),

  vaccinationPev('6. Vaccination et Programme élargi de vaccination (PEV)'),

  grp('laboratoireImageriePharmacie', '7. Laboratoire, imagerie et pharmacie', [
    grp('laboratoire', 'Laboratoire', [
      on('fonctionnel', 'Laboratoire fonctionnel'),
      on('hematologie', 'Examens hématologiques'),
      on('biochimie', 'Examens biochimiques'),
      on('microbiologie', 'Examens microbiologiques'),
      on('parasitologie', 'Examens parasitologiques'),
      on('testsRapides', 'Tests rapides'),
      on('prenatals', 'Examens prénatals'),
      ch('reactifs', 'Disponibilité des réactifs', DISPONIBILITES),
      nb('personnel', 'Personnel de laboratoire'),
    ]),
    grp('imagerie', 'Imagerie', [
      on('echographie', 'Échographie'),
      on('radiographie', 'Radiographie'),
      on('scanner', 'Scanner'),
      tx('autres', 'Autres équipements disponibles'),
      ch('etat', 'État fonctionnel', ['Fonctionnel', 'Partiel', 'Non fonctionnel']),
      nb('personnel', 'Personnel d’imagerie'),
    ]),
    grp('pharmacie', 'Pharmacie', [
      on('pharmacieHospitaliere', 'Pharmacie hospitalière'),
      on('depotMedicaments', 'Dépôt de médicaments'),
      on('gestionInformatisee', 'Gestion informatisée des stocks'),
      ch('medicamentsEssentiels', 'Médicaments essentiels', DISPONIBILITES),
      ch('consommables', 'Produits et consommables médicaux', DISPONIBILITES),
      tx('circuitApprovisionnement', 'Circuit d’approvisionnement'),
    ]),
  ]),

  liste('ressourcesHumaines', '8. Ressources humaines hospitalières (par profession et par service)', CATEGORIES_RH_HOPITAL, [
    tx('service', 'Service d’affectation'),
    nb('effectifTotal', 'Effectif total'),
    nb('effectifActif', 'Effectif actif', { max: 'effectifTotal' }),
    nb('effectifAffecteService', 'Effectif affecté au service', { max: 'effectifTotal' }),
    tx('qualification', 'Qualification'),
    ch('statutProfessionnel', 'Statut professionnel', STATUTS_PROFESSIONNELS),
  ], { cleUnique: ['element', 'service'] }),
];

// --- Centre de santé -------------------------------------------------------------------------

const ACTIVITES_CS = [
  'Consultations curatives', 'Consultations préventives', 'Consultations pédiatriques', 'Consultations générales',
  'Suivi des maladies chroniques', 'Dépistage des maladies', 'Soins infirmiers', 'Pansements', 'Injections', 'Perfusions',
  'Observation des patients', 'Référence des cas compliqués',
];

const EQUIPEMENTS_CPN_CS = [
  'Table d’examen', 'Tensiomètre', 'Stéthoscope', 'Pèse-personne', 'Toise', 'Ruban de mesure utérine',
  'Doppler fœtal ou matériel d’auscultation', 'Matériel d’examen obstétrical', 'Matériel de prévention des infections',
];

const CATEGORIES_RH_CS = [
  'Infirmier titulaire', 'Infirmiers A1', 'Infirmiers A2', 'Sages-femmes', 'Accoucheuses qualifiées', 'Techniciens de laboratoire',
  'Agents PEV', 'Agents de nutrition', 'Agents de pharmacie', 'Personnel administratif', 'Agents d’hygiène',
  'Relais communautaires associés à l’aire de santé',
];

const CENTRE_SANTE = [
  grp('infrastructure', '2. Infrastructure et capacité d’accueil', [
    nb('batiments', 'Bâtiments'),
    nb('sallesConsultation', 'Salles de consultation'),
    nb('sallesSoins', 'Salles de soins'),
    ifn('sallesCpn', 'Salles CPN'),
    on('salleAccouchement', 'Salle d’accouchement'),
    on('salleVaccination', 'Salle de vaccination'),
    on('salleObservation', 'Salle d’observation'),
    nb('litsObservation', 'Lits d’observation fonctionnels'),
    nb('litsMaternite', 'Lits de maternité fonctionnels'),
    on('salleLaboratoire', 'Salle de laboratoire'),
    on('depotPharmaceutique', 'Dépôt pharmaceutique'),
    grp('toilettes', 'Toilettes', [nb('nombre', 'Nombre'), ch('etat', 'État', ETATS)]),
    grp('eau', 'Eau', [mu('sources', 'Source', SOURCES_EAU), ch('disponibilite', 'Disponibilité', DISPONIBILITE_EAU)]),
    mu('electricite', 'Électricité', SOURCES_ELECTRICITE),
    grp('gestionDechets', 'Gestion des déchets', [tx('collecte', 'Système de collecte'), ch('elimination', 'Élimination', ELIMINATION_DECHETS)]),
    grp('transport', 'Transport (référence / évacuation)', [mu('moyens', 'Moyens', MOYENS_EVACUATION), tx('details', 'Précisions')]),
  ]),

  liste('consultations', '3. Consultations curatives et préventives', ACTIVITES_CS, [
    on('disponible', 'Disponible'),
    on('fonctionnel', 'Fonctionnel'),
    tx('horaires', 'Horaires'),
    nb('personnel', 'Personnel (nombre)'),
    tx('personnelDetail', 'Personnel (catégories)'),
    tx('equipements', 'Équipements'),
  ]),

  grp('santeMaternelle', '4. Santé maternelle et CPN', [
    on('serviceCpn', 'Service CPN existant'),
    on('fonctionnel', 'CPN fonctionnelle'),
    nb('salles', 'Salles réservées à la CPN'),
    grp('personnel', 'Personnel', [nb('sagesFemmes', 'Sages-femmes'), nb('infirmiers', 'Infirmiers'), nb('medecins', 'Médecins')]),
    grp('organisation', 'Organisation', [mu('jours', 'Jours de consultation', JOURS), tx('horaires', 'Horaires')]),
    ch('enregistrement', 'Enregistrement', ['Registre papier', 'Système numérique', 'Les deux']),
    on('cpn1', 'CPN1 proposée'),
    tx('cpnSuivantes', 'CPN suivantes (prestations selon le protocole national)'),
    mu('examens', 'Examens cliniques et biologiques disponibles', EXAMENS_PRENATALS),
    mu('prevention', 'Interventions préventives disponibles', INTERVENTIONS_PREVENTIVES),
    on('echographie', 'Échographie disponible'),
    grp('referencement', 'Référencement des femmes enceintes', [tx('circuit', 'Circuit de référence'), tx('structureReference', 'Structure de référence')]),
    ch('rendezVous', 'Système de rendez-vous', ['Carnet / fiche CPN', 'Registre', 'Système numérique (AMI)', 'Aucun']),
    mu('suiviAbandons', 'Suivi des abandons', ['RECO / visites à domicile', 'Appels / SMS', 'Autre', 'Aucun']),
    liste('equipements', 'Équipements CPN', EQUIPEMENTS_CPN_CS, [
      on('disponible', 'Disponible'), nb('nombre', 'Nombre'), nb('fonctionnels', 'Fonctionnels', { max: 'nombre' }),
    ]),
  ]),

  grp('accouchement', '5. Accouchement et maternité', [
    on('serviceMaternite', 'Service maternité'),
    on('accouchementAssiste', 'Accouchement assisté'),
    nb('sallesAccouchement', 'Salles d’accouchement'),
    nb('tablesAccouchementFonctionnelles', 'Tables d’accouchement fonctionnelles'),
    grp('personnelQualifie', 'Personnel qualifié', [
      nb('sagesFemmes', 'Sages-femmes'), nb('accoucheuses', 'Accoucheuses qualifiées'), nb('infirmiers', 'Infirmiers'), nb('medecins', 'Médecins'),
    ]),
    on('surveillanceTravail', 'Surveillance du travail (partogramme)'),
    grp('materiel', 'Matériel d’accouchement', [ch('disponibilite', 'Disponibilité', DISPONIBILITES), ch('etat', 'État', ETATS)]),
    grp('preventionInfections', 'Prévention des infections', [on('materiel', 'Matériel disponible'), on('protocoles', 'Protocoles affichés / appliqués')]),
    on('soinsImmediatsNouveauNe', 'Soins immédiats du nouveau-né'),
    on('reanimationNeonatale', 'Matériel de réanimation néonatale'),
    on('surveillancePostPartum', 'Surveillance post-partum'),
    on('soinsPostnatals', 'Soins postnatals'),
    ch('gestionComplications', 'Gestion des complications', ['Stabilisation puis référence', 'Prise en charge partielle', 'Aucune']),
    tx('hopitalReference', 'Hôpital de référence (référence obstétricale)'),
    mu('transportUrgence', 'Transport d’urgence', MOYENS_EVACUATION),
  ]),

  vaccinationPev('6. Vaccination et PEV'),

  grp('nutrition', '7. Nutrition et santé de l’enfant', [
    on('consultation', 'Consultation nutritionnelle'),
    on('pesee', 'Pesée des enfants'),
    on('taille', 'Mesure de la taille'),
    on('perimetreBrachial', 'Mesure du périmètre brachial'),
    on('depistageMalnutrition', 'Dépistage de la malnutrition'),
    on('suiviCroissance', 'Suivi de la croissance'),
    on('conseilsAnje', 'Conseils sur l’alimentation du nourrisson et du jeune enfant'),
    on('depistageRisque', 'Dépistage des enfants à risque'),
    ch('priseEnCharge', 'Prise en charge nutritionnelle', ['Ambulatoire (PCIMA)', 'Supplémentaire', 'Aucune (référence)']),
    on('reference', 'Référence des cas compliqués'),
  ]),

  grp('planificationFamiliale', '8. Planification familiale et santé reproductive', [
    on('existe', 'Service existant'),
    on('consultations', 'Consultations de planification familiale'),
    nb('personnelForme', 'Personnel formé'),
    mu('methodes', 'Méthodes contraceptives disponibles', [
      'Pilule', 'Injectable', 'Implant', 'DIU', 'Préservatif masculin', 'Préservatif féminin', 'Collier / jours fixes', 'MAMA',
      'Contraception d’urgence', 'Stérilisation (référence)',
    ]),
    ch('disponibiliteProduits', 'Disponibilité des produits', DISPONIBILITES),
    on('conseils', 'Conseils en santé reproductive'),
    on('suiviUtilisatrices', 'Suivi des utilisatrices'),
    on('reference', 'Référence des cas nécessitant des soins spécialisés'),
  ]),

  grp('laboratoirePharmacie', '9. Laboratoire et pharmacie', [
    grp('laboratoire', 'Laboratoire de base', [
      on('goutteEpaisse', 'Goutte épaisse'),
      on('testGrossesse', 'Test de grossesse'),
      on('hemoglobine', 'Hémoglobine'),
      on('glycemie', 'Glycémie'),
      on('examensUrinaires', 'Examens urinaires'),
      mu('testsRapides', 'Tests rapides disponibles', ['TDR paludisme', 'VIH', 'Syphilis', 'Hépatite B', 'Glycémie capillaire', 'Autre']),
      tx('autres', 'Autres examens réellement pratiqués'),
    ]),
    grp('pharmacie', 'Pharmacie et dépôt', [
      on('depot', 'Dépôt pharmaceutique'),
      ch('medicamentsEssentiels', 'Médicaments essentiels', DISPONIBILITES),
      ch('produitsPev', 'Produits PEV', DISPONIBILITES),
      ch('intrantsCpn', 'Intrants CPN', DISPONIBILITES),
      ch('intrantsAccouchement', 'Intrants d’accouchement', DISPONIBILITES),
      ch('consommables', 'Consommables médicaux', DISPONIBILITES),
      ch('outilStocks', 'Outil de gestion des stocks', ['Fiche de stock', 'Registre', 'Logiciel', 'Aucun']),
      ch('ruptures', 'Ruptures de stock', ['Jamais', 'Rarement', 'Souvent', 'Permanentes']),
      ch('frequenceSuivi', 'Fréquence de suivi des stocks', ['Hebdomadaire', 'Mensuelle', 'Trimestrielle', 'Aucune']),
    ]),
  ]),

  liste('ressourcesHumaines', '10. Ressources humaines du centre de santé', CATEGORIES_RH_CS, [
    nb('prevus', 'Effectif prévu'),
    nb('presents', 'Effectif présent'),
    nb('actifs', 'Effectif actif', { max: 'presents' }),
    tx('qualifications', 'Qualifications'),
    tx('servicesAffectation', 'Services d’affectation'),
  ]),
];

// --- Profils -----------------------------------------------------------------------------------

const PROFILS = {
  hopital: { cle: 'hopital', titre: 'Fiche spécifique Hôpital', sections: HOPITAL },
  centreSante: { cle: 'centreSante', titre: 'Fiche spécifique Centre de santé', sections: CENTRE_SANTE },
};

/** Type de structure → volet spécifique (les autres types n'ont que la fiche générale). */
const PROFIL_DU_TYPE = {
  'Hôpital général de référence': 'hopital', 'Hôpital provincial': 'hopital', 'Hôpital national': 'hopital',
  'Hôpital militaire': 'hopital', Polyclinique: 'hopital', Clinique: 'hopital',
  'Centre de santé de référence': 'centreSante', 'Centre de santé': 'centreSante', 'Poste de santé': 'centreSante',
  'Centre médical': 'centreSante', Maternité: 'centreSante',
};

/** Volet spécifique d'un établissement ('hopital', 'centreSante' ou null). */
const profilDe = (e) => PROFIL_DU_TYPE[e?.type] ?? null;

// --- Parcours des valeurs (contrôle et complétude) ----------------------------------------------

const vide = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const brut = (v) => (v?.toObject ? v.toObject() : v);

/** Une valeur (groupe, liste ou champ) contient-elle au moins une donnée ? */
function renseigne(champ, v) {
  v = brut(v);
  if (vide(v)) return false;
  if (champ.type === 'groupe') return champ.champs.some((c) => renseigne(c, v[c.cle]));
  if (champ.type === 'installeFonctionnel') return !vide(v.installes) || !vide(v.fonctionnels);
  if (champ.type === 'liste') return v.length > 0;
  return true;
}

/**
 * Cohérences d'un volet : bornes `max`, fonctionnels ≤ installés, éléments de liste en double.
 * Retourne des messages d'erreur lisibles.
 */
function controlerVolet(profil, donnees) {
  const def = PROFILS[profil];
  if (!def) return [];
  const erreurs = [];
  const d = brut(donnees) ?? {};

  const parcourir = (champs, valeur, chemin) => {
    const v = brut(valeur) ?? {};
    for (const c of champs) {
      const x = brut(v[c.cle]);
      const ici = `${chemin} · ${c.libelle}`;
      if (c.max && x != null && v[c.max] != null && x > v[c.max]) {
        const borne = champs.find((b) => b.cle === c.max)?.libelle ?? c.max;
        erreurs.push(`${ici} (${x}) > ${borne} (${v[c.max]}).`);
      }
      if (c.type === 'installeFonctionnel' && x && x.installes != null && x.fonctionnels != null && x.fonctionnels > x.installes) {
        erreurs.push(`${ici} : fonctionnels (${x.fonctionnels}) > installés (${x.installes}).`);
      }
      if (c.type === 'groupe' && x) parcourir(c.champs, x, ici);
      if (c.type === 'liste' && Array.isArray(x)) {
        const cles = c.cleUnique ?? ['element'];
        const vus = new Set();
        for (const ligne of x) {
          const l = brut(ligne);
          const k = cles.map((cle) => String(l[cle] ?? '').trim().toLowerCase()).join('|');
          if (vus.has(k)) erreurs.push(`${ici} : « ${l.element} »${l.service ? ` (${l.service})` : ''} saisi deux fois.`);
          vus.add(k);
          parcourir(c.champs, l, `${ici} · ${l.element}`);
        }
      }
    }
  };
  for (const s of def.sections) {
    if (s.type === 'liste') parcourir([s], { [s.cle]: d[s.cle] }, def.titre);
    else parcourir(s.champs, d[s.cle], `${def.titre} · ${s.libelle}`);
  }
  return erreurs;
}

/** Complétude d'un volet : une entrée par sous-section (renseignée ou non). */
function champsVolet(profil, donnees) {
  const def = PROFILS[profil];
  if (!def) return [];
  const d = brut(donnees) ?? {};
  return def.sections.map((s) => [`${def.titre} · ${s.libelle}`, renseigne(s, d[s.cle]) ? true : null]);
}

/** Description servie au formulaire (sans fonctions). */
const formulaire = (profil) => (PROFILS[profil] ? JSON.parse(JSON.stringify(PROFILS[profil])) : null);

module.exports = {
  PROFILS, PROFIL_DU_TYPE, SERVICES_HOPITAL, CATEGORIES_RH_HOPITAL, ACTIVITES_CS, EQUIPEMENTS_CPN_CS, CATEGORIES_RH_CS, JOURS,
  profilDe, controlerVolet, champsVolet, formulaire, renseigne,
};
