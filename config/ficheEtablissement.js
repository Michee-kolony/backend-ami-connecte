// Fiche AMI d'un établissement sanitaire : les 10 étapes du cahier des charges (identification,
// localisation, organisation, infrastructures, ressources humaines, services, population, cibles,
// capacités, validation). Référentiels, répartition des champs entre le comité de pilotage
// (obligatoires) et le médecin chef (facultatifs), contrôle automatique et calculs.

const { COEFFICIENTS_INITIAUX } = require('./epidemiologie');

// --- Référentiels ----------------------------------------------------------------------------

const NIVEAUX_SANITAIRES = ['Central', 'Provincial', 'Zone', 'Aire', 'Prestation'];
const CATEGORIES = ['HGR', 'HP', 'HN', 'HM', 'CSR', 'CS', 'PS', 'Polyclinique', 'Clinique', 'CM', 'Autre'];
const STATUTS_ACTUELS = [
  'Fonctionnelle', 'Fonctionnelle limitée', 'Temporairement fermée', 'Définitivement fermée', 'En construction', 'En réhabilitation',
];
const STATUTS_JURIDIQUES = ['Public', 'Privé lucratif', 'Privé non lucratif', 'Confessionnel', 'Militaire', 'Associatif', 'Autre'];
const MODES_GESTION = ['Étatique', 'Confessionnelle', 'Privée', 'Associative', 'Communautaire', 'Autre'];
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
  Clinique: 'Clinique', 'Centre médical': 'CM', Autre: 'Autre',
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
    'commune', 'quartier', 'reperes', 'distanceBczsKm', 'distanceHgrKm', 'distanceCsrKm', 'tempsDeplacement',
    'moyenTransport', 'accessibilitePluies', 'accessibiliteUrgence',
  ],
  organisation: [
    'proprietaire', 'tutelleAdministrative', 'tutelleTechnique', 'responsableMedical', 'responsableInfirmier',
    'responsableAdministratif', 'responsableMaternite', 'joursFonctionnement', 'horaires', 'garde',
  ],
  infrastructures: true,
  equipements: true,
  agents: true,
  effectifsAttendus: true,
  populations: true,
  capacites: true,
};
const SECTIONS = ['identification', 'localisation', 'organisation', 'infrastructures', 'equipements', 'agents', 'effectifsAttendus', 'services', 'populations', 'capacites'];

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
  const lignes = equipements.map((q) => ({ nom: q.nom, total: q.total ?? 0, fonctionnels: q.fonctionnels ?? 0, taux: taux(q.fonctionnels ?? 0, q.total ?? 0) }));
  const total = lignes.reduce((s, l) => s + l.total, 0);
  const fonctionnels = lignes.reduce((s, l) => s + l.fonctionnels, 0);
  return { lignes, total, fonctionnels, taux: taux(fonctionnels, total), aRemplacer: equipements.filter((q) => q.remplacement === 'Oui').length };
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

// --- Étape 6 : activation des modules -----------------------------------------------------------

/**
 * Modules AMI ouverts : null pour un établissement enregistré avant la fiche AMI (aucune
 * restriction), sinon les modules dont le service est fonctionnel, seulement une fois la fiche
 * active (« pas d'activation sans validation »).
 */
function modulesActifs(e) {
  const statut = e.fiche?.circuit?.statut;
  if (!statut) return null;
  if (e.fiche.circuit.anterieur && !e.fiche.circuit.activeLe && statut !== 'Archivée') return null;
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
  return {
    annee: pop?.annee ?? null,
    populationBase: base,
    periode: 'Annuelle et mensuelle',
    dateCalcul: new Date().toISOString().slice(0, 10),
    lignes,
    alerte: 'Ne jamais additionner femmes enceintes et naissances attendues : c’est la même cohorte vue de deux façons.',
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
  // Étape 6
  const services = f.services ?? [];
  if (!services.some((s) => s.fonctionnel === 'Oui' || s.fonctionnel === 'Partiel')) erreurs.push('Étape 6 · Aucun service fonctionnel déclaré.');
  for (const s of services) {
    if (s.fonctionnel && s.fonctionnel !== 'Non' && s.autorise === 'Non') avertissements.push(`Étape 6 · ${s.service} déclaré fonctionnel sans autorisation.`);
    if (s.fonctionnel === 'Oui' && s.disponible === 'Non') erreurs.push(`Étape 6 · ${s.service} : fonctionnel mais non disponible.`);
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

/** Champs comptés dans la complétude du dossier (étapes 1 à 9), avec leur valeur. */
function champsCompletude(e) {
  const f = e.fiche ?? {};
  const id = f.identification ?? {};
  const loc = f.localisation ?? {};
  const org = f.organisation ?? {};
  const infra = f.infrastructures ?? {};
  const cap = f.capacites ?? {};
  return [
    e.nom, e.type, id.codeSnis, id.nomUsuel, id.sigle, id.niveauSanitaire, id.categorie, id.anneeCreation, id.dateOuverture, id.statutActuel,
    e.telephone, e.email, id.siteWeb, e.latitude,
    e.province, loc.territoire, loc.commune, e.zoneSante, e.aireSante, loc.quartier, e.adresse, loc.reperes, loc.distanceBczsKm,
    loc.distanceHgrKm, loc.distanceCsrKm, loc.tempsDeplacement, loc.moyenTransport, loc.accessibilitePluies, loc.accessibiliteUrgence,
    org.statutJuridique, org.proprietaire, org.modeGestion, org.tutelleAdministrative, org.tutelleTechnique, org.autorisation?.reference,
    org.autorisation?.date, org.agrement?.numero, nomPersonne(org.responsable), org.responsableMedical?.nom, org.responsableInfirmier?.nom,
    org.responsableAdministratif?.nom, org.responsableMaternite?.nom, org.joursFonctionnement, org.horaires, org.garde?.disponible,
    infra.batiments, infra.litsTotal, infra.litsFonctionnels, infra.blocOperatoire, infra.laboratoire, infra.pharmacie, infra.pointEau,
    infra.electricite, infra.chaineFroid, f.equipements,
    f.agents,
    (f.services ?? []).filter((s) => s.fonctionnel).length ? true : null,
    f.populations,
    cap.accueil, cap.accouchementsMois, cap.cpnMois, cap.seancesVaccinationMois, cap.vaccins, cap.medicaments, cap.personnelQualifie,
  ];
}

/** Complétude du dossier en pourcentage (entier). */
function completude(e) {
  const champs = champsCompletude(e);
  return Math.round((champs.filter(rempli).length / champs.length) * 100);
}

module.exports = {
  NIVEAUX_SANITAIRES, CATEGORIES, STATUTS_ACTUELS, STATUTS_JURIDIQUES, MODES_GESTION, OUI_NON, OUI_NON_PARTIEL, ACCESSIBILITE,
  DISPONIBILITE, ETATS_EQUIPEMENT, PROFESSIONS, CONTRATS, STATUTS_AGENT, REGIMES, SOURCES_POPULATION, SERVICES_SANITAIRES,
  MODULES, STATUTS_CIRCUIT, SECTEUR_DU_STATUT, CATEGORIE_DU_TYPE, CHAMPS_CHEF, SECTIONS, RESPONSABLES, CONTACTS_CPN,
  rempli, nomPersonne, abrege, rattachement, calculsEquipements, calculsRh, modulesActifs, modulesPrevus, servicesPlateforme,
  populationRecente, calculsCibles, calculsCapacites, controler, completude,
};
