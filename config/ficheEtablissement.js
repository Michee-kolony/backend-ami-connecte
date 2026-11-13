// Fiche AMI d'un établissement sanitaire : les 10 étapes du cahier des charges (identification,
// localisation, organisation, infrastructures, ressources humaines, services, population, cibles,
// capacités, validation). Référentiels, répartition des champs entre le comité de pilotage
// (obligatoires) et le médecin chef (facultatifs), contrôle automatique et calculs.

const { COEFFICIENTS_INITIAUX } = require('./epidemiologie');
const V = require('./ficheSpecifique');

// --- Référentiels ----------------------------------------------------------------------------

const NIVEAUX_SANITAIRES = ['Central', 'Provincial', 'Zone', 'Aire', 'Prestation'];
const CATEGORIES = ['HGR', 'HP', 'HN', 'HM', 'CSR', 'CS', 'PS', 'Polyclinique', 'Clinique', 'CM', 'Laboratoire', 'Maternité', 'Autre'];
const STATUTS_ACTUELS = [
  'Fonctionnelle', 'Fonctionnelle limitée', 'Temporairement fermée', 'Définitivement fermée', 'En construction', 'En réhabilitation',
];
const STATUTS_JURIDIQUES = ['Public', 'Privé lucratif', 'Privé non lucratif', 'Confessionnel', 'Militaire', 'Associatif', 'Autre'];
/** Régime de gestion / tutelle (fiche « Identification générale » : État, Établissement public, Privé, Confessionnel, Militaire, ONG). */
const MODES_GESTION = [
  'Étatique', 'Établissement public', 'Confessionnelle', 'Privée', 'Militaire', 'ONG', 'Associative', 'Communautaire', 'Autre',
];
const OUI_NON = ['Oui', 'Non'];
const OUI_NON_PARTIEL = ['Oui', 'Non', 'Partiel'];
const ACCESSIBILITE = ['Oui', 'Non', 'Partielle'];
const DISPONIBILITE = ['Disponible', 'Indisponible'];
const ETATS_EQUIPEMENT = ['Bon', 'Moyen', 'Mauvais'];
const PROFESSIONS = [
  'Médecin généraliste', 'Médecin spécialiste', 'Infirmier', 'Sage-femme', 'Accoucheuse', 'Technicien laboratoire',
  'Pharmacien', 'Technicien vaccination', 'Nutritionniste', 'Administratif', 'Hygiéniste', 'Autre',
];
const CONTRATS = ['État', 'Contractuel', 'Bénévole', 'Autre'];
const STATUTS_AGENT = ['Actif', 'En congé', 'En formation', 'En mission', 'Suspendu', 'Sorti'];
const REGIMES = ['Temps plein', 'Temps partiel'];
const SOURCES_POPULATION = ['DPS', 'SNIS', 'Recensement', 'Estimation'];

// Référentiels de la fiche « Identification générale de la structure ».
const NIVEAUX_SOINS = ['Premier recours', 'Référence', 'Spécialisé', 'Autre'];
const TITRES_RESPONSABLE = ['Médecin directeur', 'Médecin chef', 'Infirmier titulaire', 'Administrateur gestionnaire', 'Autre'];
const DOMAINES_RESPONSABILITE = ['CPN', 'Maternité', 'PEV', 'Surveillance', 'Données', 'Informatique', 'Autre'];
const CANAUX_CONTACT = ['Appel', 'SMS', 'E-mail', 'WhatsApp institutionnel', 'Autre'];
const PROGRAMMES = [
  'PEV', 'Santé maternelle', 'Surveillance épidémiologique', 'Nutrition', 'Planification familiale', 'Paludisme', 'VIH / Tuberculose', 'Autre',
];
const METHODES_GPS = ['Récepteur GPS', 'Smartphone', 'Carte / imagerie satellite', 'Autre'];
const SOURCES_CODE = ['SNIS', 'DHIS2', 'DPS', 'Ministère de la Santé', 'Autre'];
const DISPONIBILITES_SERVICE = ['Permanente', 'Certains jours', 'Sur appel', 'Indisponible'];
const MOTIFS_INDISPONIBILITE = ['Rupture de personnel', 'Équipement', 'Intrants', 'Travaux', 'Autre'];
const ETATS_BATIMENT = ['Bon', 'Moyen', 'Mauvais', 'Dangereux'];
const STABILITES = ['Stable', 'Instable', 'Absente'];
const CONTINUITES = ['Continue', 'Intermittente', 'Absente'];
const ROUTES = ['Route asphaltée', 'Route en terre', 'Piste', 'Voie fluviale / lacustre', 'Sentier', 'Autre'];
const SOURCES_ELECTRICITE = ['Réseau', 'Solaire', 'Groupe électrogène', 'Autre'];
const CATEGORIES_RH = [
  'Médecins', 'Infirmiers A0', 'Infirmiers A1', 'Infirmiers A2', 'Infirmiers A3', 'Sages-femmes', 'Accoucheuses', 'Techniciens',
  'Administratifs', 'Données', 'Informatique', 'Autres',
];
const CATEGORIES_EQUIPEMENT = ['Maternité', 'Diagnostic', 'Vaccination', 'Informatique', 'Transport', 'Énergie', 'Mobilier', 'Autre'];
const PREUVES_EQUIPEMENT = ['Photo (sans patient)', 'Fiche d’inventaire'];
const MOYENS_REFERENCE = ['Ambulance', 'Véhicule', 'Moto', 'Convention de transport', 'Aucun'];
const SYSTEMES_RAPPORTAGE = ['DHIS2', 'Registre papier', 'Autre système', 'Aucun'];
const ETATS_INTRANTS = ['Disponibles', 'Ruptures partielles', 'Rupture totale'];
const TYPES_PIECE = ['Acte de création', 'Autorisation de fonctionnement', 'Agrément', 'Procès-verbal de vérification', 'Autre'];

/** Étape 6 : services évalués (les 13 du cahier des charges, plus l'imagerie et l'ambulance d'AMI). */
const SERVICES_SANITAIRES = [
  'CPN', 'Accouchement', 'Vaccination', 'Consultation générale', 'Consultation postnatale', 'Planification familiale',
  'Laboratoire', 'Hospitalisation', 'Chirurgie', 'Urgences', 'Nutrition', 'Pédiatrie', 'Maternité', 'Imagerie', 'Ambulance',
];
/** Services de l'étape 6 qui ouvrent un module AMI quand ils sont fonctionnels. */
const MODULES = { CPN: 'CPN', Accouchement: 'Accouchement', Vaccination: 'Vaccination' };
/** Correspondance avec la liste courte `services` utilisée par le reste de la plateforme. */
const VERS_SERVICES_PLATEFORME = {
  CPN: 'CPN', Accouchement: 'Maternité', Maternité: 'Maternité', Vaccination: 'Vaccination', Urgences: 'Urgences',
  Ambulance: 'Ambulance', Pédiatrie: 'Pédiatrie', Laboratoire: 'Laboratoire', Imagerie: 'Imagerie', Chirurgie: 'Chirurgie',
};

/** Étape 10 : statuts informatiques du circuit de validation. */
const STATUTS_CIRCUIT = [
  'Brouillon', 'En attente de vérification', 'À corriger', 'En attente de validation', 'Validée', 'Active', 'Suspendue', 'Archivée',
  'Rejetée', 'Fermée',
];

/** Statut juridique (étape 3) → secteur affiché dans les listes de la plateforme. */
const SECTEUR_DU_STATUT = {
  Public: 'Public', 'Privé lucratif': 'Privé', 'Privé non lucratif': 'Privé', Confessionnel: 'Confessionnel',
  Militaire: 'Militaire', Associatif: 'ONG', Autre: 'Privé',
};

/** Type de structure → catégorie proposée (modifiable). */
const CATEGORIE_DU_TYPE = {
  'Hôpital général de référence': 'HGR', 'Hôpital provincial': 'HP', 'Hôpital national': 'HN', 'Hôpital militaire': 'HM',
  'Centre de santé de référence': 'CSR', 'Centre de santé': 'CS', 'Poste de santé': 'PS', Polyclinique: 'Polyclinique',
  Clinique: 'Clinique', 'Centre médical': 'CM', Laboratoire: 'Laboratoire', Maternité: 'Maternité', Autre: 'Autre',
};

// --- Répartition des champs ------------------------------------------------------------------

/**
 * Champs que le médecin chef peut compléter (tous facultatifs). Le reste de la fiche (identité,
 * rattachement, statut juridique, responsable, services qui ouvrent les modules, coefficients) est
 * saisi par le comité de pilotage et passe par le circuit de validation.
 * `true` : toute la section ; liste : seulement ces champs de la section.
 */
const CHAMPS_CHEF = {
  identification: ['nomUsuel', 'sigle', 'anneeCreation', 'dateOuverture', 'siteWeb'],
  localisation: [
    'commune', 'quartier', 'groupement', 'avenue', 'numero', 'gps', 'reperes', 'distanceBczsKm', 'distanceHgrKm', 'distanceCsrKm', 'tempsDeplacement',
    'moyenTransport', 'accessibilitePluies', 'accessibiliteUrgence',
  ],
  organisation: [
    'proprietaire', 'tutelleAdministrative', 'tutelleTechnique', 'responsableMedical', 'responsableInfirmier',
    'responsableAdministratif', 'responsableMaternite', 'joursFonctionnement', 'horaires', 'garde',
  ],
  contacts: true,
  responsablesFonctionnels: true,
  infrastructures: true,
  equipements: true,
  agents: true,
  effectifsAttendus: true,
  effectifs: true,
  recos: true,
  populations: true,
  capacites: true,
  operationnel: true,
  // Volets spécifiques (hôpital ou centre de santé) : renseignés par le médecin chef ou le comité.
  hopital: true,
  centreSante: true,
};
const SECTIONS = [
  'identification', 'localisation', 'organisation', 'contacts', 'rattachementSanitaire', 'responsablesFonctionnels', 'infrastructures',
  'equipements', 'agents', 'effectifsAttendus', 'effectifs', 'recos', 'services', 'populations', 'capacites', 'operationnel',
  'hopital', 'centreSante',
];
/** Sections saisies sous forme de liste (remplacées en entier). */
const SECTIONS_LISTE = ['equipements', 'agents', 'effectifsAttendus', 'effectifs', 'services', 'responsablesFonctionnels'];

/** Responsables de l'étape 3 dont le changement est historisé. */
const RESPONSABLES = {
  responsable: 'Responsable de la structure', responsableMedical: 'Responsable médical', responsableInfirmier: 'Responsable infirmier',
  responsableAdministratif: 'Responsable administratif', responsableMaternite: 'Responsable maternité / CPN / Vaccination',
};

// --- Utilitaires -------------------------------------------------------------------------------

const rempli = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const nomPersonne = (p) => [p?.prenom, p?.nom, p?.postnom].filter(Boolean).join(' ').trim();
const abrege = (texte, n = 3) => String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, n) || 'XXX';

/** DPS et BCZS déduits de la province et de la zone principale. */
function rattachement(e) {
  return {
    dps: e.province ? `DPS ${e.province}` : '',
    bczs: e.zoneSante ? `BCZS ${e.zoneSante}` : '',
  };
}

// --- Étape 4 : taux de fonctionnalité ---------------------------------------------------------

const taux = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : null);

function calculsEquipements(equipements = []) {
  const jour = new Date().toISOString().slice(0, 10);
  const lignes = equipements.map((q) => ({
    nom: q.nom, categorie: q.categorie || null, total: q.total ?? 0, fonctionnels: q.fonctionnels ?? 0,
    // Quantité hors service = Total − Fonctionnel (fiche « Identification générale », §11).
    horsService: Math.max(0, (q.total ?? 0) - (q.fonctionnels ?? 0)),
    taux: taux(q.fonctionnels ?? 0, q.total ?? 0),
    maintenanceDepassee: Boolean(q.prochaineMaintenance && q.prochaineMaintenance < jour),
  }));
  const total = lignes.reduce((s, l) => s + l.total, 0);
  const fonctionnels = lignes.reduce((s, l) => s + l.fonctionnels, 0);
  const parCategorie = {};
  for (const l of lignes) {
    const k = l.categorie || 'Non renseignée';
    parCategorie[k] ??= { total: 0, fonctionnels: 0, horsService: 0 };
    parCategorie[k].total += l.total;
    parCategorie[k].fonctionnels += l.fonctionnels;
    parCategorie[k].horsService += l.horsService;
  }
  return {
    lignes, total, fonctionnels, horsService: Math.max(0, total - fonctionnels), taux: taux(fonctionnels, total), parCategorie,
    aRemplacer: equipements.filter((q) => q.remplacement === 'Oui').length,
    maintenancesDepassees: lignes.filter((l) => l.maintenanceDepassee).length,
  };
}

// --- Étape 5 : ressources humaines --------------------------------------------------------------

function compter(liste, cle) {
  const c = {};
  for (const x of liste) {
    const k = x[cle] || 'Non renseigné';
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}

function calculsRh(agents = [], attendus = []) {
  const presents = agents.filter((a) => a.statut !== 'Sorti');
  const parProfession = compter(presents, 'profession');
  return {
    total: presents.length,
    sortis: agents.length - presents.length,
    parProfession,
    parService: compter(presents, 'service'),
    disponibles: presents.filter((a) => a.disponibilite !== 'Indisponible').length,
    indisponibles: presents.filter((a) => a.disponibilite === 'Indisponible').length,
    ecarts: attendus.filter((n) => n.profession && n.nombre != null).map((n) => ({
      profession: n.profession, attendu: n.nombre, present: parProfession[n.profession] ?? 0, ecart: (parProfession[n.profession] ?? 0) - n.nombre,
    })),
  };
}

/**
 * Effectifs agrégés par catégorie (fiche « Identification générale », §10) : théorique, affecté,
 * présent, absents par motif, écarts et taux de présence. Les RECO sont comptés à part.
 */
function calculsEffectifs(effectifs = []) {
  const lignes = effectifs.map((l) => {
    const a = l.absents ?? {};
    const absents = ['conge', 'formation', 'suspension', 'absence', 'autre'].reduce((s, k) => s + (a[k] ?? 0), 0);
    return {
      categorie: l.categorie, qualification: l.qualification || null, theorique: l.theorique ?? null, affecte: l.affecte ?? null,
      present: l.present ?? null, absents, ecart: l.theorique != null && l.affecte != null ? l.affecte - l.theorique : null,
      tauxPresence: l.affecte ? taux(l.present ?? 0, l.affecte) : null, dateReference: l.dateReference ?? null,
    };
  });
  const somme = (k) => lignes.reduce((s, l) => s + (l[k] ?? 0), 0);
  return {
    lignes, theorique: somme('theorique'), affecte: somme('affecte'), present: somme('present'), absents: somme('absents'),
    tauxPresence: taux(somme('present'), somme('affecte')),
  };
}

// --- Étape 6 : activation des modules -----------------------------------------------------------

/**
 * Modules AMI ouverts : null pour un établissement enregistré avant la fiche AMI (aucune
 * restriction), sinon les modules dont le service est fonctionnel, seulement une fois la fiche
 * active (« pas d'activation sans validation »).
 */
function modulesActifs(e) {
  const statut = e.fiche?.circuit?.statut;
  if (!statut) return null;
  if (e.fiche.circuit.anterieur && !e.fiche.circuit.activeLe && !['Archivée', 'Rejetée', 'Fermée'].includes(statut)) return null;
  if (statut !== 'Active') return [];
  return Object.keys(MODULES).filter((m) => (e.fiche.services ?? []).some((s) => s.service === m && s.fonctionnel === 'Oui'));
}

/** Modules qui seront ouverts à l'activation (selon l'étape 6). */
function modulesPrevus(e) {
  return Object.keys(MODULES).filter((m) => (e.fiche?.services ?? []).some((s) => s.service === m && s.fonctionnel === 'Oui'));
}

/** Liste courte `services` de la plateforme : services disponibles et fonctionnels (ou partiels). */
function servicesPlateforme(services = []) {
  const s = new Set();
  for (const l of services) {
    if (l.disponible === 'Oui' && (l.fonctionnel === 'Oui' || l.fonctionnel === 'Partiel') && VERS_SERVICES_PLATEFORME[l.service]) {
      s.add(VERS_SERVICES_PLATEFORME[l.service]);
    }
  }
  return [...s];
}

// --- Étape 8 : populations cibles ---------------------------------------------------------------

/** Population de l'année la plus récente (base des cibles). */
const populationRecente = (populations = []) => [...populations].sort((a, b) => b.annee - a.annee)[0] ?? null;

/**
 * Cibles calculées à partir de la population de responsabilité. `coefficients` : coefficients
 * validés du module Épidémiologie (cible FE, NA, NS) ; à défaut, coefficients nationaux initiaux.
 * Femmes enceintes et naissances sont la même cohorte vue de deux façons : jamais additionnées.
 */
function calculsCibles(e, coefficients = {}) {
  const pop = populationRecente(e.fiche?.populations);
  const base = pop?.totale ?? null;
  const lignes = COEFFICIENTS_INITIAUX.map((c) => {
    const valide = coefficients[c.cible];
    const pct = valide?.valeurPct ?? c.valeurPct;
    const annuelle = base != null ? Math.round(base * pct / 100) : null;
    return {
      cible: c.cible,
      indicateur: { FE: 'Femmes enceintes attendues', NA: 'Naissances attendues', NS: 'Nourrissons survivants attendus' }[c.cible],
      populationBase: base,
      coefficientPct: pct,
      formule: `Population totale × ${(pct / 100).toLocaleString('fr-FR', { maximumFractionDigits: 6 })}`,
      cibleAnnuelle: annuelle,
      cibleMensuelle: annuelle != null ? Math.round(annuelle / 12) : null,
      coefficient: valide
        ? { code: valide.code, version: valide.version, dateDebut: valide.dateDebut, validePar: valide.validePar ?? null, valideLe: valide.valideLe ?? null, source: 'Épidémiologie (validé)' }
        : { code: c.code, version: null, dateDebut: null, validePar: null, valideLe: null, source: 'Coefficient national par défaut' },
    };
  });
  // Accouchements attendus = population × coefficient des naissances attendues (4 %) :
  // même cohorte que les naissances, affichée séparément pour la maternité.
  const na = lignes.find((l) => l.cible === 'NA');
  // Ajoutée en fin de liste : l'ordre FE, NA, NS des lignes existantes est conservé.
  if (na) lignes.push({ ...na, cible: 'AA', indicateur: 'Accouchements attendus' });
  return {
    annee: pop?.annee ?? null,
    source: pop?.source ?? null,
    populationBase: base,
    periode: 'Annuelle et mensuelle',
    dateCalcul: new Date().toISOString().slice(0, 10),
    lignes,
    alerte: 'Ne jamais additionner femmes enceintes, accouchements et naissances attendus : c’est la même cohorte vue de plusieurs façons.',
  };
}

// --- Étape 9 : capacités opérationnelles --------------------------------------------------------

/** Contacts CPN attendus par grossesse (norme utilisée pour le besoin mensuel en consultations CPN). */
const CONTACTS_CPN = 4;

/**
 * Compare capacité théorique, capacité opérationnelle, activités réalisées (mois écoulé) et
 * besoins attendus (étape 8). La capacité opérationnelle est la capacité théorique quand le
 * service est fonctionnel et que ses prérequis sont disponibles, la moitié s'il est partiel,
 * zéro sinon.
 */
function calculsCapacites(e, cibles, realisees = {}) {
  const c = e.fiche?.capacites ?? {};
  const infra = e.fiche?.infrastructures ?? {};
  const service = (nom) => (e.fiche?.services ?? []).find((s) => s.service === nom);
  const mensuelle = (code) => cibles.lignes.find((l) => l.cible === code)?.cibleMensuelle ?? null;
  const prerequis = {
    Accouchement: [['personnelQualifie', 'Personnel qualifié', c.personnelQualifie], ['eau', 'Eau', c.eau]],
    CPN: [['personnelQualifie', 'Personnel qualifié', c.personnelQualifie]],
    Vaccination: [['vaccins', 'Vaccins', c.vaccins], ['chaineFroid', 'Chaîne du froid', infra.chaineFroid], ['personnelQualifie', 'Personnel qualifié', c.personnelQualifie]],
  };
  const ligne = (nom, libelle, theorique, besoin, realise) => {
    const s = service(nom);
    const manquants = prerequis[nom].filter(([, , v]) => v === 'Non').map(([, l]) => l);
    let facteur = s?.fonctionnel === 'Oui' ? 1 : s?.fonctionnel === 'Partiel' ? 0.5 : 0;
    if (manquants.length) facteur = 0;
    const operationnelle = theorique != null ? Math.round(theorique * facteur) : null;
    const deficit = besoin != null && operationnelle != null ? Math.max(0, besoin - operationnelle) : null;
    let alerte = null;
    if (deficit > 0) alerte = { niveau: 'rouge', message: `Besoin ${besoin} / mois, capacité ${operationnelle} / mois → déficit de ${deficit}. Capacité insuffisante.` };
    else if (besoin != null && realise != null && realise < besoin * 0.8) alerte = { niveau: 'orange', message: `Activités réalisées (${realise}) inférieures à 80 % du besoin (${besoin}).` };
    else if (besoin != null && operationnelle != null) alerte = { niveau: 'vert', message: 'Capacité suffisante pour le besoin attendu.' };
    return { activite: libelle, service: nom, theorique: theorique ?? null, operationnelle, realisees: realise ?? null, besoin, deficit, prerequisManquants: manquants, alerte };
  };
  const fe = mensuelle('FE');
  return {
    lignes: [
      ligne('Accouchement', 'Accouchements / mois', c.accouchementsMois, mensuelle('NA'), realisees.accouchements),
      ligne('CPN', `Consultations CPN / mois (${CONTACTS_CPN} contacts par grossesse)`, c.cpnMois, fe != null ? fe * CONTACTS_CPN : null, realisees.cpn),
      ligne('Vaccination', 'Séances de vaccination / mois', c.seancesVaccinationMois, null, null),
    ],
    disponibilites: [
      ['Vaccins', c.vaccins], ['Médicaments essentiels', c.medicaments], ['Personnel qualifié', c.personnelQualifie],
      ['Électricité', c.electricite], ['Eau', c.eau], ['Transport de référence', c.transportReference], ['Moyens de communication', c.communication],
    ].map(([libelle, valeur]) => ({ libelle, valeur: valeur ?? null })),
  };
}

// --- Étape 10 : contrôle automatique et complétude ---------------------------------------------

/**
 * Contrôle automatique avant vérification : champs obligatoires, cohérences (erreurs bloquantes)
 * et points d'attention (avertissements). Les doublons sont vérifiés par le contrôleur (base).
 */
function controler(e) {
  const f = e.fiche ?? {};
  const id = f.identification ?? {};
  const loc = f.localisation ?? {};
  const org = f.organisation ?? {};
  const infra = f.infrastructures ?? {};
  const erreurs = [];
  const avertissements = [];
  const exiger = (v, libelle) => { if (!rempli(v)) erreurs.push(`${libelle} : obligatoire.`); };

  // Étape 1
  exiger(e.nom, 'Étape 1 · Nom officiel');
  exiger(e.type, 'Étape 1 · Type de structure');
  exiger(id.niveauSanitaire, 'Étape 1 · Niveau sanitaire');
  exiger(id.categorie, 'Étape 1 · Catégorie');
  exiger(id.statutActuel, 'Étape 1 · Statut actuel');
  exiger(e.telephone, 'Étape 1 · Téléphone principal');
  if (e.latitude == null || e.longitude == null) avertissements.push('Étape 1 · Coordonnées GPS non renseignées : la structure n’apparaîtra pas sur la carte.');
  const annee = new Date().getFullYear();
  if (id.anneeCreation != null && (id.anneeCreation < 1850 || id.anneeCreation > annee)) erreurs.push(`Étape 1 · Année de création invalide (${id.anneeCreation}).`);
  if (id.anneeCreation && id.dateOuverture && Number(id.dateOuverture.slice(0, 4)) < id.anneeCreation) {
    erreurs.push('Étape 1 · La date d’ouverture précède l’année de création.');
  }
  // Étape 2
  exiger(e.province, 'Étape 2 · Province');
  exiger(loc.territoire, 'Étape 2 · Ville ou territoire');
  exiger(e.zonesSante, 'Étape 2 · Zone de santé');
  exiger(e.aireSante, 'Étape 2 · Aire de santé');
  exiger(e.adresse, 'Étape 2 · Adresse physique');
  for (const [cle, libelle] of [['distanceBczsKm', 'BCZS'], ['distanceHgrKm', 'HGR'], ['distanceCsrKm', 'CSR']]) {
    if (loc[cle] != null && loc[cle] < 0) erreurs.push(`Étape 2 · Distance au ${libelle} négative.`);
  }
  // Étape 3
  exiger(org.statutJuridique, 'Étape 3 · Statut juridique');
  exiger(org.modeGestion, 'Étape 3 · Mode de gestion');
  exiger(org.responsable?.nom, 'Étape 3 · Nom du responsable');
  exiger(org.responsable?.prenom, 'Étape 3 · Prénom du responsable');
  exiger(org.responsable?.fonction, 'Étape 3 · Fonction du responsable');
  exiger(org.responsable?.telephone, 'Étape 3 · Téléphone du responsable');
  if (org.autorisation?.date && org.agrement?.dateEcheance && org.agrement.dateEcheance < new Date().toISOString().slice(0, 10)) {
    avertissements.push('Étape 3 · L’agrément est arrivé à échéance.');
  }
  if (org.garde?.disponible === 'Oui' && !org.garde?.horaires) avertissements.push('Étape 3 · Horaires de garde non précisés.');
  // Étape 4
  if (infra.litsFonctionnels != null && infra.litsTotal != null && infra.litsFonctionnels > infra.litsTotal) {
    erreurs.push('Étape 4 · Plus de lits fonctionnels que de lits au total.');
  }
  if (infra.toilettesFonctionnelles != null && infra.toilettesTotal != null && infra.toilettesFonctionnelles > infra.toilettesTotal) {
    erreurs.push('Étape 4 · Plus de toilettes fonctionnelles que de toilettes au total.');
  }
  for (const q of f.equipements ?? []) {
    const somme = (q.fonctionnels ?? 0) + (q.enPanne ?? 0) + (q.horsService ?? 0);
    if (somme > (q.total ?? 0)) erreurs.push(`Étape 4 · ${q.nom} : fonctionnels + en panne + hors service (${somme}) > quantité totale (${q.total ?? 0}).`);
  }
  if (infra.batimentsFonctionnels != null && infra.batimentsHorsService != null && infra.batiments != null
    && infra.batimentsFonctionnels + infra.batimentsHorsService > infra.batiments) {
    erreurs.push('Étape 4 · Bâtiments fonctionnels + hors service > nombre total de bâtiments.');
  }
  for (const u of infra.litsParUnite ?? []) {
    if (u.operationnels != null && u.installes != null && u.operationnels > u.installes) {
      erreurs.push(`Étape 4 · Lits « ${u.unite} » : opérationnels (${u.operationnels}) > installés (${u.installes}).`);
    }
  }
  for (const q of f.equipements ?? []) {
    if ((q.fonctionnels ?? 0) > (q.total ?? 0)) erreurs.push(`Étape 4 · ${q.nom} : quantité fonctionnelle > quantité totale.`);
  }
  // Identification générale : classification, historique des noms, contacts, responsables.
  for (const n of id.anciensNoms ?? []) {
    if (n.debut && n.fin && n.fin < n.debut) erreurs.push(`Étape 1 · Ancien nom « ${n.nom} » : fin de validité avant le début.`);
  }
  if (id.fonctionReference === 'Oui' && !id.territoireCouvert) avertissements.push('Étape 1 · Fonction de référence : territoire couvert non précisé.');
  if (id.maternite === 'Non' && (f.services ?? []).some((s) => ['Accouchement', 'Maternité'].includes(s.service) && s.fonctionnel === 'Oui')) {
    avertissements.push('Étape 1 · Maternité déclarée « Non » mais un service d’accouchement / maternité est fonctionnel.');
  }
  const telephoneValide = (v) => !v || /^\+243\d{9}$/.test(String(v).replace(/[\s.-]/g, ''));
  const contacts = f.contacts ?? {};
  for (const [v, libelle] of [[e.telephone, 'principal'], [contacts.telephoneSecondaire, 'secondaire'], [contacts.telephoneUrgence, 'd’urgence']]) {
    if (!telephoneValide(v)) avertissements.push(`Contacts · Téléphone ${libelle} : format +243 suivi de 9 chiffres attendu.`);
  }
  for (const r of f.responsablesFonctionnels ?? []) {
    if (r.debut && r.fin && r.fin < r.debut) erreurs.push(`Responsables · ${r.domaine} : fin de responsabilité avant le début.`);
    if (r.suppleantDebut && r.suppleantFin && r.suppleantFin < r.suppleantDebut) erreurs.push(`Responsables · ${r.domaine} : fin de suppléance avant le début.`);
  }
  for (const p of f.rattachementSanitaire?.programmes ?? []) {
    if (p.debut && p.fin && p.fin < p.debut) erreurs.push(`Rattachement · Programme ${p.programme} : fin de validité avant le début.`);
  }
  for (const l of f.effectifs ?? []) {
    if (l.present != null && l.affecte != null && l.present > l.affecte) erreurs.push(`Étape 5 · ${l.categorie} : effectif présent > effectif affecté.`);
  }
  if (org.agrement?.dateEmission && org.agrement?.dateEcheance && org.agrement.dateEcheance < org.agrement.dateEmission) {
    erreurs.push('Étape 3 · Agrément : échéance avant la date d’émission.');
  }
  // Volet spécifique (hôpital ou centre de santé).
  const profil = V.profilDe(e);
  if (profil) erreurs.push(...V.controlerVolet(profil, f[profil]));
  // Étape 6
  const services = f.services ?? [];
  if (!services.some((s) => s.fonctionnel === 'Oui' || s.fonctionnel === 'Partiel')) erreurs.push('Étape 6 · Aucun service fonctionnel déclaré.');
  for (const s of services) {
    if (s.fonctionnel && s.fonctionnel !== 'Non' && s.autorise === 'Non') avertissements.push(`Étape 6 · ${s.service} déclaré fonctionnel sans autorisation.`);
    if (s.fonctionnel === 'Oui' && s.disponible === 'Non') erreurs.push(`Étape 6 · ${s.service} : fonctionnel mais non disponible.`);
    if (s.existence === 'Non' && s.fonctionnel && s.fonctionnel !== 'Non') erreurs.push(`Étape 6 · ${s.service} : déclaré fonctionnel mais inexistant.`);
    if ((s.disponibilite === 'Indisponible' || s.fonctionnel === 'Non') && s.existence !== 'Non' && !s.motifIndisponibilite) {
      avertissements.push(`Étape 6 · ${s.service} : motif d’indisponibilité non précisé.`);
    }
    if (s.dateDebut && s.dateFin && s.dateFin < s.dateDebut) erreurs.push(`Étape 6 · ${s.service} : date de fin avant la date de début.`);
  }
  // Étape 7
  const annees = (f.populations ?? []).map((p) => p.annee);
  if (new Set(annees).size !== annees.length) erreurs.push('Étape 7 · Deux enregistrements de population pour la même année.');
  for (const p of f.populations ?? []) {
    if (p.hommes != null && p.femmes != null && p.totale != null && p.hommes + p.femmes !== p.totale) {
      avertissements.push(`Étape 7 · ${p.annee} : hommes + femmes (${p.hommes + p.femmes}) ≠ population totale (${p.totale}).`);
    }
    if (p.urbaine != null && p.rurale != null && p.totale != null && p.urbaine + p.rurale !== p.totale) {
      avertissements.push(`Étape 7 · ${p.annee} : urbaine + rurale (${p.urbaine + p.rurale}) ≠ population totale (${p.totale}).`);
    }
    const t = p.tranches ?? {};
    if (t.moins1 != null && t.moins5 != null && t.moins1 > t.moins5) erreurs.push(`Étape 7 · ${p.annee} : moins de 1 an > moins de 5 ans.`);
  }
  if (!(f.populations ?? []).length) avertissements.push('Étape 7 · Population desservie non renseignée : les cibles (étape 8) ne peuvent pas être calculées.');
  return { erreurs, avertissements };
}

/** Champs comptés dans la complétude du dossier, [libellé, valeur] (fiche générale + volet spécifique). */
function champsCompletude(e) {
  const f = e.fiche ?? {};
  const id = f.identification ?? {};
  const loc = f.localisation ?? {};
  const org = f.organisation ?? {};
  const infra = f.infrastructures ?? {};
  const cap = f.capacites ?? {};
  const ct = f.contacts ?? {};
  const rat = f.rattachementSanitaire ?? {};
  const op = f.operationnel ?? {};
  const profil = V.profilDe(e);
  return [
    ['Étape 1 · Nom officiel', e.nom], ['Étape 1 · Type de structure', e.type], ['Étape 1 · Code SNIS / DHIS2', id.codeSnis],
    ['Étape 1 · Source du code officiel', id.codeSnisSource], ['Étape 1 · Nom usuel', id.nomUsuel], ['Étape 1 · Sigle', id.sigle],
    ['Étape 1 · Niveau sanitaire', id.niveauSanitaire], ['Étape 1 · Catégorie', id.categorie], ['Étape 1 · Niveau de soins', id.niveauSoins],
    ['Étape 1 · Année de création', id.anneeCreation], ['Étape 1 · Date d’ouverture', id.dateOuverture],
    ['Étape 1 · Acte de création', id.acteCreation?.numero], ['Étape 1 · Statut actuel', id.statutActuel],
    ['Étape 1 · Hospitalisation (Oui / Non)', id.hospitalisation], ['Étape 1 · Maternité (Oui / Non)', id.maternite],
    ['Étape 1 · Chirurgie (Oui / Non)', id.chirurgie], ['Étape 1 · Fonction de référence', id.fonctionReference],
    ['Contacts · Téléphone principal', e.telephone], ['Contacts · E-mail officiel', e.email], ['Contacts · Site web', id.siteWeb],
    ['Contacts · Téléphone d’urgence', ct.telephoneUrgence], ['Contacts · Canal privilégié', ct.canalPrivilegie],
    ['Étape 2 · Coordonnées GPS', e.latitude], ['Étape 2 · Méthode de collecte GPS', loc.gps?.methode],
    ['Étape 2 · Province', e.province], ['Étape 2 · Ville ou territoire', loc.territoire], ['Étape 2 · Commune / secteur / chefferie', loc.commune],
    ['Étape 2 · Zone de santé', e.zoneSante], ['Étape 2 · Aire de santé', e.aireSante],
    ['Étape 2 · Groupement / quartier / village', loc.quartier || loc.groupement],
    ['Étape 2 · Adresse', e.adresse], ['Étape 2 · Repères', loc.reperes], ['Étape 2 · Distance au BCZS', loc.distanceBczsKm],
    ['Étape 2 · Distance à l’HGR', loc.distanceHgrKm], ['Étape 2 · Distance au CSR', loc.distanceCsrKm],
    ['Étape 2 · Temps de déplacement', loc.tempsDeplacement], ['Étape 2 · Moyen de transport', loc.moyenTransport],
    ['Étape 2 · Accessibilité en saison des pluies', loc.accessibilitePluies], ['Étape 2 · Accessibilité en urgence', loc.accessibiliteUrgence],
    ['Étape 3 · Statut juridique', org.statutJuridique], ['Étape 3 · Propriétaire', org.proprietaire], ['Étape 3 · Mode de gestion', org.modeGestion],
    ['Étape 3 · Tutelle administrative', org.tutelleAdministrative], ['Étape 3 · Tutelle technique', org.tutelleTechnique],
    ['Étape 3 · Autorisation (référence)', org.autorisation?.reference], ['Étape 3 · Autorisation (date)', org.autorisation?.date],
    ['Étape 3 · Agrément (numéro)', org.agrement?.numero], ['Étape 3 · Responsable principal', nomPersonne(org.responsable)],
    ['Étape 3 · Titre du responsable', org.titreResponsable], ['Étape 3 · Date de prise de fonction', org.datePriseFonction],
    ['Étape 3 · Responsable médical', org.responsableMedical?.nom], ['Étape 3 · Responsable infirmier', org.responsableInfirmier?.nom],
    ['Étape 3 · Responsable administratif', org.responsableAdministratif?.nom], ['Étape 3 · Responsable maternité', org.responsableMaternite?.nom],
    ['Étape 3 · Jours de fonctionnement', org.joursFonctionnement], ['Étape 3 · Horaires', org.horaires], ['Étape 3 · Garde', org.garde?.disponible],
    ['Responsables fonctionnels', f.responsablesFonctionnels],
    ['Rattachement · Structure de référence', rat.structureReferenceId], ['Rattachement · Programmes / réseaux', rat.programmes],
    ['Étape 4 · Bâtiments', infra.batiments], ['Étape 4 · Lits installés', infra.litsTotal], ['Étape 4 · Lits fonctionnels', infra.litsFonctionnels],
    ['Étape 4 · Bloc opératoire', infra.blocOperatoire], ['Étape 4 · Laboratoire', infra.laboratoire], ['Étape 4 · Pharmacie', infra.pharmacie],
    ['Étape 4 · Point d’eau', infra.pointEau], ['Étape 4 · Électricité', infra.electricite], ['Étape 4 · Chaîne du froid', infra.chaineFroid],
    ['Étape 4 · Connectivité', infra.connectivite?.internet ?? infra.connectivite?.reseauMobile],
    ['Étape 4 · Accessibilité (route)', infra.accessibilite?.route], ['Étape 4 · État du bâtiment', infra.etatBatiment?.etat],
    ['Étape 4 · Équipements', f.equipements],
    ['Étape 5 · Registre du personnel', f.agents], ['Étape 5 · Effectifs par catégorie', f.effectifs],
    ['Étape 6 · Services évalués', (f.services ?? []).filter((s) => s.fonctionnel).length ? true : null],
    ['Étape 7 · Population desservie', f.populations],
    ['Étape 9 · Capacité d’accueil', cap.accueil], ['Étape 9 · Accouchements / mois', cap.accouchementsMois], ['Étape 9 · CPN / mois', cap.cpnMois],
    ['Étape 9 · Séances de vaccination / mois', cap.seancesVaccinationMois], ['Étape 9 · Vaccins', cap.vaccins], ['Étape 9 · Médicaments', cap.medicaments],
    ['Étape 9 · Personnel qualifié', cap.personnelQualifie],
    ['Opérationnel · Fonctionnement 24h/24', op.fonctionnement24h], ['Opérationnel · Moyens de référence', op.moyensReference],
    ['Opérationnel · Système de rapportage', op.systemeRapportage], ['Opérationnel · Date de dernière évaluation', op.dateDerniereEvaluation],
    ...(profil ? V.champsVolet(profil, f[profil]) : []),
  ];
}

/** Complétude du dossier en pourcentage (entier). */
function completude(e) {
  const champs = champsCompletude(e);
  return Math.round((champs.filter(([, v]) => rempli(v)).length / champs.length) * 100);
}

/** Libellés des champs non renseignés (affichés avec le pourcentage de complétude). */
function champsManquants(e) {
  return champsCompletude(e).filter(([, v]) => !rempli(v)).map(([libelle]) => libelle);
}

module.exports = {
  NIVEAUX_SANITAIRES, CATEGORIES, STATUTS_ACTUELS, STATUTS_JURIDIQUES, MODES_GESTION, OUI_NON, OUI_NON_PARTIEL, ACCESSIBILITE,
  DISPONIBILITE, ETATS_EQUIPEMENT, PROFESSIONS, CONTRATS, STATUTS_AGENT, REGIMES, SOURCES_POPULATION, SERVICES_SANITAIRES,
  MODULES, STATUTS_CIRCUIT, SECTEUR_DU_STATUT, CATEGORIE_DU_TYPE, CHAMPS_CHEF, SECTIONS, SECTIONS_LISTE, RESPONSABLES, CONTACTS_CPN,
  NIVEAUX_SOINS, TITRES_RESPONSABLE, DOMAINES_RESPONSABILITE, CANAUX_CONTACT, PROGRAMMES, METHODES_GPS, SOURCES_CODE,
  DISPONIBILITES_SERVICE, MOTIFS_INDISPONIBILITE, ETATS_BATIMENT, STABILITES, CONTINUITES, ROUTES, SOURCES_ELECTRICITE, CATEGORIES_RH,
  CATEGORIES_EQUIPEMENT, PREUVES_EQUIPEMENT, MOYENS_REFERENCE, SYSTEMES_RAPPORTAGE, ETATS_INTRANTS, TYPES_PIECE,
  rempli, nomPersonne, abrege, rattachement, calculsEquipements, calculsRh, calculsEffectifs, modulesActifs, modulesPrevus, servicesPlateforme,
  populationRecente, calculsCibles, calculsCapacites, controler, completude, champsManquants,
  profilDe: V.profilDe,
};
