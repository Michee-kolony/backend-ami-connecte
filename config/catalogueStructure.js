// Catalogues de la fiche « Identification générale de la structure » (PDF du comité, §1 à §14) :
// types et catégories, statuts de fonctionnement, groupes de population, services et activités
// (§8), ressources humaines (§10) et équipements (§11), selon que la structure est un hôpital ou un
// centre de santé. Servis au formulaire par GET /api/referentiels/fiche-etablissement : une seule
// source pour le serveur et l'application.
//
// Règle de saisie : chaque information n'est demandée qu'une fois. Ce qui se déduit d'une autre
// réponse (catégorie d'un centre de santé, bâtiments hors service, total des lits, adresse…) est
// calculé et affiché, jamais ressaisi. Les doublons du document source sont fusionnés :
// « Femmes de 15 à 49 ans » = « Femmes en âge de procréer », « Hygiène et assainissement » du
// centre de santé = « Eau, hygiène et assainissement », « Planning familial » = « Planification
// familiale », « Quartier / Village » de l'adresse = celui de la localisation.

// --- §1 et §4 : type, catégorie, statut -------------------------------------------------------

/** Types de structure proposés (§1). Les anciens types restent valides pour les fiches existantes. */
const TYPES_STRUCTURE = [
  'Hôpital', 'Centre de santé', 'Centre de santé de référence', 'Clinique', 'Poste de santé', 'Laboratoire', 'Maternité', 'Autre',
];

/** Anciens types (avant la fiche « Identification générale ») → type et catégorie actuels. */
const TYPES_ANCIENS = {
  'Hôpital général de référence': { type: 'Hôpital', categorie: 'HGR' },
  'Hôpital provincial': { type: 'Hôpital', categorie: 'HP' },
  'Hôpital national': { type: 'Hôpital', categorie: 'HN' },
  'Hôpital militaire': { type: 'Hôpital', categorie: 'HM' },
  Polyclinique: { type: 'Clinique', categorie: 'Polyclinique' },
  'Centre médical': { type: 'Centre de santé', categorie: 'CM' },
};

/** Catégories (§4) avec leur libellé. */
const LIBELLES_CATEGORIE = {
  HGR: 'Hôpital général de référence (HGR)', HP: 'Hôpital provincial', HS: 'Hôpital spécialisé', HN: 'Hôpital national',
  HM: 'Hôpital militaire', CS: 'Centre de santé', CSR: 'Centre de santé de référence (CSR)', PS: 'Poste de santé',
  Clinique: 'Clinique', Polyclinique: 'Polyclinique', CM: 'Centre médical', Laboratoire: 'Laboratoire', Maternité: 'Maternité', Autre: 'Autre',
};

/**
 * Catégories possibles pour chaque type. Une seule catégorie : elle est déduite du type et n'est
 * pas redemandée. Plusieurs (hôpital) : la catégorie est choisie.
 */
const CATEGORIES_DU_TYPE = {
  Hôpital: ['HGR', 'HP', 'HS', 'HN', 'HM'],
  'Centre de santé': ['CS'],
  'Centre de santé de référence': ['CSR'],
  Clinique: ['Clinique'],
  'Poste de santé': ['PS'],
  Laboratoire: ['Laboratoire'],
  Maternité: ['Maternité'],
  Autre: ['Autre'],
};

/** Niveau de la pyramide sanitaire déduit de la catégorie (n'est plus saisi). */
const NIVEAU_DE_CATEGORIE = {
  HN: 'Central', HP: 'Provincial', HS: 'Provincial', HM: 'Provincial', HGR: 'Zone', CSR: 'Aire', CS: 'Aire', PS: 'Aire',
  CM: 'Aire', Clinique: 'Prestation', Polyclinique: 'Prestation', Laboratoire: 'Prestation', Maternité: 'Prestation', Autre: 'Prestation',
};

/** Statut de fonctionnement (§1). */
const STATUTS_FONCTIONNEMENT = ['Opérationnel', 'Partiel', 'Temporairement fermé', 'Fermé', 'En construction'];
/** Anciens statuts → statut actuel (lecture des fiches existantes). */
const STATUTS_ANCIENS = {
  Fonctionnelle: 'Opérationnel', 'Fonctionnelle limitée': 'Partiel', 'En réhabilitation': 'Partiel',
  'Temporairement fermée': 'Temporairement fermé', 'Définitivement fermée': 'Fermé',
};

/** Régime de gestion / tutelle (§1) : valeur enregistrée → libellé du document. */
const REGIMES_GESTION = [
  { valeur: 'Étatique', libelle: 'État' }, { valeur: 'Établissement public', libelle: 'Établissement public' },
  { valeur: 'Privée', libelle: 'Privé' }, { valeur: 'Confessionnelle', libelle: 'Confessionnel' },
  { valeur: 'Militaire', libelle: 'Militaire' }, { valeur: 'ONG', libelle: 'ONG' }, { valeur: 'Autre', libelle: 'Autre' },
];

// --- §3 : population cible ----------------------------------------------------------------------

/** Groupes de population (§3), saisis en nombre de personnes pour l'année de référence. */
const GROUPES_POPULATION = [
  { cle: 'de15a49', libelle: 'Femmes en âge de procréer (15-49 ans)' },
  { cle: 'moins1', libelle: 'Enfants de 0 à 11 mois' },
  { cle: 'de0a23m', libelle: 'Enfants de 0 à 23 mois' },
  { cle: 'moins5', libelle: 'Enfants de 0 à 59 mois' },
  { cle: 'de12a23m', libelle: 'Enfants de 12 à 23 mois' },
  { cle: 'de5a14', libelle: 'Enfants de 5 à 14 ans' },
  { cle: 'de10a19', libelle: 'Adolescents de 10 à 19 ans' },
  { cle: 'de15a24', libelle: 'Jeunes de 15 à 24 ans' },
  { cle: 'plus60', libelle: 'Personnes âgées de 60 ans et plus' },
  { cle: 'risqueEpidemiologique', libelle: 'Population à risque épidémiologique' },
  { cle: 'deplacee', libelle: 'Population déplacée' },
  { cle: 'refugiee', libelle: 'Population réfugiée' },
  { cle: 'handicap', libelle: 'Population vivant avec handicap' },
];

/** Périodes du calcul automatique des cibles (§3) : diviseur de la cible annuelle. */
const PERIODES_CIBLES = [
  { cle: 'annuelle', libelle: 'Annuelle', diviseur: 1 },
  { cle: 'semestrielle', libelle: 'Semestrielle', diviseur: 2 },
  { cle: 'trimestrielle', libelle: 'Trimestrielle', diviseur: 4 },
  { cle: 'mensuelle', libelle: 'Mensuelle', diviseur: 12 },
];

// --- §8 : services et activités -----------------------------------------------------------------

/** Catalogue d'une structure : groupes { titre, elements }. */
const groupe = (titre, elements) => ({ titre, elements });

const SERVICES = {
  hopital: [
    groupe('A. Services médicaux et cliniques', [
      'Consultation générale', 'Médecine interne', 'Pédiatrie', 'Gynécologie', 'Obstétrique', 'Blocs opératoires', 'Chirurgie générale',
      'Chirurgie spécialisée', 'Urgences médicales', 'Réanimation et soins intensifs', 'Anesthésie et réanimation', 'Néonatologie',
      'Hospitalisation adulte', 'Hospitalisation pédiatrique', 'Maternité', 'Salle d’accouchement', 'CPN', 'Planification familiale',
      'Consultation postnatale', 'Vaccination et PEV', 'Nutrition thérapeutique', 'Ophtalmologie', 'ORL', 'Dermatologie',
      'Stomatologie et odontologie', 'Psychiatrie et santé mentale', 'Kinésithérapie et réadaptation', 'Infectiologie', 'Tuberculose',
      'VIH/SIDA', 'Consultation prénatale spécialisée',
    ]),
    groupe('B. Services médico-techniques', [
      'Laboratoire de biologie médicale', 'Hématologie', 'Biochimie', 'Microbiologie', 'Parasitologie', 'Immunologie et sérologie',
      'Banque de sang / transfusion sanguine', 'Imagerie médicale', 'Radiologie', 'Échographie', 'Électrocardiographie', 'Endoscopie',
      'Anatomopathologie', 'Pharmacie hospitalière', 'Stérilisation centrale', 'Morgue',
    ]),
    groupe('C. Services administratifs et logistiques', [
      'Direction médicale', 'Administration et gestion', 'Finances et comptabilité', 'Ressources humaines', 'Statistiques sanitaires et SNIS',
      'Archives et dossiers médicaux', 'Hygiène et assainissement', 'Maintenance biomédicale', 'Buanderie', 'Cuisine et alimentation',
      'Gestion des déchets biomédicaux', 'Approvisionnement et magasin', 'Transport et ambulance', 'Sécurité et gardiennage',
    ]),
  ],
  centreSante: [
    groupe('A. Services de soins essentiels', [
      'Accueil et réception', 'Triage', 'Consultation curative', 'Soins infirmiers', 'Pansements et petites interventions',
      'Observation des malades', 'Référencement et contre-référencement', 'Urgences de première ligne',
    ]),
    groupe('B. Services de santé maternelle et reproductive', [
      'CPN', 'Préparation à l’accouchement', 'Maternité', 'Salle d’accouchement', 'Consultation postnatale', 'Planification familiale',
      'Dépistage et prise en charge des IST', 'Prévention de la transmission mère-enfant du VIH', 'Référence des grossesses à risque',
    ]),
    groupe('C. Services de santé de l’enfant', [
      'Consultation préscolaire', 'Vaccination et PEV', 'Soins essentiels du nouveau-né', 'Surveillance de la croissance',
      'Nutrition et dépistage de la malnutrition', 'Prise en charge intégrée des maladies de l’enfant', 'Suivi des enfants à risque',
    ]),
    groupe('D. Services de diagnostic et de soutien', [
      'Laboratoire de première ligne', 'Tests de diagnostic rapide', 'Dépistage du paludisme', 'Dépistage du VIH', 'Dépistage de la syphilis',
      'Sécurité transfusionnelle', 'Pharmacie et dispensation des médicaments', 'Gestion des médicaments et intrants',
      'Gestion des déchets biomédicaux',
    ]),
    groupe('E. Services communautaires et administratifs', [
      'Promotion de la santé', 'Relais communautaires (RECO)', 'Surveillance épidémiologique', 'Statistiques sanitaires et SNIS',
      'Gestion des dossiers des patients', 'Administration et gestion', 'Approvisionnement et magasin', 'Eau, hygiène et assainissement',
    ]),
  ],
};

/** Libellés affichés quand ils diffèrent du nom enregistré (selon la structure). */
const LIBELLES_SERVICE = {
  centreSante: { CPN: 'Consultation prénatale (CPN)', 'Salle d’accouchement': 'Salle d’accouchement (si autorisée et fonctionnelle)' },
  hopital: {},
};

/** Services qui ouvrent un module AMI quand ils sont fonctionnels (anciens noms compris). */
const SERVICES_MODULE = {
  CPN: ['CPN'],
  Accouchement: ['Accouchement', 'Salle d’accouchement'],
  Vaccination: ['Vaccination', 'Vaccination et PEV'],
};

/** Services de l'ancienne liste (15 services) : toujours acceptés pour les fiches existantes. */
const SERVICES_ANCIENS = [
  'CPN', 'Accouchement', 'Vaccination', 'Consultation générale', 'Consultation postnatale', 'Planification familiale',
  'Laboratoire', 'Hospitalisation', 'Chirurgie', 'Urgences', 'Nutrition', 'Pédiatrie', 'Maternité', 'Imagerie', 'Ambulance',
];

/** Ancien nom de service → nom du catalogue, selon la structure (reprise des fiches existantes). */
const SERVICES_RENOMMES = {
  hopital: {
    Accouchement: 'Salle d’accouchement', Vaccination: 'Vaccination et PEV', Laboratoire: 'Laboratoire de biologie médicale',
    Hospitalisation: 'Hospitalisation adulte', Chirurgie: 'Chirurgie générale', Urgences: 'Urgences médicales',
    Nutrition: 'Nutrition thérapeutique', Imagerie: 'Imagerie médicale', Ambulance: 'Transport et ambulance',
  },
  centreSante: {
    Accouchement: 'Salle d’accouchement', Vaccination: 'Vaccination et PEV', 'Consultation générale': 'Consultation curative',
    Laboratoire: 'Laboratoire de première ligne', Hospitalisation: 'Observation des malades', Urgences: 'Urgences de première ligne',
    Nutrition: 'Nutrition et dépistage de la malnutrition', Pédiatrie: 'Consultation préscolaire',
  },
};

// --- §10 : ressources humaines (nombre par fonction) -------------------------------------------

const PERSONNEL = {
  hopital: [
    groupe('1. Personnel médical', [
      'Médecin directeur', 'Médecin généraliste', 'Médecin interniste', 'Pédiatre', 'Gynécologue-obstétricien', 'Chirurgien général',
      'Anesthésiste-réanimateur', 'Néonatologiste', 'Cardiologue', 'Dermatologue', 'Ophtalmologue', 'Oto-rhino-laryngologiste', 'Psychiatre',
      'Stomatologue', 'Radiologue', 'Médecin urgentiste', 'Infectiologue', 'Médecin de santé publique', 'Médecin transfusionnel',
      'Médecin épidémiologiste',
    ]),
    groupe('2. Personnel infirmier et obstétrical', [
      'Directeur des soins infirmiers', 'Infirmier titulaire', 'Infirmier généraliste A1', 'Infirmier généraliste A2',
      'Infirmier spécialisé en anesthésie', 'Infirmier de réanimation', 'Infirmier pédiatrique', 'Infirmier de bloc opératoire', 'Sage-femme',
      'Infirmier obstétrical', 'Infirmier en néonatologie', 'Infirmier de vaccination', 'Infirmier de consultation prénatale',
      'Infirmier de consultation postnatale', 'Infirmier d’urgence', 'Infirmier de santé communautaire',
    ]),
    groupe('3. Personnel médico-technique', [
      'Biologiste médical', 'Technicien de laboratoire A1', 'Technicien de laboratoire A2', 'Technicien en hématologie', 'Technicien en biochimie',
      'Technicien en microbiologie', 'Technicien en parasitologie', 'Technicien en transfusion sanguine', 'Technicien en radiologie',
      'Échographiste', 'Technicien biomédical', 'Pharmacien', 'Assistant en pharmacie', 'Kinésithérapeute', 'Nutritionniste',
      'Technicien en hygiène hospitalière',
    ]),
    groupe('4. Personnel administratif et de gestion hospitalière', [
      'Administrateur gestionnaire', 'Directeur administratif et financier', 'Comptable', 'Caissier', 'Secrétaire de direction',
      'Gestionnaire des ressources humaines', 'Agent de statistiques sanitaires', 'Archiviste médical', 'Informaticien',
      'Gestionnaire de pharmacie', 'Gestionnaire de magasin', 'Gestionnaire de facturation', 'Agent d’accueil', 'Agent de saisie',
    ]),
    groupe('5. Personnel logistique et technique', [
      'Chauffeur ambulancier', 'Chauffeur', 'Technicien de maintenance', 'Électricien', 'Plombier', 'Agent d’hygiène',
      'Agent d’assainissement', 'Agent de buanderie', 'Cuisinier', 'Agent de cuisine', 'Gardien', 'Manutentionnaire', 'Agent de morgue',
    ]),
  ],
  centreSante: [
    groupe('1. Personnel médical et infirmier', [
      'Médecin généraliste', 'Infirmier titulaire', 'Infirmier A1', 'Infirmier A2', 'Infirmier de consultation', 'Infirmier de CPN',
      'Infirmier de maternité', 'Sage-femme', 'Infirmier de vaccination', 'Infirmier de consultation postnatale', 'Infirmier de pédiatrie',
      'Infirmier de nutrition', 'Infirmier de soins', 'Infirmier d’urgence', 'Technicien en anesthésie',
    ]),
    groupe('2. Personnel de laboratoire', [
      'Technicien de laboratoire A1', 'Technicien de laboratoire A2', 'Laborantin', 'Agent de prélèvement', 'Responsable de laboratoire',
    ]),
    groupe('3. Personnel communautaire et de santé publique', [
      'Technicien de développement rural / santé communautaire', 'RECO', 'Superviseur des RECO', 'Agent de surveillance épidémiologique',
      'Agent de promotion de la santé', 'Agent de nutrition', 'Agent de suivi des vaccinations', 'Agent de suivi des femmes enceintes',
    ]),
    groupe('4. Personnel administratif et logistique', [
      'Secrétaire', 'Comptable', 'Caissier', 'Agent de statistiques', 'Agent de saisie', 'Gestionnaire de pharmacie', 'Gestionnaire de stock',
      'Agent d’accueil', 'Agent d’hygiène', 'Gardien', 'Chauffeur', 'Technicien de maintenance',
    ]),
  ],
};

// --- §11 : équipements et logistique (quantité par service) ------------------------------------

const EQUIPEMENTS = {
  hopital: [
    groupe('CPN', [
      'Table d’examen gynécologique', 'Tensiomètre', 'Stéthoscope médical', 'Doppler fœtal', 'Stéthoscope de Pinard', 'Balance pour adulte',
      'Toise pour adulte', 'Ruban métrique obstétrical', 'Thermomètre médical', 'Oxymètre de pouls', 'Glucomètre', 'Hémoglobinomètre',
      'Lampe d’examen', 'Spéculums vaginaux', 'Boîtes de prélèvement', 'Bureau de consultation', 'Chaises', 'Armoire médicale', 'Paravent',
      'Ordinateur ou tablette AMI',
    ]),
    groupe('Maternité et salle d’accouchement', [
      'Table d’accouchement', 'Table d’examen gynécologique', 'Moniteur fœtal cardiotocographe', 'Doppler fœtal', 'Tensiomètre', 'Stéthoscope',
      'Oxymètre de pouls', 'Thermomètre', 'Lampe scialytique', 'Aspirateur médical', 'Source d’oxygène', 'Ambu adulte', 'Chariot d’urgence',
      'Pieds à perfusion', 'Boîtes d’accouchement', 'Boîtes de suture périnéale', 'Pinces à cordon', 'Ciseaux à cordon', 'Pinces hémostatiques',
      'Porte-aiguilles', 'Boîtes de révision utérine', 'Matériel de perfusion', 'Table de soins', 'Lits d’observation', 'Armoires médicales',
      'Ordinateur ou tablette AMI',
    ]),
    groupe('Néonatologie', [
      'Couveuse néonatale', 'Table chauffante radiante', 'Appareil de photothérapie', 'Berceau néonatal', 'Pèse-bébé électronique',
      'Toise pour nourrisson', 'Ruban métrique', 'Thermomètre néonatal', 'Oxymètre néonatal', 'Moniteur multiparamétrique', 'Glucomètre',
      'Aspirateur néonatal', 'Ballon autoremplisseur néonatal', 'Masques de ventilation néonatale', 'Laryngoscope néonatal',
      'Tubes endotrachéaux', 'Source d’oxygène', 'Concentrateur d’oxygène', 'Appareil CPAP néonatal', 'Pompe à perfusion',
      'Pousse-seringue électrique', 'Sondes d’aspiration', 'Sondes nasogastriques', 'Tire-lait', 'Table de soins', 'Ordinateur ou tablette AMI',
    ]),
    groupe('Vaccination', [
      'Réfrigérateur spécialisé pour vaccins', 'Congélateur pour accumulateurs de froid', 'Porte-vaccins', 'Glacières de transport',
      'Accumulateurs de froid', 'Enregistreur électronique de température', 'Thermomètres de réfrigérateur', 'Indicateurs de congélation',
      'Table de vaccination', 'Chaises', 'Boîtes de sécurité', 'Plateaux de vaccination', 'Armoires de rangement', 'Ordinateur ou tablette',
      'Imprimante', 'Source d’énergie de secours',
    ]),
    groupe('Laboratoire · A. Appareils', [
      'Microscope binoculaire', 'Microscope trinoculaire', 'Centrifugeuse de laboratoire', 'Microcentrifugeuse', 'Automate d’hématologie',
      'Hémoglobinomètre', 'Appareil de mesure de VS', 'Automate de biochimie', 'Analyseur d’électrolytes', 'Analyseur de coagulation',
      'Analyseur d’urines', 'Lecteur ELISA', 'Laveur de microplaques ELISA', 'Incubateur de laboratoire', 'Autoclave',
      'Hotte de sécurité microbiologique classe II', 'Réfrigérateur de laboratoire', 'Congélateur de laboratoire', 'Bain-marie',
      'Agitateur vortex', 'Balance analytique', 'Distillateur d’eau', 'Spectrophotomètre', 'Compteur manuel de cellules',
      'Système de diagnostic moléculaire',
    ]),
    groupe('Laboratoire · B. Prélèvement et collecte', [
      'Fauteuil de prélèvement', 'Garrots de prélèvement', 'Supports de tubes', 'Aiguilles de prélèvement', 'Tubes EDTA', 'Tubes secs',
      'Tubes héparinés', 'Tubes citratés', 'Tubes fluorés', 'Seringues stériles', 'Lancettes', 'Contenants à urine', 'Pots à selles',
      'Écouvillons stériles', 'Boîtes de transport des échantillons', 'Glacières de transport',
    ]),
    groupe('Laboratoire · C. Microscopie et microbiologie', [
      'Lames porte-objets', 'Lamelles couvre-objets', 'Boîtes de Pétri', 'Anses de bactériologie', 'Portoirs à tubes', 'Pipettes automatiques',
      'Embouts de pipettes', 'Béchers gradués', 'Éprouvettes graduées', 'Tubes à essai', 'Flacons de culture', 'Boîtes de coloration',
      'Portoirs de coloration', 'Thermomètres de laboratoire',
    ]),
    groupe('Laboratoire · D. Réactifs et consommables', [
      'Réactifs d’hématologie', 'Réactifs de biochimie', 'Réactifs de coagulation', 'Réactifs de groupage ABO et Rhésus',
      'Réactifs de compatibilité transfusionnelle', 'Réactifs de coloration de Gram', 'Colorant Giemsa', 'Colorant May-Grünwald-Giemsa',
      'Réactif de Lugol', 'Réactifs de coloration de Ziehl-Neelsen', 'Milieux de culture bactériologique', 'Réactifs de sérologie',
      'Réactifs ELISA', 'Réactifs de dosage des électrolytes', 'Réactifs de dosage de la créatinine', 'Réactifs de dosage de l’urée',
      'Réactifs de dosage des transaminases', 'Réactifs de dosage de la bilirubine', 'Réactifs de dosage de la glycémie',
      'Contrôles internes de qualité', 'Calibrateurs des automates', 'Réactifs de diagnostic moléculaire',
    ]),
    groupe('Laboratoire · E. Biosécurité et qualité', [
      'Blouses de laboratoire', 'Gants d’examen', 'Masques de protection', 'Lunettes de protection', 'Boîtes de sécurité pour aiguilles',
      'Poubelles biomédicales différenciées', 'Désinfectants de surface', 'Extincteurs', 'Trousse de premiers secours',
      'Kit de déversement biologique', 'Registre de maintenance des appareils', 'Registre de contrôle qualité', 'Thermohygromètre',
      'Onduleur ou stabilisateur adapté', 'Source électrique de secours',
    ]),
  ],
  centreSante: [
    groupe('CPN', [
      'Table d’examen gynécologique', 'Tensiomètre', 'Stéthoscope', 'Doppler fœtal', 'Stéthoscope de Pinard', 'Balance pour adulte',
      'Toise pour adulte', 'Ruban métrique obstétrical', 'Thermomètre', 'Oxymètre de pouls', 'Glucomètre', 'Hémoglobinomètre',
      'Lampe d’examen', 'Spéculums vaginaux', 'Bureau de consultation', 'Chaises', 'Armoire médicale', 'Paravent', 'Tablette / ordinateur',
    ]),
    groupe('Maternité', [
      'Table d’accouchement', 'Table d’examen gynécologique', 'Doppler fœtal', 'Tensiomètre', 'Stéthoscope', 'Thermomètre',
      'Oxymètre de pouls', 'Lampe d’examen', 'Aspirateur médical', 'Source d’oxygène', 'Ambu adulte', 'Boîtes d’accouchement',
      'Boîtes de suture périnéale', 'Ciseaux à cordon', 'Pinces à cordon', 'Pinces hémostatiques', 'Pied à perfusion', 'Matériel de perfusion',
      'Lit d’observation', 'Table de soins', 'Armoire médicale', 'Tablette / ordinateur',
    ]),
    groupe('Soins essentiels du nouveau-né', [
      'Table chauffante radiante', 'Berceau néonatal', 'Pèse-bébé', 'Toise pour nourrisson', 'Ruban métrique', 'Thermomètre néonatal',
      'Oxymètre adapté au nouveau-né', 'Aspirateur néonatal', 'Ballon autoremplisseur néonatal', 'Masques néonatals de différentes tailles',
      'Source d’oxygène', 'Sondes d’aspiration', 'Sondes nasogastriques', 'Glucomètre', 'Table de soins', 'Armoire de rangement',
    ]),
    groupe('Vaccination', [
      'Réfrigérateur spécialisé pour vaccins', 'Porte-vaccins', 'Glacière de transport', 'Accumulateurs de froid', 'Thermomètre de réfrigérateur',
      'Enregistreur de température', 'Indicateurs de congélation', 'Table de vaccination', 'Chaises', 'Plateaux de vaccination',
      'Boîtes de sécurité', 'Armoire de rangement', 'Tablette AMI', 'Source d’énergie de secours adaptée',
    ]),
    groupe('Laboratoire · A. Appareils et équipements principaux', [
      'Microscope optique binoculaire', 'Centrifugeuse de paillasse', 'Hémoglobinomètre', 'Glucomètre', 'Balance de précision',
      'Réfrigérateur de laboratoire', 'Minuteur de laboratoire', 'Thermomètre de réfrigérateur', 'Portoir de séchage',
      'Boîte de lecture des tests rapides', 'Agitateur manuel ou vortex', 'Chronomètre',
    ]),
    groupe('Laboratoire · B. Prélèvement', [
      'Porte-tubes', 'Garrot médical', 'Aiguilles de prélèvement', 'Seringues stériles', 'Tubes EDTA', 'Tubes secs', 'Tubes citratés',
      'Lancettes stériles', 'Coton hydrophile', 'Compresses stériles', 'Alcool médical', 'Garrot à usage unique',
      'Boîte de transport des prélèvements',
    ]),
    groupe('Laboratoire · C. Verrerie et petit matériel', [
      'Lames porte-objets', 'Lamelles couvre-objets', 'Tubes à essai', 'Pipettes graduées', 'Micropipettes', 'Embouts de micropipettes',
      'Béchers gradués', 'Éprouvettes graduées', 'Entonnoirs de laboratoire', 'Portoirs à tubes', 'Boîtes de Pétri', 'Compte-gouttes',
      'Spatules de laboratoire', 'Pissettes',
    ]),
    groupe('Laboratoire · D. Réactifs et tests de diagnostic', [
      'Tests rapides du paludisme', 'Réactif de coloration Giemsa', 'Bandelettes urinaires multiparamètres', 'Tests rapides de grossesse',
      'Tests rapides VIH', 'Tests rapides syphilis', 'Réactifs de coloration de Gram', 'Réactif de Lugol', 'Solution physiologique 0,9 %',
      'Eau distillée', 'Bandelettes de glycémie', 'Contrôles de glycémie', 'Réactifs d’hémoglobine',
    ]),
    groupe('Laboratoire · E. Sécurité, hygiène et déchets', [
      'Blouses de laboratoire', 'Gants d’examen', 'Masques médicaux', 'Lunettes de protection', 'Boîte de sécurité pour objets piquants',
      'Poubelle à déchets biomédicaux', 'Désinfectant de surface', 'Savon liquide', 'Solution hydroalcoolique', 'Extincteur',
      'Trousse de premiers secours', 'Kit de déversement biologique',
    ]),
  ],
};

/** Équipements dont la présence fonctionnelle vaut chaîne du froid (§9 déduit du §11). */
const EQUIPEMENTS_CHAINE_FROID = ['Réfrigérateur spécialisé pour vaccins'];
/** Équipements comptés comme matériel numérique (§13 « Utilisation numérique »). */
const MOTIF_NUMERIQUE = /ordinateur|tablette/i;

// --- §7, §9, §13 ----------------------------------------------------------------------------------

/** Responsables fonctionnels (§7) : un par domaine. */
const DOMAINES_FONCTIONNELS = ['CPN', 'Maternité', 'PEV', 'Surveillance', 'Données', 'Informatique'];
/** Salles par fonction (§9). */
const SALLES = [
  { cle: 'consultation', libelle: 'Consultation' }, { cle: 'cpn', libelle: 'CPN' }, { cle: 'accouchement', libelle: 'Accouchement' },
  { cle: 'vaccination', libelle: 'Vaccination' }, { cle: 'laboratoire', libelle: 'Laboratoire' }, { cle: 'chirurgie', libelle: 'Chirurgie' },
  { cle: 'hospitalisation', libelle: 'Hospitalisation' },
];
/** Unités proposées pour les lits (§9), saisie libre possible. */
const UNITES_LITS = [
  'Médecine interne', 'Pédiatrie', 'Maternité', 'Gynécologie-obstétrique', 'Chirurgie', 'Néonatologie', 'Réanimation', 'Observation', 'Autre',
];
const SOURCES_EAU = ['Réseau public (REGIDESO)', 'Forage', 'Puits', 'Source aménagée', 'Citerne / eau de pluie', 'Rivière', 'Autre'];

// --- Utilitaires ----------------------------------------------------------------------------------

/** Profil du catalogue : hôpital (hôpitaux et cliniques) ou centre de santé (tous les autres types). */
function profilCatalogue(type) {
  const t = TYPES_ANCIENS[type]?.type ?? type;
  return t === 'Hôpital' || t === 'Clinique' ? 'hopital' : 'centreSante';
}

const tous = (catalogue) => [...new Set(Object.values(catalogue).flatMap((gs) => gs.flatMap((g) => g.elements)))];

/** Noms de services acceptés : catalogues + anciens noms. */
const NOMS_SERVICES = [...new Set([...tous(SERVICES), ...SERVICES_ANCIENS])];
/** Fonctions du personnel acceptées (§10). */
const FONCTIONS_PERSONNEL = tous(PERSONNEL);

/** Catalogue servi au formulaire. */
function catalogue() {
  return {
    typesStructure: TYPES_STRUCTURE, typesAnciens: TYPES_ANCIENS, categoriesDuType: CATEGORIES_DU_TYPE, libellesCategorie: LIBELLES_CATEGORIE,
    statutsFonctionnement: STATUTS_FONCTIONNEMENT, statutsAnciens: STATUTS_ANCIENS, regimesGestion: REGIMES_GESTION,
    groupesPopulation: GROUPES_POPULATION, periodesCibles: PERIODES_CIBLES, services: SERVICES, libellesService: LIBELLES_SERVICE,
    servicesModule: SERVICES_MODULE, servicesRenommes: SERVICES_RENOMMES, personnel: PERSONNEL, equipements: EQUIPEMENTS,
    domainesFonctionnels: DOMAINES_FONCTIONNELS, salles: SALLES, unitesLits: UNITES_LITS, sourcesEau: SOURCES_EAU,
  };
}

module.exports = {
  TYPES_STRUCTURE, TYPES_ANCIENS, LIBELLES_CATEGORIE, CATEGORIES_DU_TYPE, NIVEAU_DE_CATEGORIE, STATUTS_FONCTIONNEMENT, STATUTS_ANCIENS,
  REGIMES_GESTION, GROUPES_POPULATION, PERIODES_CIBLES, SERVICES, LIBELLES_SERVICE, SERVICES_MODULE, SERVICES_ANCIENS, SERVICES_RENOMMES,
  PERSONNEL, EQUIPEMENTS, EQUIPEMENTS_CHAINE_FROID, MOTIF_NUMERIQUE, DOMAINES_FONCTIONNELS, SALLES, UNITES_LITS, SOURCES_EAU,
  NOMS_SERVICES, FONCTIONS_PERSONNEL, profilCatalogue, catalogue,
};
